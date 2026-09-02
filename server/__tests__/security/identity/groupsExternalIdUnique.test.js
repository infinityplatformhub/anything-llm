/**
 * S4a (#113): one row per external department, enforced by the database.
 *
 * The S4b reconciler will match departments on `externalId`. Two rows claiming one
 * department give it no correct answer, and picking either silently splits that
 * department's membership — so this is a constraint, not a convention.
 *
 * WHY THIS RUNS AGAINST A POPULATED DATABASE. The contract originally claimed a
 * plain unique would collide on local groups, since they all carry NULL
 * `externalId`, and that a partial or NULLS NOT DISTINCT index was required. That
 * was wrong — Postgres treats NULLs as distinct — and the "fix" for the imagined
 * problem fails at index CREATION on any database already holding two local groups:
 *
 *   ERROR:  could not create unique index
 *   DETAIL: Key ("orgId", source, "externalId")=(1, local, null) is duplicated.
 *
 * An empty test database passes under either index, which is exactly how that
 * mistake would have shipped. So the local rows are inserted BEFORE the assertions,
 * and `migrate deploy` has already run over them.
 */

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const MIGRATION = "20260902120000_groups_external_id_unique";

const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `s4a_idx_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    throw new Error("S4a index tests require DATABASE_URL pointing at PostgreSQL");
  }
  const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${testDb}"`);
  await admin.$disconnect();

  // TL-1 RF-3: the local rows must exist BEFORE this index is created, because the
  // failure mode being guarded against is a CREATE INDEX that fails on data already
  // in the table. Seeding after `migrate deploy` would test the constraint's
  // behaviour but never the migration's — and the migration is the half that runs
  // against a populated production database.
  //
  // `migrate deploy` has no "up to" flag, so the boundary is drawn by COPYING the
  // migrations into a temp directory and deleting this one from the copy.
  //
  // TL-1 F1/F2: an earlier version renamed the real directory aside and restored it
  // in a `finally`. That mutates the working tree for the duration of the run, and
  // a `finally` does not run for SIGKILL / OOM / a killed test process — which would
  // leave the repository missing a migration and a `.migration-parked-*` directory
  // behind, with the next `migrate deploy` recording a shorter history against a dev
  // database. It also raced any other suite touching the same folder when jest is
  // not run with --runInBand. Copying removes both: the working tree is read-only
  // for the whole test, so there is nothing to restore and nothing to race.
  const REAL_MIGRATIONS = path.join(SERVER_DIR, "prisma/migrations");
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), `s4a-mig-${dbSuffix}-`));
  const stagedMigrations = path.join(stageDir, "migrations");
  fs.cpSync(REAL_MIGRATIONS, stagedMigrations, { recursive: true });
  fs.rmSync(path.join(stagedMigrations, MIGRATION), { recursive: true, force: true });
  // Prisma resolves `migrations/` as a sibling of the schema file, so the schema is
  // copied beside the staged directory rather than pointed at across trees.
  const stagedSchema = path.join(stageDir, "schema.prisma");
  fs.copyFileSync(SCHEMA, stagedSchema);

  // NIT-1: the staging directory is cleaned in a `finally`. It lives in os.tmpdir()
  // rather than the repository, so leaking one is untidy rather than dangerous — but
  // a failed `migrate deploy` here would otherwise leave it behind on every run.
  try {
    execSync(`npx prisma migrate deploy --schema ${stagedSchema}`, {
      env: { ...process.env, DATABASE_URL: testUrl },
      cwd: SERVER_DIR,
      stdio: "pipe",
    });
    const seeder = new PrismaClient({ datasources: { db: { url: testUrl } } });
    await seeder.$executeRawUnsafe(
      `INSERT INTO "groups" ("orgId", "name", "source", "externalId")
         VALUES (1, 'pre-existing-local-a', 'local', NULL),
                (1, 'pre-existing-local-b', 'local', NULL)`
    );
    await seeder.$disconnect();
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }

  // Now the index is created over a table that already holds two NULL rows. Under
  // NULLS NOT DISTINCT this step fails outright, which is the mutation.
  execSync(`npx prisma migrate deploy --schema ${SCHEMA}`, {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
}, 300_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60_000);

describe("S4a (#113): groups (orgId, source, externalId) is unique", () => {
  test("the migration applied over PRE-EXISTING local groups, and they survived", async () => {
    // The two rows below were inserted before this migration ran (see beforeAll).
    // Reaching this assertion at all means CREATE INDEX succeeded against a
    // populated table — under NULLS NOT DISTINCT the whole suite dies in beforeAll
    // with "could not create unique index", which is the mutation.
    const preExisting = await prisma.groups.findMany({
      where: { name: { startsWith: "pre-existing-local-" } },
    });
    expect(preExisting).toHaveLength(2);
    expect(preExisting.every((row) => row.externalId === null)).toBe(true);
  });

  test("more local groups with NULL externalId can still be added afterwards", async () => {
    // The constraint's runtime behaviour, as distinct from the migration's: NULLs
    // stay distinct for writes that come later too.
    for (const name of ["local-a", "local-b", "local-c"]) {
      await prisma.groups.create({
        data: { orgId: 1, name: `${name}-${dbSuffix}`, source: "local" },
      });
    }
    const locals = await prisma.groups.findMany({
      where: { source: "local", externalId: null },
    });
    expect(locals.length).toBeGreaterThanOrEqual(5); // 2 pre-existing + 3 new
  });

  test("two rows cannot claim one Lark department", async () => {
    await prisma.groups.create({
      data: {
        orgId: 1,
        name: `dept-one-${dbSuffix}`,
        source: "lark",
        externalId: `od-${dbSuffix}`,
      },
    });

    // Same org, same source, same external id, DIFFERENT name — so `@@unique([orgId,
    // name])`, which already existed, cannot be what refuses this.
    await expect(
      prisma.groups.create({
        data: {
          orgId: 1,
          name: `dept-one-duplicate-${dbSuffix}`,
          source: "lark",
          externalId: `od-${dbSuffix}`,
        },
      })
    ).rejects.toMatchObject({ code: "P2002" });
  });

  test("the same external id under a DIFFERENT source is allowed", async () => {
    // `source` is part of the key on purpose: an LDAP group and a Lark department
    // can legitimately carry the same opaque id string, and they are not the same
    // group. Without this the constraint would be wrong in the other direction.
    const shared = `shared-${dbSuffix}`;
    await prisma.groups.create({
      data: { orgId: 1, name: `ldap-${shared}`, source: "ldap", externalId: shared },
    });
    await expect(
      prisma.groups.create({
        data: { orgId: 1, name: `lark-${shared}`, source: "lark", externalId: shared },
      })
    ).resolves.toMatchObject({ source: "lark" });
  });

  test("the same external id in a DIFFERENT org is allowed", async () => {
    // Tenants are separate. A department id from org 2 must not collide with org 1's.
    const shared = `cross-org-${dbSuffix}`;
    await prisma.groups.create({
      data: { orgId: 1, name: `o1-${shared}`, source: "lark", externalId: shared },
    });
    await expect(
      prisma.groups.create({
        data: { orgId: 2, name: `o2-${shared}`, source: "lark", externalId: shared },
      })
    ).resolves.toMatchObject({ orgId: 2 });
  });
});

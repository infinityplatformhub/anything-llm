/**
 * issue 63 migration 20260902101000, verified on migrations ALONE.
 *
 * QA-1 NIT on #63: every other test of that grant runs `migrate deploy` and then
 * `node prisma/seed.js`, so the seed could be supplying what the migration was
 * supposed to. This suite deliberately never runs the seed — a fresh database
 * that has only ever seen migrations must already carry the grant, because that
 * is what an UPGRADED instance gets. Upgrades do not re-seed.
 *
 * Same shape as ssoIssueRetirement.test.js, and the same reason: what a
 * migration leaves in the database is not the same question as what the
 * application writes at boot.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "g63-migonly-")
  );
process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER || "g63-migonly-api-key-pepper-32-byte";

const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `g63_migonly_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;
// Captured straight after migrate deploy, before any test runs. The idempotency
// test below executes the migration's INSERT again, which would otherwise repair
// the very state a later test is trying to observe -- and that test would then
// pass in a tree with no migration at all, purely because of test order.
let migratedChatReadHolders;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
    throw new Error("issue 63 migration tests require PostgreSQL");
  const root = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await root.$executeRawUnsafe(`CREATE DATABASE "${testDb}"`);
  await root.$disconnect();
  // migrate deploy ONLY. No seed — that is the whole point of this suite.
  execSync(`npx prisma migrate deploy --schema ${SCHEMA}`, {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  process.env.DATABASE_URL = testUrl;
  jest.resetModules();
  prisma = require("../../utils/prisma");
  migratedChatReadHolders = await holdersOf("chat.read");
}, 300_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  process.env.DATABASE_URL = baseDatabaseUrl;
  const root = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await root.$executeRawUnsafe(
    `DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`
  );
  await root.$disconnect();
}, 60_000);

const holdersOf = (action) =>
  prisma.$queryRawUnsafe(
    `SELECT r."name", r."scope"
       FROM "role_permissions" rp
       JOIN "roles" r ON r."id" = rp."role_id"
       JOIN "permissions" p ON p."id" = rp."permission_id"
      WHERE p."action" = $1
      ORDER BY r."scope", r."name"`,
    action
  );

describe("issue 63: migrations alone carry the chat.read grant", () => {
  test("the three workspace roles hold chat.read without any seed run", async () => {
    const holders = migratedChatReadHolders;
    // Exact, not containment: org `member` must NOT be here. An org-scope grant
    // carries workspace_id NULL and the engine reads that as every workspace,
    // which is the leak the first cut of this migration had.
    expect(holders).toEqual([
      { name: "super_admin", scope: "org" },
      { name: "editor", scope: "workspace" },
      { name: "owner", scope: "workspace" },
      { name: "viewer", scope: "workspace" },
    ]);
  });

  test("chat.read_others is untouched by the migration", async () => {
    const holders = await holdersOf("chat.read_others");
    expect(holders).toEqual([
      { name: "content_moderator", scope: "org" },
      { name: "super_admin", scope: "org" },
    ]);
  });

  test("the grant is idempotent — re-running the statement adds nothing", async () => {
    const before = migratedChatReadHolders;
    // The migration's own statement, verbatim. ON CONFLICT DO NOTHING is what
    // makes a re-run (a replayed migration, a manual repair) safe.
    await prisma.$executeRawUnsafe(
      `INSERT INTO "role_permissions" ("role_id", "permission_id")
       SELECT r."id", p."id"
       FROM "roles" r
       JOIN "permissions" p ON p."action" = 'chat.read'
       WHERE r."name" IN ('owner', 'editor', 'viewer')
         AND r."scope" = 'workspace'
       ON CONFLICT DO NOTHING`
    );
    expect(await holdersOf("chat.read")).toEqual(before);
  });

  // NOT TESTED HERE: that migration 101000 bumped policy_versions.
  //
  // It does — the statement is in the migration — but no assertion at this level
  // can tell that bump apart from the several ('grant','org:1') rows the T-1
  // backfill already writes. Both a "some such row exists" check and a "the
  // newest row looks like this" check stay green with 101000 removed entirely,
  // which makes them worse than no test: they would report the bump as verified
  // whether or not it happened.
  //
  // Making it provable would mean giving the bump a distinguishing scope_key,
  // which changes a migration that is already merged. Recorded rather than
  // faked. [→ residual, needs a PMO ruling]

  test("no role_permissions row points at a permission that does not exist", async () => {
    // role_permissions has no ON DELETE CASCADE; an INSERT joined against a
    // missing permission would silently insert nothing at all, and this grant
    // would be absent rather than wrong.
    const orphans = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM "role_permissions" rp
         LEFT JOIN "permissions" p ON p."id" = rp."permission_id"
        WHERE p."id" IS NULL`
    );
    expect(orphans[0].count).toBe(0);
  });

  test("the seed vocabulary and the migrated database agree", async () => {
    // The migration fixes upgraded instances; seeds/permissions.js is what a
    // fresh install gets. They must not drift, or the bug returns for exactly
    // one of the two populations.
    const { SYSTEM_ROLES } = require("../../prisma/seeds/permissions");
    const seeded = SYSTEM_ROLES.filter((role) =>
      role.permissions.includes("chat.read")
    ).map((role) => ({ name: role.name, scope: role.scope }));

    expect(new Set(seeded.map((r) => `${r.name}:${r.scope}`))).toEqual(
      new Set(
        migratedChatReadHolders.map((r) => `${r.name}:${r.scope}`)
      )
    );
  });
});

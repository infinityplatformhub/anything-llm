/**
 * issue 138 (S4b slice 3): `directory.sync`, and who may fire a directory run.
 *
 * A sync run calls `applyDirectoryPlan`, which creates users and groups,
 * rewrites membership, and DEACTIVATES every user absent from the provider
 * snapshot. Lark has no delta API, so absence is the only departure signal
 * (applyDirectoryPlan.js:8-12) — a misconfigured directory app produces a
 * snapshot that is confidently wrong about the organisation, and applying it is
 * a bulk suspend of everyone. So triggering one is its own action, held by
 * super_admin alone.
 *
 * setup_admin is denied deliberately. #137 widened that role into
 * system.write/system.read/user.read so it can finish an installation, and
 * configuring the directory provider is part of that. Letting the same role fire
 * the run is the duty split collapsing (TL-1 38287c1cf).
 *
 * Every decision is asked of the REAL engine. A membership check against
 * `SYSTEM_ROLES` passes with the migration deleted and the engine broken.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "t138-")
  );
process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER || "directory-sync-api-key-pepper-32-bytes-ok";

const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `t138_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

/**
 * Every `policy_versions` row a full `migrate deploy` leaves behind, this
 * migration's included. Pinned rather than checked for existence: eleven earlier
 * migrations write an identical ('grant','org:1') row, so nothing weaker than a
 * count can tell one missing row from eleven present ones.
 *
 * ORDER-DEPENDENT, and that is deliberate. On main today the count before this
 * migration is 11. #137 (20260902140000) adds one and is not merged yet; when it
 * lands ahead of this branch the number here becomes 13, and this test failing is
 * how that gets noticed rather than silently absorbed.
 */
const POLICY_VERSION_ROWS_AFTER_MIGRATIONS = 12;

const SUPER = { id: 8800 + (process.pid % 200) };
const SETUP = { id: 8800 + (process.pid % 200) + 1 };
const MEMBER = { id: 8800 + (process.pid % 200) + 2 };

let prisma;
let engine;

const ORG = { type: "org", id: 1 };

/** A decision from the real engine, for the real seeded role. */
async function decide(userId, action) {
  const { allowed } = await engine.authorize({
    actor: { type: "user", id: String(userId), orgId: 1 },
    action,
    resource: ORG,
  });
  return allowed;
}

async function grant(userId, roleName) {
  const repository = require("../../../utils/authorization/policyRepository");
  const {
    SERVICE_PRINCIPALS,
  } = require("../../../utils/authorization/actorResolver");
  const role = await prisma.roles.findFirstOrThrow({
    where: { name: roleName, scope: "org" },
  });
  await repository.grantRole({
    actor: SERVICE_PRINCIPALS.singleUser,
    principalType: "user",
    principalId: String(userId),
    roleId: role.id,
    db: prisma,
  });
}

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    throw new Error("issue 138 tests require DATABASE_URL on PostgreSQL");
  }
  const admin = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${testDb}"`);
  await admin.$disconnect();
  execSync(`npx prisma migrate deploy --schema ${SCHEMA}`, {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  execSync(`node prisma/seed.js`, {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  process.env.DATABASE_URL = testUrl;

  // utils/prisma binds DATABASE_URL at first require and a sibling suite in the
  // same --runInBand process may already hold it against the shared database.
  // Without this reset every write lands there and the reads still pass, because
  // they only read back what they wrote.
  jest.resetModules();
  prisma = require("../../../utils/prisma");
  const {
    DatabaseAuthorizationEngine,
  } = require("../../../utils/authorization/engine");
  engine = new DatabaseAuthorizationEngine();

  await prisma.users.create({
    data: { id: SUPER.id, username: `d138-su-${dbSuffix}`, password: "unused" },
  });
  await prisma.users.create({
    data: { id: SETUP.id, username: `d138-sa-${dbSuffix}`, password: "unused" },
  });
  await prisma.users.create({
    data: { id: MEMBER.id, username: `d138-me-${dbSuffix}`, password: "unused" },
  });
  await grant(SUPER.id, "super_admin");
  await grant(SETUP.id, "setup_admin");
  await grant(MEMBER.id, "member");
}, 300_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  process.env.DATABASE_URL = baseDatabaseUrl;
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const admin = new PrismaClient({
      datasources: { db: { url: baseDatabaseUrl } },
    });
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`
    );
    await admin.$disconnect();
  }
}, 120_000);

describe("A: who may fire a directory sync", () => {
  test("super_admin is ALLOWED, and setup_admin is DENIED", async () => {
    // Both halves in ONE test, deliberately. "setup_admin is denied" on its own
    // is satisfied by an action that exists in no role at all — which is exactly
    // bug #63 (chat.read seeded, granted to nobody, four routes dead) and what
    // QA-3 asks for here: a wrong actor signature returns missing_actor for
    // every question, so a deny-only assertion passes for the wrong reason.
    expect(await decide(SUPER.id, "directory.sync")).toBe(true);
    expect(await decide(SETUP.id, "directory.sync")).toBe(false);
  });

  test("an ordinary member is denied", async () => {
    expect(await decide(MEMBER.id, "directory.sync")).toBe(false);
  });

  test("NON-VACUITY: the same actors answer as expected on OTHER actions", async () => {
    // If `decide` were broken — a resolver failure, a wrong actor shape — every
    // assertion above would be satisfied by a blanket false, and the super_admin
    // half by a blanket true. This pins both directions on actions #138 does not
    // touch.
    expect(await decide(SETUP.id, "settings.write")).toBe(true);
    expect(await decide(MEMBER.id, "chat.send")).toBe(true);
    expect(await decide(MEMBER.id, "settings.write")).toBe(false);
  });
});

describe("B: the seed carries the action", () => {
  const {
    ALL_ACTIONS,
    DIRECTORY_ACTIONS,
    SYSTEM_ROLES,
  } = require("../../../prisma/seeds/permissions");

  test("directory.sync is in ALL_ACTIONS", () => {
    // super_admin's permission list IS ALL_ACTIONS, so an action missing here is
    // an action a FRESH INSTALL grants to nobody while a MIGRATED one grants to
    // super_admin — the two deployment shapes silently disagreeing. That defect
    // shipped once already in #137 with `audit.purge`.
    expect(ALL_ACTIONS).toContain("directory.sync");
    expect(DIRECTORY_ACTIONS).toEqual(["directory.sync"]);
  });

  test("HOLDER assertion: super_admin's seeded set contains it, setup_admin's does not", () => {
    // Not the literal list — the ROLE. Omitting the action from ALL_ACTIONS while
    // leaving DIRECTORY_ACTIONS intact would pass a literal check and still leave
    // super_admin without it (QA-3 mutant G-h).
    const roleFor = (name) =>
      SYSTEM_ROLES.find((r) => r.name === name && r.scope === "org").permissions;
    expect(roleFor("super_admin")).toContain("directory.sync");
    expect(roleFor("setup_admin")).not.toContain("directory.sync");
    expect(roleFor("member")).not.toContain("directory.sync");
  });
});

// The migrate-only database lives at MODULE scope, not inside describe C.
// Describe D compares the seed-only path against it, and a client created and
// disconnected inside C would already be closed by then — the comparison would
// throw rather than fail, which reads as a broken test instead of a real answer.
const migOnlyDb = `t138_mig_${dbSuffix}`;
let migClient;

beforeAll(async () => {
  const migUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${migOnlyDb}$1`);
  const admin = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${migOnlyDb}"`);
  await admin.$disconnect();
  execSync(`npx prisma migrate deploy --schema ${SCHEMA}`, {
    env: { ...process.env, DATABASE_URL: migUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  migClient = new PrismaClient({ datasources: { db: { url: migUrl } } });
}, 300_000);

afterAll(async () => {
  if (migClient) await migClient.$disconnect();
  const admin = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await admin.$executeRawUnsafe(
    `DROP DATABASE IF EXISTS "${migOnlyDb}" WITH (FORCE)`
  );
  await admin.$disconnect();
}, 120_000);

const migratedPermissionRows = (select) =>
  migClient.permissions.findMany({ select });

describe("C: the migration stands on its own", () => {
  // Everything above runs on a database built by `migrate deploy` AND `seed.js`.
  // The seed writes the same grant, so it MASKS the migration completely —
  // measured in #137, where two mutants that emptied the migration left the
  // suite green. The migrate-ONLY database above is also the upgrade path a real
  // deployment takes: existing installs run migrations, they do not re-run seed.

  async function actionsOf(roleName) {
    const role = await migClient.roles.findFirstOrThrow({
      where: { name: roleName, scope: "org" },
      include: { role_permissions: { include: { permissions: true } } },
    });
    return role.role_permissions.map((rp) => rp.permissions.action);
  }

  test("the permission row exists, with category and scope set", async () => {
    // The engine answers false both for an action that does not exist and for
    // one that exists and is ungranted; describe A cannot tell those apart.
    const row = await migClient.permissions.findUnique({
      where: { action: "directory.sync" },
    });
    expect(row).not.toBeNull();
    // TL-1: the columns a bare ("action","description") INSERT would leave at
    // their defaults. `category` drifting is cosmetic-looking and is not: the
    // seed derives it from the action prefix, so a migrated install and a fresh
    // one would hold different rows for the same action. `scope` is the
    // load-bearing one — at the default 'any' the engine ANSWERS "may this
    // caller sync THIS workspace" instead of refusing it, and an org-wide grant
    // reads as every workspace.
    expect(row.category).toBe("directory");
    expect(row.scope).toBe("org");
  });

  test("migrations ALONE grant it to super_admin and withhold it from setup_admin", async () => {
    const superActions = await actionsOf("super_admin");
    // Non-vacuous: an empty list would satisfy the `not.toContain` below.
    expect(superActions.length).toBeGreaterThan(5);
    expect(superActions).toContain("directory.sync");
    expect(await actionsOf("setup_admin")).not.toContain("directory.sync");
  });

  test("the migration bumps the policy version", async () => {
    // FilterCache.get reads currentPolicyVersion on every call, so without this
    // row a RUNNING process serves pre-grant decisions until its TTL expires:
    // the grant works on a fresh boot and not on a live instance.
    //
    // PINNED count, not `> 0`. Eleven earlier migrations write an identical
    // ('grant','org:1') row, so an existence check passes with this migration's
    // INSERT deleted.
    const all = await migClient.policy_versions.findMany();
    expect(all.length).toBe(POLICY_VERSION_ROWS_AFTER_MIGRATIONS);
    const mine = all[all.length - 1];
    expect(mine.change_type).toBe("grant");
    expect(mine.scope_key).toBe("org:1");
  });

  test("re-running the migration is idempotent", async () => {
    // Both INSERTs carry ON CONFLICT DO NOTHING; the policy_versions bump does
    // not, and must not — a second application is a second cache-invalidation
    // event. So the row counts that must NOT move are the permission and the
    // grant.
    const sql = require("fs").readFileSync(
      path.join(
        SERVER_DIR,
        "prisma/migrations/20260902150000_directory_sync_permission/migration.sql"
      ),
      "utf8"
    );
    const countPermission = () =>
      migClient.permissions.count({ where: { action: "directory.sync" } });
    const countGrants = async () =>
      (await actionsOf("super_admin")).filter((a) => a === "directory.sync")
        .length;

    expect(await countPermission()).toBe(1);
    expect(await countGrants()).toBe(1);

    // Comments are stripped BEFORE splitting on ";". Splitting first and
    // filtering comment-only chunks afterwards is what the first cut did, and it
    // fails on any `;` inside a comment — the fragments either side become
    // statements. This test is here to exercise the migration, so a bug in how
    // it is replayed must not read as a migration defect.
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      await migClient.$executeRawUnsafe(statement);
    }

    expect(await countPermission()).toBe(1);
    expect(await countGrants()).toBe(1);
  });

  test("the migrated vocabulary IS the seed's ALL_ACTIONS, both directions", async () => {
    // #137's F-1 defect, generalised: a permission the migration creates and the
    // seed never lists means a fresh install and a migrated one hold different
    // vocabularies, and super_admin (whose set IS ALL_ACTIONS) misses the new
    // action on fresh installs. Set equality in BOTH directions — one side
    // catches a migration the seed forgot, the other a seed entry no migration
    // creates.
    const { ALL_ACTIONS } = require("../../../prisma/seeds/permissions");
    // Actions a later migration DELETED: absent from both sides. Duplicated from
    // t1-authz-migration.test.js rather than imported, because it is exported
    // from nowhere; if a future migration retires another action, both copies
    // need it and this failing is how you find out.
    const RETIRED_BY_LATER_MIGRATIONS = ["sso.issue"];
    const retired = new Set(RETIRED_BY_LATER_MIGRATIONS);
    const rows = await migClient.permissions.findMany({
      select: { action: true },
    });
    const migrated = new Set(
      rows.map((r) => r.action).filter((a) => !retired.has(a))
    );
    const seeded = new Set(ALL_ACTIONS.filter((a) => !retired.has(a)));

    expect([...migrated].filter((a) => !seeded.has(a)).sort()).toEqual([]);
    expect([...seeded].filter((a) => !migrated.has(a)).sort()).toEqual([]);
  });

  test("C-c: no permission row is left with an empty category", async () => {
    // A column-wide sweep, not an assertion about this action. `category` has a
    // '' default, so any migration that inserts without it leaves a row the seed
    // would have filled — and nothing else in the suite looks at the column
    // across the whole table.
    const rows = await migClient.permissions.findMany({
      select: { action: true, category: true },
    });
    expect(rows.filter((r) => r.category === "")).toEqual([]);
    expect(rows.length).toBeGreaterThan(50);
  });

  test("the migrated CATEGORY and SCOPE match what the seed would write", async () => {
    // TL-1: the action-name comparison above is blind to a whole class of
    // column defect — a migration that creates the right action with the wrong
    // category or scope passes it. Both columns are compared for EVERY action,
    // not just this one, because the defect is per-migration and any of them can
    // carry it.
    const {
      ALL_ACTIONS,
      ACTION_SCOPES,
    } = require("../../../prisma/seeds/permissions");
    // seed.js:30-34 — category is derived from the action prefix, scope from
    // ACTION_SCOPES with 'any' as the column default.
    const cat = (a) => a.split(".")[0].replace(/-(.)/g, (_, c) => c.toUpperCase());
    const RETIRED_BY_LATER_MIGRATIONS = new Set(["sso.issue"]);

    const rows = await migClient.permissions.findMany({
      select: { action: true, category: true, scope: true },
    });
    const mismatches = rows
      .filter((r) => !RETIRED_BY_LATER_MIGRATIONS.has(r.action))
      .filter((r) => ALL_ACTIONS.includes(r.action))
      .filter(
        (r) =>
          r.category !== cat(r.action) ||
          r.scope !== (ACTION_SCOPES[r.action] ?? "any")
      )
      .map((r) => ({
        action: r.action,
        migrated: { category: r.category, scope: r.scope },
        seedWouldWrite: {
          category: cat(r.action),
          scope: ACTION_SCOPES[r.action] ?? "any",
        },
      }));
    // Named in the failure output rather than counted: a bare count tells you
    // something drifted and not which column on which action.
    expect(mismatches).toEqual([]);
    // Non-vacuous: an empty table would satisfy the equality above.
    expect(rows.length).toBeGreaterThan(50);
  });
});

describe("D: the SEED path writes the same columns as the migration", () => {
  // C-a (QA-3). Describe C builds its database with migrations only; the suite's
  // main database uses migrate + seed. NEITHER exercises the seed ALONE, which is
  // what `prisma db push` + `node prisma/seed.js` produces — the dev-reset path.
  //
  // That gap hid a real defect, and not one this issue introduced: `seed.js`
  // wrote `category` and NOT `scope`, so on a seed-only database every action
  // came out scope 'any', INCLUDING `org.member`, whose entire purpose is that
  // the engine refuses it against a workspace resource. Migrated installs got the
  // right value from migration 102000, so the two deployment shapes disagreed and
  // only the migrated one was ever asserted. Measured on both paths before and
  // after the fix.
  const seedOnlyDb = `t138_seed_${dbSuffix}`;
  let seedUrl;
  let seedClient;

  beforeAll(async () => {
    seedUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${seedOnlyDb}$1`);
    const admin = new PrismaClient({
      datasources: { db: { url: baseDatabaseUrl } },
    });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${seedOnlyDb}"`);
    await admin.$disconnect();
    // `db push` builds the schema WITHOUT running any migration, which is the
    // whole point: nothing but seed.js may write these rows here.
    execSync(
      `npx prisma db push --schema ${SCHEMA} --skip-generate --accept-data-loss`,
      { env: { ...process.env, DATABASE_URL: seedUrl }, cwd: SERVER_DIR, stdio: "pipe" }
    );
    execSync(`node prisma/seed.js`, {
      env: { ...process.env, DATABASE_URL: seedUrl },
      cwd: SERVER_DIR,
      stdio: "pipe",
    });
    seedClient = new PrismaClient({ datasources: { db: { url: seedUrl } } });
  }, 300_000);

  afterAll(async () => {
    if (seedClient) await seedClient.$disconnect();
    const admin = new PrismaClient({
      datasources: { db: { url: baseDatabaseUrl } },
    });
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${seedOnlyDb}" WITH (FORCE)`
    );
    await admin.$disconnect();
  }, 120_000);

  test("the seed ALONE writes directory.sync with category and scope", async () => {
    const row = await seedClient.permissions.findUnique({
      where: { action: "directory.sync" },
    });
    expect(row).not.toBeNull();
    expect(row.category).toBe("directory");
    expect(row.scope).toBe("org");
  });

  test("the seed ALONE gets org.member's scope right too", async () => {
    // The pre-existing half of the defect. Asserted here so that fixing seed.js
    // for #138's action cannot regress the one action that already depended on
    // it.
    const row = await seedClient.permissions.findUnique({
      where: { action: "org.member" },
    });
    expect(row.scope).toBe("org");
  });

  test("seed and migration produce the same (action, category, scope) tuples", async () => {
    // The cross-check the two describes cannot do alone: each proves its own
    // path is self-consistent, and only comparing them catches a fix applied to
    // one and not the other (C-b).
    const shape = (rows) =>
      rows
        .map((r) => `${r.action}|${r.category}|${r.scope}`)
        .sort();
    const select = { action: true, category: true, scope: true };
    const seeded = await seedClient.permissions.findMany({ select });
    const migrated = await migratedPermissionRows(select);
    expect(shape(seeded)).toEqual(shape(migrated));
    expect(seeded.length).toBeGreaterThan(50);
  });

  test("C-c: the seed leaves no empty category either", async () => {
    const rows = await seedClient.permissions.findMany({
      select: { action: true, category: true },
    });
    expect(rows.filter((r) => r.category === "")).toEqual([]);
  });
});

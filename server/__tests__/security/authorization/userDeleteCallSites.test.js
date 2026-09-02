/**
 * #135 — the three user-deletion call sites route through `offboardUser`.
 *
 * The finding this closes, measured by Dev3: `principal_id` is a String with no
 * relation to `users` in all three authorization tables, and the engine matches on
 * `String(grantPrincipal.id)`. Delete a user, let the id be reused, and the new
 * account inherits the old one's grants. `scripts/sqlite-to-pg-import.js:102` calls
 * `setval`, so id reuse is a real shipped path rather than a thought experiment.
 *
 * SCOPE, per TL-1 (5f051a2a8, 71a9cbbdd): #135 adds no cleanup logic. `offboardUser`
 * already exists in `policyRepository`; this is three call sites learning to call it.
 * A diff that grows a second implementation is the failure the scoping prevents.
 *
 * Written RED before the call sites are changed.
 */

const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const testDb = `i135_callsites_${crypto.randomBytes(4).toString("hex")}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;
let repository;
let SERVICE_PRINCIPALS;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
    throw new Error("#135 integration tests require DATABASE_URL on PostgreSQL");
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
  jest.resetModules();
  prisma = require("../../../utils/prisma");
  repository = require("../../../utils/authorization/policyRepository");
  SERVICE_PRINCIPALS = require("../../../utils/authorization/principals").SERVICE_PRINCIPALS;
}, 180000);

afterAll(async () => {
  await prisma?.$disconnect();
  const admin = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
  await admin.$disconnect();
}, 60000);

const SETUP = () => SERVICE_PRINCIPALS.singleUser;
let seq = 0;

/**
 * A user holding authority three ways: an org role grant, a document ACL row, and a
 * group membership.
 *
 * All three, because cleanup that removes one and leaves another reads as full
 * coverage — and because the ACL and membership halves are defence in depth (QA-2
 * measured that allow-ACLs are inert for USER principals today: documentFilter.js:96
 * reads deny rows only). Their assertions are therefore on ROWS, not on engine
 * answers; see RF-1.
 */
async function victimWithEverything(label) {
  const tag = `i135-${label}-${seq++}`;
  const user = await prisma.users.create({
    data: {
      username: `${tag}@example.com`,
      password: bcrypt.hashSync("Pw123456!", 10),
      role: "default",
    },
  });
  const member = await prisma.roles.findFirstOrThrow({
    where: { name: "member", scope: "org" },
  });
  await repository.grantRole({
    actor: SETUP(),
    principalType: "user",
    principalId: String(user.id),
    roleId: member.id,
    db: prisma,
  });
  const document = await prisma.documents.create({
    data: { filename: tag, dedupe_key: tag, orgId: 1 },
  });
  await repository.grantDocumentAcl({
    actor: SETUP(),
    documentId: document.id,
    principalType: "user",
    principalId: String(user.id),
    action: "document.read",
    db: prisma,
  });
  const group = await prisma.groups.create({
    data: { orgId: 1, name: tag, source: "lark", externalId: `od-${tag}` },
  });
  await repository.addGroupMember({
    actor: SETUP(),
    groupId: group.id,
    userId: user.id,
    db: prisma,
  });
  return { user, document, group, roleId: member.id };
}

const authzRows = async (userId) => ({
  grants: await prisma.principal_role_grants.count({
    where: { principal_type: "user", principal_id: String(userId) },
  }),
  acls: await prisma.document_acl.count({
    where: { principal_type: "user", principal_id: String(userId) },
  }),
  memberships: await prisma.group_members.count({
    where: { user_id: Number(userId) },
  }),
});

/**
 * Force the next users row onto `id`, the way sqlite-to-pg-import.js:102 does.
 *
 * `is_called = false` rather than setting the value one lower: a sequence cannot hold
 * 0, so `setval(seq, id - 1, true)` fails outright when the victim is id 1. With
 * `false`, the next nextval() returns `id` itself.
 */
async function recycleIdTo(id) {
  await prisma.$executeRawUnsafe(
    `SELECT setval(pg_get_serial_sequence('users','id'), ${Number(id)}, false)`
  );
}

describe("#135 RF-1: a recycled id inherits nothing", () => {
  test("the successor lands on the victim's id and holds neither the role nor the ACL row", async () => {
    const { user, roleId } = await victimWithEverything("recycle");
    const victimId = user.id;

    await repository.offboardUser({
      actor: SETUP(),
      userId: victimId,
      db: prisma,
    });
    await prisma.users.delete({ where: { id: victimId } });
    await recycleIdTo(victimId);

    const successor = await prisma.users.create({
      data: {
        username: `i135-successor-${seq++}@example.com`,
        password: bcrypt.hashSync("Pw123456!", 10),
        role: "default",
      },
    });
    // Without this the successor may simply not land on the victim's id, and every
    // assertion below passes whatever the cleanup did. Dev3's recon names the trap.
    expect(successor.id).toBe(victimId);

    // Role half — asked of the ENGINE, which is where a live grant would be honoured.
    const {
      DatabaseAuthorizationEngine,
    } = require("../../../utils/authorization/engine");
    const engine = new DatabaseAuthorizationEngine({ db: prisma });
    const decision = await engine.authorize({
      actor: { type: "user", id: String(successor.id), orgId: 1 },
      action: "workspace.create",
      resource: { type: "org", id: "1", orgId: 1, workspaceId: null },
    });
    expect(decision.allowed).toBe(false);

    // ACL half — asserted on the ROW, not on an engine answer. QA-2 measured that an
    // allow-ACL grants a user actor nothing today (documentFilter.js:96 is deny-only),
    // so an engine assertion here would be green before the fix AND after: a test that
    // cannot fail. The row count is the only thing that separates the two states.
    expect(
      await prisma.document_acl.count({
        where: { principal_type: "user", principal_id: String(successor.id) },
      })
    ).toBe(0);
  }, 120000);

  test("CONTROL: a genuinely granted user IS allowed", async () => {
    // An engine that denies everything satisfies the assertion above for free.
    const { user } = await victimWithEverything("control");
    const superAdmin = await prisma.roles.findFirstOrThrow({
      where: { name: "super_admin", scope: "org" },
    });
    await repository.grantRole({
      actor: SETUP(),
      principalType: "user",
      principalId: String(user.id),
      roleId: superAdmin.id,
      db: prisma,
    });

    const {
      DatabaseAuthorizationEngine,
    } = require("../../../utils/authorization/engine");
    const engine = new DatabaseAuthorizationEngine({ db: prisma });
    const decision = await engine.authorize({
      actor: { type: "user", id: String(user.id), orgId: 1 },
      action: "workspace.create",
      resource: { type: "org", id: "1", orgId: 1, workspaceId: null },
    });
    expect(decision.allowed).toBe(true);
  }, 120000);
});

describe("#135 RF-P5: the cleanup lives in the ROUTES, not in User.delete", () => {
  test("User.delete called directly leaves the authorization rows behind", async () => {
    // QA-2's model-layer discriminator, and TL-1 made it a ruling: if the cleanup
    // moves into User.delete, this test becomes impossible to write while every
    // route-level RF stays green either way. It is the assertion that pins WHERE the
    // cleanup lives — and the one a future refactor trips.
    //
    // `User.delete` takes a CLAUSE, not an id (models/user.js:456), so a model-layer
    // cleanup would have to invent an actor for callers that have none — the free pass
    // every gateway entry point here declines to give.
    const { user } = await victimWithEverything("model-layer");
    const { User } = require("../../../models/user");

    await User.delete({ id: user.id });

    const rows = await authzRows(user.id);
    // Grants and ACLs are `principal_id` TEXT with NO foreign key, which is the whole
    // orphan surface: nothing in the database removes them when the user row goes.
    expect(rows.grants).toBeGreaterThan(0);
    expect(rows.acls).toBeGreaterThan(0);
    // `group_members`, by contrast, HAS a real FK — `users ... onDelete: Cascade`
    // (schema.prisma) — so PostgreSQL deletes it for us and it is 0 here. Asserted as
    // zero rather than left out, so that a future migration dropping that cascade
    // fails this test instead of quietly adding a third orphan class.
    expect(rows.memberships).toBe(0);
  }, 120000);
});

describe("#135 RF-2: the bump reaches a LIVE FilterCache", () => {
  test("access is gone through the SAME cache instance that served it", async () => {
    // A fresh FilterCache rebuilds from the database anyway, so a test that news up a
    // second cache is green under a mutation that removes the rows WITHOUT bumping the
    // version. Pattern from security/identity/groupMembershipPolicyVersion.test.js.
    //
    // Assertions from Dev5's inventory; driven through offboardUser directly rather
    // than over HTTP, because his harness booted the real app per suite and the reds
    // were hook timeouts rather than assertion failures.
    const { user } = await victimWithEverything("cache");
    const workspace = await prisma.workspaces.create({
      data: { name: `i135-cache-${seq}`, slug: `i135-cache-${seq++}` },
    });
    const viewer = await prisma.roles.findFirstOrThrow({
      where: { name: "viewer", scope: "workspace" },
    });
    await repository.grantRole({
      actor: SETUP(),
      principalType: "user",
      principalId: String(user.id),
      roleId: viewer.id,
      workspaceId: workspace.id,
      db: prisma,
    });

    const {
      FilterCache,
    } = require("../../../utils/authorization/cache");
    const {
      buildDocumentFilter,
    } = require("../../../utils/authorization/documentFilter");
    const cache = new FilterCache({ db: prisma });
    const actor = {
      type: "user",
      id: String(user.id),
      orgId: 1,
      workspaceIds: [workspace.id],
    };
    const build = () =>
      cache.get({ actor, action: "document.read", db: prisma }, () =>
        buildDocumentFilter({ actor, action: "document.read", db: prisma })
      );

    const before = await build();
    expect(before.workspaceIds ?? []).toContain(String(workspace.id));

    await repository.offboardUser({
      actor: SETUP(),
      userId: user.id,
      db: prisma,
    });

    const after = await build();
    expect(after.workspaceIds ?? []).not.toContain(String(workspace.id));
  }, 120000);
});

describe("#135 RF-3: revocations survive and name what was taken", () => {
  test("one revocation row per grant removed, with matching role ids and revoker", async () => {
    // The paired leaves-X-alone assertion: every "the grants are gone" check stays
    // green under a mutation that truncates by principal_id across all three tables,
    // which would destroy the only record the person ever held anything.
    const { user } = await victimWithEverything("revocations");
    const before = await prisma.principal_role_grants.findMany({
      where: { principal_type: "user", principal_id: String(user.id) },
      select: { role_id: true },
    });
    expect(before.length).toBeGreaterThan(0);

    const actor = SETUP();
    await repository.offboardUser({ actor, userId: user.id, db: prisma });

    const revocations = await prisma.grant_revocations.findMany({
      where: { principal_type: "user", principal_id: String(user.id) },
      select: {
        role_id: true,
        role_name: true,
        revoked_by_id: true,
        revoked_by_type: true,
      },
    });
    expect(revocations).toHaveLength(before.length);
    // The ROLE IDS match — a count alone passes for rows naming the wrong roles.
    expect(revocations.map((r) => r.role_id).sort()).toEqual(
      before.map((g) => g.role_id).sort()
    );
    // ...and every row names a real role and the actor who revoked it, so the audit
    // trail says who did this rather than merely that it happened.
    for (const row of revocations) {
      expect(row.role_name).toBeTruthy();
      expect(row.revoked_by_id).toBe(String(actor.id));
      // TL-2: the TYPE too — an id alone does not say which principal namespace it
      // belongs to, and "7" as a user is a different principal from "7" as a service.
      expect(row.revoked_by_type).toBe(actor.type);
    }
    expect(
      await prisma.principal_role_grants.count({
        where: { principal_type: "user", principal_id: String(user.id) },
      })
    ).toBe(0);
  }, 120000);
});

/**
 * S12 slice 2 (#136): `offboardUser` in the policy repository.
 *
 * Slice 1 revoked the user's KEYS and stopped their session. It deliberately did
 * not claim to revoke their ACCESS: the grants and document ACLs stayed, safe
 * only because `actorResolver` returns null for a suspended user before any of
 * them is read. This is the slice that removes them.
 *
 * WHAT THESE TESTS REFUSE TO DO. Asserting "a policy_versions row exists" is
 * green against a bump nobody listens to — the row can carry a scope key no cache
 * entry has, and every stale filter keeps serving. Cache entries scope to
 * `org:<id>` and `workspace:<id>` only (`cache.js` `scopesFor`). So the first
 * fixture drives a REAL `FilterCache` instance and requires the access to be gone
 * through it, exactly as S4a RF-5 does for membership.
 *
 * Written RED before `offboardUser` exists.
 */

const { execSync } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `s12_offboard_repo_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
    throw new Error("S12 slice 2 requires DATABASE_URL pointing at PostgreSQL");
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
  prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
}, 300_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const admin = new PrismaClient({
      datasources: { db: { url: baseDatabaseUrl } },
    });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60_000);

const repository = require("../../../utils/authorization/policyRepository");
const {
  SERVICE_PRINCIPALS,
} = require("../../../utils/authorization/principals");
const { FilterCache } = require("../../../utils/authorization/cache");
const {
  buildDocumentFilter,
} = require("../../../utils/authorization/documentFilter");

// PLACEHOLDER ACTOR — TL-2's ruling on the #135 actor shape is pending. Every
// call below goes through this one binding, so when the shape is settled it
// changes in one place rather than in nine.
const ACTOR = SERVICE_PRINCIPALS.singleUser;

let seq = 0;
/**
 * A user who holds access three different ways: a group membership carrying a
 * workspace grant, a direct org grant, and a document ACL.
 */
async function world(label) {
  const tag = `${label}-${seq++}-${dbSuffix}`;
  const workspace = await prisma.workspaces.create({
    data: { name: `ws-${tag}`, slug: `s12-${tag}` },
  });
  const user = await prisma.users.create({
    data: { username: `${tag}@example.com`, password: "x", role: "default" },
  });
  const group = await prisma.groups.create({
    data: { orgId: 1, name: tag, source: "lark", externalId: `od-${tag}` },
  });
  await repository.addGroupMember({
    actor: ACTOR,
    groupId: group.id,
    userId: user.id,
    db: prisma,
  });

  const viewer = await prisma.roles.findFirstOrThrow({
    where: { name: "viewer", scope: "workspace" },
  });
  await repository.grantRole({
    actor: ACTOR,
    principalType: "group",
    principalId: String(group.id),
    roleId: viewer.id,
    workspaceId: workspace.id,
    db: prisma,
  });
  // ...and a grant naming the USER directly, which is what the offboard has to
  // revoke rather than merely un-group.
  const member = await prisma.roles.findFirstOrThrow({
    where: { name: "member", scope: "org" },
  });
  await repository.grantRole({
    actor: ACTOR,
    principalType: "user",
    principalId: String(user.id),
    roleId: member.id,
    db: prisma,
  });

  const document = await prisma.documents.create({
    data: { filename: tag, dedupe_key: tag, orgId: 1 },
  });
  await repository.grantDocumentAcl({
    actor: ACTOR,
    documentId: document.id,
    principalType: "user",
    principalId: String(user.id),
    action: "document.read",
    db: prisma,
  });

  const actor = {
    type: "user",
    id: String(user.id),
    orgId: 1,
    workspaceIds: [workspace.id],
  };
  return { workspace, user, group, document, actor };
}

const buildThrough = (cache, actor) =>
  cache.get({ actor, action: "document.read", db: prisma }, () =>
    buildDocumentFilter({ actor, action: "document.read", db: prisma })
  );

const offboard = (user) =>
  repository.offboardUser({ actor: ACTOR, userId: user.id, db: prisma });

describe("S12 slice 2: offboardUser", () => {
  test("F1: the user's cached filter is invalidated, through a LIVE FilterCache", async () => {
    // The assertion that a bump nobody listens to cannot pass. Build a filter
    // (populating the cache), offboard, then build again through the SAME
    // instance and require the access to be gone. A version written under a
    // scope key no entry carries leaves the stale filter serving.
    const { user, workspace, actor } = await world("cache");
    const cache = new FilterCache({ db: prisma });

    const before = await buildThrough(cache, actor);
    expect(before.workspaceIds ?? []).toContain(String(workspace.id));
    expect(cache.size).toBe(1);

    await offboard(user);

    const after = await buildThrough(cache, actor);
    expect(after.workspaceIds ?? []).not.toContain(String(workspace.id));
  });

  test("F2: exactly ONE policy_versions row for N removals", async () => {
    // Every repository function bumps its own version, so composing them
    // naively writes one row per removal — N cache flushes for one offboarding,
    // each publishing under `org:1` and dropping every entry in the instance.
    // One user, one policy change.
    const { user } = await world("one-bump");
    const before = await prisma.policy_versions.count();

    await offboard(user);

    expect(await prisma.policy_versions.count()).toBe(before + 1);
  });

  test("F3: a revocation row per revoked grant", async () => {
    // `grant_revocations` is the audit record #135 rulings require: which grant
    // was taken away, from whom. Deleting the grant row without writing one
    // leaves no evidence the access ever existed.
    const { user } = await world("revocations");
    const grantsBefore = await prisma.principal_role_grants.count({
      where: { principal_type: "user", principal_id: String(user.id) },
    });
    expect(grantsBefore).toBeGreaterThan(0);
    const revocationsBefore = await prisma.grant_revocations.count({
      where: { principal_type: "user", principal_id: String(user.id) },
    });

    await offboard(user);

    expect(
      await prisma.principal_role_grants.count({
        where: { principal_type: "user", principal_id: String(user.id) },
      })
    ).toBe(0);
    expect(
      await prisma.grant_revocations.count({
        where: { principal_type: "user", principal_id: String(user.id) },
      })
    ).toBe(revocationsBefore + grantsBefore);
  });

  test("F4: the principal's document_acl rows are gone", async () => {
    // The residual slice 1 declared and did not close. Safe today only because
    // `actorResolver` refuses a suspended user before any ACL is read — which
    // stops being true the moment anything answers an ACL question without the
    // resolver.
    const { user, document } = await world("acl");
    expect(
      await prisma.document_acl.count({
        where: { principal_type: "user", principal_id: String(user.id) },
      })
    ).toBeGreaterThan(0);

    await offboard(user);

    expect(
      await prisma.document_acl.count({
        where: { principal_type: "user", principal_id: String(user.id) },
      })
    ).toBe(0);
    // and the document itself survives — this removes access, not content
    expect(
      await prisma.documents.findUnique({ where: { id: document.id } })
    ).not.toBeNull();
  });

  test("F5: CONTROL — another user's grants, ACL and membership are untouched", async () => {
    // Without this, an `offboardUser` that deletes every grant in the org passes
    // F3 and F4 completely.
    const victim = await world("victim");
    const bystander = await world("bystander");

    await offboard(victim.user);

    expect(
      await prisma.principal_role_grants.count({
        where: {
          principal_type: "user",
          principal_id: String(bystander.user.id),
        },
      })
    ).toBeGreaterThan(0);
    expect(
      await prisma.document_acl.count({
        where: {
          principal_type: "user",
          principal_id: String(bystander.user.id),
        },
      })
    ).toBeGreaterThan(0);
    expect(
      await prisma.group_members.count({
        where: { user_id: bystander.user.id },
      })
    ).toBe(1);

    // ...and the bystander's cached filter still serves
    const cache = new FilterCache({ db: prisma });
    const filter = await buildThrough(cache, bystander.actor);
    expect(filter.workspaceIds ?? []).toContain(String(bystander.workspace.id));
  });

  test("F6: group membership goes through removeGroupMember, not a raw delete", async () => {
    // `removeGroupMember` collects the workspace scope keys from the membership
    // row before deleting it, so the bump reaches the workspace entries the user
    // held through that group. A `prisma.group_members.deleteMany` skips that
    // and publishes under `org:1` alone — which invalidates everything and
    // records nothing about which workspaces were affected.
    const { user, group } = await world("membership");
    expect(
      await prisma.group_members.count({ where: { user_id: user.id } })
    ).toBe(1);

    await offboard(user);

    expect(
      await prisma.group_members.count({ where: { user_id: user.id } })
    ).toBe(0);
    // the group itself survives
    expect(
      await prisma.groups.findUnique({ where: { id: group.id } })
    ).not.toBeNull();
  });
});

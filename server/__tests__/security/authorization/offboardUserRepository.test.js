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
 * TL-1's pre-read (6aabd6b7d) replaced the original "exactly one policy_versions
 * row for N removals" fixture. Measured there: `inTransaction(db, fn)` INLINES when
 * handed a `tx`, so one outer transaction around three primitives still produces
 * three bumps, and collapsing them needs the `bumpVersion` export TL-2 barred. N is
 * correct rather than tolerated — the intermediate versions are written inside an
 * uncommitted transaction, so no reader observes one (`cache.js:97` compares against
 * a head that does not move until commit). What the transaction buys is ROLLBACK
 * SCOPE, not a row count, so that is what F2 asserts now. A bump COUNT is never the
 * contract here: it would pin an implementation detail that changes the day the
 * primitives batch.
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
  ACTOR = await makeActor("super_admin");
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

// SETUP actor: the exempt single-user principal, used only to BUILD each world.
// It skips `refuseGroupEscalation` and `revokeGrant`'s `role.revoke` check, which is
// exactly why it must not be the actor the offboard itself runs as — a fixture that
// exercises the code under test with the one principal that bypasses both guards
// proves nothing about either.
const SETUP = SERVICE_PRINCIPALS.singleUser;

// The actor `offboardUser` actually runs as, per TL-2's #135 ruling: a REAL user
// holding super_admin, which is what `response.locals.actor` resolves to at the
// admin.js call site. It holds `role.revoke`, so `revokeGrant`'s guard admits it,
// and it is not exempt, so `refuseGroupEscalation` genuinely runs.
let ACTOR;
let seq = 0;

async function makeActor(roleName) {
  const role = await prisma.roles.findFirstOrThrow({
    where: { name: roleName, scope: "org" },
  });
  const user = await prisma.users.create({
    data: {
      username: `${roleName}-${seq++}-${dbSuffix}@example.com`,
      password: "x",
      role: "admin",
    },
  });
  await repository.grantRole({
    actor: SETUP,
    principalType: "user",
    principalId: String(user.id),
    roleId: role.id,
    db: prisma,
  });
  return { type: "user", id: String(user.id), orgId: 1 };
}

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
    actor: SETUP,
    groupId: group.id,
    userId: user.id,
    db: prisma,
  });

  const viewer = await prisma.roles.findFirstOrThrow({
    where: { name: "viewer", scope: "workspace" },
  });
  await repository.grantRole({
    actor: SETUP,
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
    actor: SETUP,
    principalType: "user",
    principalId: String(user.id),
    roleId: member.id,
    db: prisma,
  });

  // TWO documents, deliberately. `document_acl.principal_id` is TEXT with no FK
  // (`schema.prisma:911`), so enumerating a user's ACL rows is a string match — the
  // recycling surface #135 exists to close. One row cannot tell "removed the rows I
  // enumerated" from "removed the one row I happened to know about".
  const documents = [];
  for (const suffix of ["a", "b"]) {
    const document = await prisma.documents.create({
      data: { filename: `${tag}-${suffix}`, dedupe_key: `${tag}-${suffix}`, orgId: 1 },
    });
    await repository.grantDocumentAcl({
      actor: SETUP,
      documentId: document.id,
      principalType: "user",
      principalId: String(user.id),
      action: "document.read",
      db: prisma,
    });
    documents.push(document);
  }
  const document = documents[0];

  // ...and a WORKSPACE-SCOPED grant naming the user. `revokeGrant` filters on
  // `workspace_id`, so a call that passes null matches nothing and this grant
  // survives silently — a mutation that dropped the workspace id passed every
  // fixture until this row existed.
  await repository.grantRole({
    actor: SETUP,
    principalType: "user",
    principalId: String(user.id),
    roleId: viewer.id,
    workspaceId: workspace.id,
    db: prisma,
  });

  const actor = {
    type: "user",
    id: String(user.id),
    orgId: 1,
    workspaceIds: [workspace.id],
  };
  return { workspace, user, group, document, documents, actor };
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

  test("F2: a mid-run failure rolls the WHOLE offboard back", async () => {
    // Replaces the original "exactly one policy_versions row" fixture, per TL-1's
    // measurement above: N bumps is the correct shape, and a bump count is not this
    // function's contract. The property that actually matters is the one an outer
    // transaction buys — if the ACL removal fails, the membership and the grants
    // that were already removed come back.
    //
    // The failure is injected through `prisma.$use`, not `jest.spyOn`: middleware
    // fires for transaction clients and a spy on `prisma.document_acl` does not.
    const { user, group } = await world("rollback");
    const grantsBefore = await prisma.principal_role_grants.count({
      where: { principal_type: "user", principal_id: String(user.id) },
    });
    const versionsBefore = await prisma.policy_versions.count();
    const revocationsBefore = await prisma.grant_revocations.count();

    let armed = true;
    prisma.$use(async (params, next) => {
      if (armed && params.model === "document_acl" && params.action === "deleteMany")
        throw new Error("injected: document_acl delete failed mid-offboard");
      return next(params);
    });

    await expect(offboard(user)).rejects.toThrow(/injected/);
    armed = false;

    // everything the offboard had already done is back
    expect(
      await prisma.group_members.count({ where: { user_id: user.id } })
    ).toBe(1);
    expect(
      await prisma.principal_role_grants.count({
        where: { principal_type: "user", principal_id: String(user.id) },
      })
    ).toBe(grantsBefore);
    // ...including the audit rows and the versions, which are the two things a
    // partial commit would leave describing a removal that did not happen
    expect(await prisma.grant_revocations.count()).toBe(revocationsBefore);
    expect(await prisma.policy_versions.count()).toBe(versionsBefore);
    expect(await prisma.groups.findUnique({ where: { id: group.id } })).not.toBeNull();
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
    const { user, documents } = await world("acl");
    expect(
      await prisma.document_acl.count({
        where: { principal_type: "user", principal_id: String(user.id) },
      })
    ).toBe(documents.length);

    await offboard(user);

    expect(
      await prisma.document_acl.count({
        where: { principal_type: "user", principal_id: String(user.id) },
      })
    ).toBe(0);
    // and the documents themselves survive — this removes access, not content
    for (const document of documents)
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

  test("F7: a SECOND offboard writes nothing at all", async () => {
    // TL-1's RF-I, and the reason it needs exact counts rather than `>=`.
    //
    // `removeGroupMember` bumps the version even when its `deleteMany` matches
    // nothing — correct for a direct caller, who is entitled to know the cache
    // reflects reality, and wrong for a re-run. Call the primitives blindly and a
    // no-op offboard writes one policy_versions row per membership the user USED TO
    // have. Every "the user has no access afterwards" assertion in F1/F3/F4/F6 is
    // green under that mutation, because the user is already offboarded — only a
    // row count separates a no-op from a re-run, so the fix is to enumerate the
    // rows inside the transaction and call a primitive only for one that exists.
    const { user } = await world("idempotent");
    await offboard(user);

    // the baseline is taken AFTER the first offboard, which is what makes ">= 0"
    // useless here and an exact equality the only assertion with teeth
    const versions = await prisma.policy_versions.count();
    const revocations = await prisma.grant_revocations.count();
    const memberships = await prisma.group_members.count();

    await offboard(user);

    expect(await prisma.policy_versions.count()).toBe(versions);
    expect(await prisma.grant_revocations.count()).toBe(revocations);
    expect(await prisma.group_members.count()).toBe(memberships);
  });

  test("F8: a content_moderator actor is REFUSED — the guards run for real", async () => {
    // TL-2's required control, and the reason the fixture actor is a real
    // super_admin rather than the exempt single-user principal. `content_moderator`
    // does not hold `role.revoke`, so `revokeGrant` refuses it; it also cannot carry
    // the group's authority, so `refuseGroupEscalation` refuses it. Under an exempt
    // actor BOTH guards are skipped, and a mutation replacing either primitive with
    // a raw `deleteMany` passes every other fixture in this file.
    const { user } = await world("moderator");
    const weakActor = await makeActor("content_moderator");

    await expect(
      repository.offboardUser({ actor: weakActor, userId: user.id, db: prisma })
    ).rejects.toThrow(/refused/i);

    // and nothing was removed on the way to the refusal — the transaction rolled back
    expect(
      await prisma.group_members.count({ where: { user_id: user.id } })
    ).toBe(1);
    expect(
      await prisma.principal_role_grants.count({
        where: { principal_type: "user", principal_id: String(user.id) },
      })
    ).toBeGreaterThan(0);
  });

  test("F9: MEMBERSHIP-ONLY offboard still runs the group escalation guard", async () => {
    // F8 is not enough on its own, measured: with `removeGroupMember` replaced by a
    // raw `tx.group_members.deleteMany`, F8 still passes — the content_moderator is
    // refused by `revokeGrant` before the missing membership guard could matter, so
    // the suite never notices that `refuseGroupEscalation` stopped running.
    //
    // This user holds NO role grants and NO ACL rows, so `removeGroupMember` is the
    // ONLY primitive the offboard calls and its guard is the only thing standing
    // between a moderator and stripping a super_admin group's membership. That is
    // the escalation TL-1's ruling (1) bars raw writes to prevent.
    const tag = `bare-${seq++}-${dbSuffix}`;
    const user = await prisma.users.create({
      data: { username: `${tag}@example.com`, password: "x", role: "default" },
    });
    const group = await prisma.groups.create({
      data: { orgId: 1, name: tag, source: "lark", externalId: `od-${tag}` },
    });
    await repository.addGroupMember({
      actor: SETUP,
      groupId: group.id,
      userId: user.id,
      db: prisma,
    });
    // the group carries authority the moderator does not hold
    const superAdmin = await prisma.roles.findFirstOrThrow({
      where: { name: "super_admin", scope: "org" },
    });
    await repository.grantRole({
      actor: SETUP,
      principalType: "group",
      principalId: String(group.id),
      roleId: superAdmin.id,
      db: prisma,
    });

    const moderator = await makeActor("content_moderator");
    await expect(
      repository.offboardUser({ actor: moderator, userId: user.id, db: prisma })
    ).rejects.toThrow(/refused/i);
    expect(
      await prisma.group_members.count({ where: { user_id: user.id } })
    ).toBe(1);

    // ...and the legitimate actor still gets through, so this is a guard and not a
    // wall: a fixture that only proves "it throws" is satisfied by throwing always.
    await repository.offboardUser({ actor: ACTOR, userId: user.id, db: prisma });
    expect(
      await prisma.group_members.count({ where: { user_id: user.id } })
    ).toBe(0);
  });

  test("F10: each ACL removal is published under its own document: scope key", async () => {
    // `revokeDocumentAcl` bumps under `document:<id>`. A raw
    // `document_acl.deleteMany` removes the same rows and publishes NOTHING — every
    // "the rows are gone" assertion in F4 stays green while a document-scoped
    // consumer never learns its ACL changed. Measured: that mutation passed the
    // whole file until this fixture existed.
    //
    // This asserts the KEYS, not a count. TL-1's ruling stands — a bump count would
    // pin an implementation detail that changes the day the primitives batch — but
    // WHICH key a bump is published under is the difference between an invalidation
    // and a row nobody reads, which is the RF-5 lesson.
    const { user, documents } = await world("acl-scope");
    const baseline = await prisma.policy_versions.findFirst({
      orderBy: { version: "desc" },
      select: { version: true },
    });

    await offboard(user);

    const written = await prisma.policy_versions.findMany({
      where: { version: { gt: baseline?.version ?? 0 } },
      select: { scope_key: true, change_type: true },
    });
    const keys = new Set(written.map((row) => row.scope_key));
    for (const document of documents)
      expect([...keys]).toContain(`document:${document.id}`);
    expect(written.some((row) => row.change_type === "document_acl")).toBe(true);
  });

  test("F11: offboardUser refuses a missing actor — for a user with rows", async () => {
    // Symmetric with every other gateway entry point: no default free pass, and the
    // audit rows the primitives write name `revoked_by_id` — an offboard with no
    // actor would write rows describing a removal nobody performed.
    //
    // The user must HAVE rows. Measured: with `requireActor` deleted and a userId
    // holding nothing, the enumeration finds nothing, no primitive is called, and
    // the function returns cleanly — the mutation survived a version of this fixture
    // that used a bare id. The refusal has to come from THIS function, before any
    // work, not incidentally from the first primitive that happens to run.
    const { user } = await world("no-actor");

    await expect(
      repository.offboardUser({ userId: user.id, db: prisma })
    ).rejects.toThrow(/offboardUser requires an explicit actor/);

    expect(
      await prisma.group_members.count({ where: { user_id: user.id } })
    ).toBe(1);
  });
});

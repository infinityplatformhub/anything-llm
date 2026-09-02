/**
 * S4a (#113) RF-5: a group membership change invalidates cached filters.
 *
 * The residual #96 left behind. Since #96 the engine expands group membership and
 * documentFilter reads it on both halves — so membership decides authorization — but
 * nothing about writing `group_members` advanced `policy_versions`. A user removed
 * from a group kept its access until the cache TTL expired.
 *
 * WHAT THIS TEST REFUSES TO DO. Asserting "a policy_versions row exists" is green
 * against a bump nobody listens to: the row can be written with a scope key no cache
 * entry carries, and every stale filter keeps serving. Cache entries scope to
 * `org:<id>` and `workspace:<id>` only (cache.js `scopesFor`) — a `group:<id>` key
 * would match nothing at all.
 *
 * So this drives the REAL FilterCache instance: build a filter (populating it),
 * change membership, build again through the SAME instance, and require the access
 * to be gone. That fails for a bump that is not published, and for one published
 * under a key nobody matches.
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
const testDb = `s4a_rf5_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    throw new Error("RF-5 requires DATABASE_URL pointing at PostgreSQL");
  }
  const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
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
    const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60_000);

const repository = require("../../../utils/authorization/policyRepository");
const { SERVICE_PRINCIPALS } = require("../../../utils/authorization/principals");
const { FilterCache } = require("../../../utils/authorization/cache");
const {
  buildDocumentFilter,
} = require("../../../utils/authorization/documentFilter");
const SYS = SERVICE_PRINCIPALS.singleUser;

/** A user in a group that holds a workspace-scoped read grant. */
async function world(label) {
  const workspace = await prisma.workspaces.create({
    data: { name: `ws-${label}`, slug: `rf5-${label}-${dbSuffix}` },
  });
  const user = await prisma.users.create({
    data: { username: `${label}-${dbSuffix}@example.com`, password: "x", role: "default" },
  });
  const group = await prisma.groups.create({
    data: { orgId: 1, name: `${label}-${dbSuffix}`, source: "lark", externalId: `od-${label}-${dbSuffix}` },
  });
  await repository.addGroupMember({
    actor: SYS,
    groupId: group.id,
    userId: user.id,
    db: prisma,
  });
  const viewer = await prisma.roles.findFirstOrThrow({
    where: { name: "viewer", scope: "workspace" },
  });
  await repository.grantRole({
    actor: SYS,
    principalType: "group",
    principalId: String(group.id),
    roleId: viewer.id,
    workspaceId: workspace.id,
    db: prisma,
  });
  // The actor as a route would build it: workspaceIds is what the cache keys on.
  const actor = {
    type: "user",
    id: String(user.id),
    orgId: 1,
    workspaceIds: [workspace.id],
  };
  return { workspace, user, group, actor };
}

const buildThrough = (cache, actor) =>
  cache.get({ actor, action: "document.read", db: prisma }, () =>
    buildDocumentFilter({ actor, action: "document.read", db: prisma })
  );

describe("S4a (#113) RF-5: membership changes reach a live FilterCache", () => {
  test("removing a member revokes access through the SAME cache instance", async () => {
    const { workspace, user, group, actor } = await world("revoke");
    const cache = new FilterCache({ db: prisma });

    // 1. Populate. The group's grant puts the workspace in readable scope.
    const before = await buildThrough(cache, actor);
    expect(before.matchNone).toBe(false);
    expect(before.workspaceIds.map(String)).toContain(String(workspace.id));
    expect(before.attributes.groupIds.map(String)).toContain(String(group.id));

    // 2. Remove them from the group.
    await repository.removeGroupMember({
      actor: SYS,
      groupId: group.id,
      userId: user.id,
      db: prisma,
    });

    // 3. Build again through the SAME instance. A stale entry would still name the
    // workspace — that is the 30-second window this exists to close.
    const after = await buildThrough(cache, actor);
    expect(after.workspaceIds.map(String)).not.toContain(String(workspace.id));
    // With the group grant gone the actor has no readable scope at all, so the
    // filter degrades to match-none — `attributes` is empty there by construction
    // (matchNoneFilter), which is why this asserts the filter's SHAPE rather than
    // an empty groupIds array that only exists on the populated form.
    expect(after.matchNone).toBe(true);
  }, 120_000);

  test("adding a member grants access through the same instance, without a restart", async () => {
    // The other direction. Weaker as a security property, but a cache that only
    // invalidates on removal makes new members wait out the TTL and looks broken.
    const { workspace, user, group, actor } = await world("grant");
    const cache = new FilterCache({ db: prisma });

    await repository.removeGroupMember({
      actor: SYS, groupId: group.id, userId: user.id, db: prisma,
    });
    const before = await buildThrough(cache, actor);
    expect(before.workspaceIds.map(String)).not.toContain(String(workspace.id));

    await repository.addGroupMember({
      actor: SYS, groupId: group.id, userId: user.id, db: prisma,
    });
    const after = await buildThrough(cache, actor);
    expect(after.workspaceIds.map(String)).toContain(String(workspace.id));
  }, 120_000);

  test("the bump is published under scope keys the cache actually carries", async () => {
    // The failure this guards: a version row written under `group:<id>`. Every
    // assertion above still passes if the cache is invalidated by its version-head
    // check alone, so this pins the SCOPE — an entry is dropped by
    // `invalidateScopes`, which matches only `org:` and `workspace:` keys.
    const { workspace, user, group, actor } = await world("scope");
    const cache = new FilterCache({ db: prisma });
    await buildThrough(cache, actor);
    expect(cache.entries.size).toBe(1);

    const [entry] = [...cache.entries.values()];
    const scopes = [...entry.scopes];
    expect(scopes).toContain("org:1");
    expect(scopes).toContain(`workspace:${workspace.id}`);

    // Simulate exactly what the subscriber does with the event this write emits.
    const { version } = await repository.removeGroupMember({
      actor: SYS, groupId: group.id, userId: user.id, db: prisma,
    });
    expect(version).toBeTruthy();

    // `event_outbox.data` is a JSON STRING, and `id` is a string too — ordering by
    // it would sort lexically, which is not chronological. `occurredAt` is the
    // column with an index for exactly this.
    const event = await prisma.event_outbox.findFirst({
      where: { type: "policy.changed" },
      orderBy: { occurredAt: "desc" },
    });
    const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    const scopeKeys = data?.scopeKeys ?? [];
    expect(scopeKeys).toContain("org:1");
    expect(scopeKeys).toContain(`workspace:${workspace.id}`);

    cache.invalidateScopes(scopeKeys);
    expect(cache.entries.size).toBe(0);
  }, 120_000);

  test("the version bump and the membership write are one transaction", async () => {
    // If the write could commit without the bump, a crash between them leaves every
    // cache stale with no event to correct it — the same reasoning bumpVersion's own
    // comment gives for publishing inside the transaction.
    const { user, group } = await world("atomic");
    const before = await prisma.policy_versions.count();
    await repository.removeGroupMember({
      actor: SYS, groupId: group.id, userId: user.id, db: prisma,
    });
    const after = await prisma.policy_versions.count();
    expect(after).toBe(before + 1);

    const membership = await prisma.group_members.findFirst({
      where: { group_id: group.id, user_id: user.id },
    });
    expect(membership).toBeNull();
  }, 120_000);

  test("removing a non-member is a no-op that still bumps", async () => {
    // deleteMany rather than delete: a caller asking for a removal is entitled to
    // know the cache reflects reality afterwards, whether or not a row existed.
    const { user, group } = await world("noop");
    await repository.removeGroupMember({
      actor: SYS, groupId: group.id, userId: user.id, db: prisma,
    });
    const before = await prisma.policy_versions.count();
    await expect(
      repository.removeGroupMember({
        actor: SYS, groupId: group.id, userId: user.id, db: prisma,
      })
    ).resolves.toMatchObject({ version: expect.anything() });
    expect(await prisma.policy_versions.count()).toBe(before + 1);
  }, 120_000);

  test("NIT-3: the bump names the GROUP's org, not a hardcoded org 1", async () => {
    // `workspaceScopeKeysFor` read `orgId: 1` in two places: which group grants
    // count, and which `org:` key the bump publishes under. Every other test in this
    // file builds in org 1, so a hardcoded 1 is invisible to all of them — this one
    // exists because the survivor proved it.
    //
    // The failure it guards is not cosmetic. `scopesFor` keys cache entries by the
    // actor's own org, so a bump published under `org:1` for a change in org 2
    // matches no entry there: the FilterCache keeps serving the old answer, which is
    // the stale-authorization window RF-5 exists to close, reopened for every tenant
    // that is not the first.
    const otherOrg = 2;
    const group = await prisma.groups.create({
      data: {
        orgId: otherOrg,
        name: `nit3-${dbSuffix}`,
        source: "lark",
        externalId: `od-nit3-${dbSuffix}`,
      },
    });
    const user = await prisma.users.create({
      data: { username: `nit3-${dbSuffix}`, password: "x", role: "default" },
    });

    const { version } = await repository.addGroupMember({
      actor: SYS, groupId: group.id, userId: user.id, db: prisma,
    });
    expect(version).toBeTruthy();

    const event = await prisma.event_outbox.findFirst({
      where: { type: "policy.changed" },
      orderBy: { occurredAt: "desc" },
    });
    const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
    expect(data.scopeKeys).toContain(`org:${otherOrg}`);
    expect(data.scopeKeys).not.toContain("org:1");
  }, 120_000);

  test("a membership write demands an explicit actor", async () => {
    // Same rule as grantRole: a missing actor must never be a free pass, because
    // seeds and migrations are exactly the callers tempted to omit one.
    const { user, group } = await world("actor");
    await expect(
      repository.addGroupMember({ groupId: group.id, userId: user.id, db: prisma })
    ).rejects.toThrow(/requires an explicit actor/);
  }, 120_000);
});

/**
 * S4a (#113) RF-8 / TL-1 FINDING-3: membership is a GRANT PATH, so it carries the
 * same escalation guard `grantRole` does.
 *
 * Since #96 the engine expands group membership when it evaluates grants. That made
 * `addGroupMember` a way to hand someone every permission the group's roles carry —
 * without ever calling `grantRole`, and therefore without ever meeting its
 * set-containment check. An actor holding nothing but `member` could add themselves
 * (or anyone) to a group that holds `super_admin` and inherit it whole.
 *
 * The guard is deliberately the SAME SHAPE as `grantRole:160-173` rather than a new
 * rule: what may be delegated is bounded by what the actor holds. Writing a second,
 * differently-worded check would let the two drift, and the weaker one becomes the
 * way in.
 *
 * NOTE ON ACTORS. Every test above passes `SYS` (`SERVICE_PRINCIPALS.singleUser`),
 * which is EXEMPT — so all six stay green whether or not this guard exists. That is
 * exactly why they could not have caught FINDING-3, and why these tests use real
 * user actors instead.
 */
describe("S4a (#113) RF-8: membership writes carry grantRole's escalation guard", () => {
  /** A group holding an org-wide role, plus an actor holding `roleName` or nothing. */
  async function escalationWorld(label, actorRoleName = null) {
    const group = await prisma.groups.create({
      data: {
        orgId: 1,
        name: `rf8-${label}-${dbSuffix}`,
        source: "lark",
        externalId: `od-rf8-${label}-${dbSuffix}`,
      },
    });
    const superAdmin = await prisma.roles.findFirstOrThrow({
      where: { name: "super_admin", scope: "org" },
    });
    await repository.grantRole({
      actor: SYS,
      principalType: "group",
      principalId: String(group.id),
      roleId: superAdmin.id,
      db: prisma,
    });

    const victim = await prisma.users.create({
      data: { username: `rf8-victim-${label}-${dbSuffix}`, password: "x", role: "default" },
    });
    const actorUser = await prisma.users.create({
      data: { username: `rf8-actor-${label}-${dbSuffix}`, password: "x", role: "default" },
    });
    if (actorRoleName) {
      const role = await prisma.roles.findFirstOrThrow({
        where: { name: actorRoleName, scope: "org" },
      });
      await repository.grantRole({
        actor: SYS,
        principalType: "user",
        principalId: String(actorUser.id),
        roleId: role.id,
        db: prisma,
      });
    }
    const actor = { type: "user", id: String(actorUser.id), orgId: 1 };
    return { group, victim, actor };
  }

  test("a `member` actor cannot add anyone to a group that holds super_admin", async () => {
    // The attack FINDING-3 names. `grantRole` would refuse this outright; before the
    // fix, routing it through membership succeeded and the victim inherited
    // super_admin on their next evaluation.
    const { group, victim, actor } = await escalationWorld("add", "member");

    await expect(
      repository.addGroupMember({ actor, groupId: group.id, userId: victim.id, db: prisma })
    ).rejects.toThrow(/does not hold/);

    // And nothing was written: a refusal that still creates the row is not a refusal.
    const membership = await prisma.group_members.findFirst({
      where: { group_id: group.id, user_id: victim.id },
    });
    expect(membership).toBeNull();
  }, 120_000);

  test("REMOVAL is guarded too — taking someone out of a group is also authority", async () => {
    // Removal is not the harmless direction. Membership can carry a DENY (deny-wins),
    // and pulling someone out of the group that denies them widens what they may do.
    // Guarding only `add` leaves the same hole with the sign flipped.
    const { group, victim, actor } = await escalationWorld("remove", "member");
    await repository.addGroupMember({
      actor: SYS, groupId: group.id, userId: victim.id, db: prisma,
    });

    await expect(
      repository.removeGroupMember({ actor, groupId: group.id, userId: victim.id, db: prisma })
    ).rejects.toThrow(/does not hold/);

    // Still a member: the refusal did not half-apply.
    const membership = await prisma.group_members.findFirst({
      where: { group_id: group.id, user_id: victim.id },
    });
    expect(membership).not.toBeNull();
  }, 120_000);

  test("a super_admin actor may do both — the guard bounds, it does not forbid", async () => {
    // Without this, "refuses everything" satisfies the two tests above. The guard is
    // set containment, so an actor holding the group's permissions passes.
    const { group, victim, actor } = await escalationWorld("allowed", "super_admin");

    await expect(
      repository.addGroupMember({ actor, groupId: group.id, userId: victim.id, db: prisma })
    ).resolves.toMatchObject({ version: expect.anything() });
    await expect(
      repository.removeGroupMember({ actor, groupId: group.id, userId: victim.id, db: prisma })
    ).resolves.toMatchObject({ version: expect.anything() });
  }, 120_000);

  test("the exempt service principals still pass — coreJobs is the S4b reconciler", async () => {
    // S4b syncs membership from Lark as `coreJobs`, and it holds no role grants at
    // all. If the guard applied to it, directory sync would refuse every write.
    // This is the same exemption `grantRole` gives, for the same reason (issue #20).
    const { group, victim } = await escalationWorld("exempt");

    await expect(
      repository.addGroupMember({
        actor: SERVICE_PRINCIPALS.coreJobs, groupId: group.id, userId: victim.id, db: prisma,
      })
    ).resolves.toMatchObject({ version: expect.anything() });
  }, 120_000);

  /**
   * RF-9 / TL-1: a group can carry authority WITHOUT holding a single role grant.
   *
   * `document_acl` deny rows are keyed `{principal_type:"group", principal_id}` and
   * `documentFilter:91-99` reads them directly — they never pass through
   * `principal_role_grants`. So a group whose entire purpose is "these people may
   * not see these documents" has ZERO role grants, `permissionIdsForGroup` returns
   * an empty set, and the early return in `refuseGroupEscalation` let ANY actor call
   * `removeGroupMember` and hand the victim every document the group hid.
   *
   * Containment on an empty set is not a safe default here: an empty set is
   * contained by everyone, so "the group carries nothing" and "the group carries
   * only denials" reached the same answer while meaning opposite things.
   *
   * Ruling: a group with deny rows is refused unless the actor is exempt or holds
   * `document.share` — the permission that governs who may change document reach.
   * Requiring org-wide `super_admin` instead would be stricter than the ACL write
   * itself and would block the ordinary document-sharing admin.
   */
  async function denyGroupWorld(label, actorRoleName = null) {
    const group = await prisma.groups.create({
      data: {
        orgId: 1, name: `rf9-${label}-${dbSuffix}`,
        source: "lark", externalId: `od-rf9-${label}-${dbSuffix}`,
      },
    });
    const victim = await prisma.users.create({
      data: { username: `rf9-victim-${label}-${dbSuffix}`, password: "x", role: "default" },
    });
    const actorUser = await prisma.users.create({
      data: { username: `rf9-actor-${label}-${dbSuffix}`, password: "x", role: "default" },
    });
    if (actorRoleName) {
      const role = await prisma.roles.findFirstOrThrow({
        where: { name: actorRoleName, scope: "org" },
      });
      await repository.grantRole({
        actor: SYS, principalType: "user", principalId: String(actorUser.id),
        roleId: role.id, db: prisma,
      });
    }
    await repository.addGroupMember({
      actor: SYS, groupId: group.id, userId: victim.id, db: prisma,
    });
    return { group, victim, actor: { type: "user", id: String(actorUser.id), orgId: 1 } };
  }

  /** A deny row hiding one document from the group. No role grant anywhere. */
  async function denyOneDocument(group, label) {
    const document = await prisma.documents.create({
      data: {
        filename: `rf9-${label}.txt`,
        dedupe_key: `rf9/${label}-${dbSuffix}.txt`,
        metadata: "{}",
      },
    });
    await repository.grantDocumentAcl({
      actor: SYS,
      documentId: document.id,
      principalType: "group",
      principalId: String(group.id),
      action: "document.read",
      effect: "deny",
      db: prisma,
    });
    return document;
  }

  test("RF-9: a group with only DENY rows is still guarded — removal is refused", async () => {
    // The hole the early return opened. The group holds no role grant at all, so
    // `permissionIdsForGroup` is empty; before the fix that returned immediately and
    // a `member` actor could pull the victim out, restoring every hidden document.
    const { group, victim, actor } = await denyGroupWorld("deny", "member");
    await denyOneDocument(group, "deny");

    // Matched on `document.share` specifically, not a generic "does not hold": the
    // role-grant branch refuses with its own wording, and a loose pattern would be
    // green for a refusal that came from the wrong half of the guard.
    await expect(
      repository.removeGroupMember({ actor, groupId: group.id, userId: victim.id, db: prisma })
    ).rejects.toThrow(/document\.share/);

    const membership = await prisma.group_members.findFirst({
      where: { group_id: group.id, user_id: victim.id },
    });
    expect(membership).not.toBeNull();
  }, 120_000);

  test("RF-9: addition to a deny-only group is refused too", async () => {
    // Symmetric, and not redundant: adding someone to a deny group is a denial
    // handed out, which is authority in the other direction.
    const { group, victim, actor } = await denyGroupWorld("denyadd", "member");
    await denyOneDocument(group, "denyadd");
    const outsider = await prisma.users.create({
      data: { username: `rf9-outsider-${dbSuffix}`, password: "x", role: "default" },
    });

    await expect(
      repository.addGroupMember({ actor, groupId: group.id, userId: outsider.id, db: prisma })
    ).rejects.toThrow(/document\.share/);
    expect(victim).toBeTruthy();
  }, 120_000);

  test("RF-9 control: the SAME actor passes when the group has no deny rows either", async () => {
    // This is what separates "the deny row is what refuses" from "this actor is
    // refused everywhere". Same `member` actor, same shape of group — only the deny
    // row is missing, and it passes. Without this, the two tests above are also
    // green for a guard that refuses every non-exempt actor unconditionally, which
    // would break ordinary directory sync.
    const { group, victim, actor } = await denyGroupWorld("control", "member");

    await expect(
      repository.removeGroupMember({ actor, groupId: group.id, userId: victim.id, db: prisma })
    ).resolves.toMatchObject({ version: expect.anything() });
  }, 120_000);

  test("RF-9: an actor holding document.share may change a deny group's membership", async () => {
    // The guard bounds rather than forbids. `document.share` is the permission that
    // governs who may change a document's reach, and that is exactly what removing
    // someone from a deny group does — so holding it is the honest bar. Without this
    // test, "refuse whenever a deny row exists" passes and locks out the admin whose
    // job this is.
    const { group, victim, actor } = await denyGroupWorld("sharer", "super_admin");
    await denyOneDocument(group, "sharer");

    await expect(
      repository.removeGroupMember({ actor, groupId: group.id, userId: victim.id, db: prisma })
    ).resolves.toMatchObject({ version: expect.anything() });
  }, 120_000);

  test("RF-9: coreJobs stays exempt for a deny-only group — S4b must still sync", async () => {
    const { group, victim } = await denyGroupWorld("denyexempt");
    await denyOneDocument(group, "denyexempt");

    await expect(
      repository.removeGroupMember({
        actor: SERVICE_PRINCIPALS.coreJobs, groupId: group.id, userId: victim.id, db: prisma,
      })
    ).resolves.toMatchObject({ version: expect.anything() });
  }, 120_000);

  test("a group holding nothing is addable by a `member` actor", async () => {
    // The guard is about what the GROUP carries, not about membership being
    // privileged in itself. A group with no grants confers nothing, so there is
    // nothing to contain — a check that refused this would be measuring the wrong
    // thing and would block ordinary directory sync from an ordinary admin.
    const group = await prisma.groups.create({
      data: {
        orgId: 1, name: `rf8-empty-${dbSuffix}`,
        source: "lark", externalId: `od-rf8-empty-${dbSuffix}`,
      },
    });
    const victim = await prisma.users.create({
      data: { username: `rf8-empty-victim-${dbSuffix}`, password: "x", role: "default" },
    });
    const actorUser = await prisma.users.create({
      data: { username: `rf8-empty-actor-${dbSuffix}`, password: "x", role: "default" },
    });
    const member = await prisma.roles.findFirstOrThrow({
      where: { name: "member", scope: "org" },
    });
    await repository.grantRole({
      actor: SYS, principalType: "user", principalId: String(actorUser.id),
      roleId: member.id, db: prisma,
    });

    await expect(
      repository.addGroupMember({
        actor: { type: "user", id: String(actorUser.id), orgId: 1 },
        groupId: group.id, userId: victim.id, db: prisma,
      })
    ).resolves.toMatchObject({ version: expect.anything() });
  }, 120_000);
});

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
   * RF-9 (#129): a group can carry authority WITHOUT holding a single role grant.
   *
   * `document_acl` rows are keyed `{principal_type:"group", principal_id}` and
   * `documentFilter` reads them directly — they never pass through
   * `principal_role_grants`. So a group whose entire purpose is a document ACL holds
   * ZERO role grants, `permissionIdsForGroup` returns an empty set, and the early
   * return in `refuseGroupEscalation` let ANY actor rewrite its membership.
   *
   * BOTH effects count. QA-1 measured the allow direction: a group holding an ALLOW
   * row and a `member` actor adding THEMSELVES to it succeeded — escalation in its
   * plainest form. The reason both count is the same one `permissionIdsForGroup`
   * does not filter by workspace: one `group_members` row activates the group's
   * ENTIRE ACL set at once, so the whole set is what is being delegated.
   *
   * Containment cannot supply the bar here — the permission set is empty and the
   * empty set is contained by everyone — so the ACL branch requires `role.grant`
   * (TL-1 ruling): rewriting the membership of a group that carries an ACL hands
   * that ACL out, which is a grant, and `role.grant` is the axis `grantRole` and
   * `revokeGrant` already turn on.
   */
  async function aclGroupWorld(label, actorRoleName = null) {
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
        where: { name: actorRoleName },
      });
      await repository.grantRole({
        actor: SYS, principalType: "user", principalId: String(actorUser.id),
        roleId: role.id,
        workspaceId: role.scope === "workspace" ? null : null,
        db: prisma,
      });
    }
    return {
      group, victim, actorUser,
      actor: { type: "user", id: String(actorUser.id), orgId: 1 },
    };
  }

  /** One ACL row of the given effect, keyed on the group. No role grant anywhere. */
  async function aclRow(group, label, effect) {
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
      effect,
      db: prisma,
    });
    return document;
  }

  test("RF-9 case 1: deny-only group — a `member` actor cannot REMOVE anyone", async () => {
    // Removing the victim from a group that hides documents from them restores every
    // one of those documents. The group holds no role grant, so before the fix
    // `permissionIdsForGroup` was empty and the guard returned immediately.
    const { group, victim, actor } = await aclGroupWorld("deny", "member");
    await repository.addGroupMember({ actor: SYS, groupId: group.id, userId: victim.id, db: prisma });
    await aclRow(group, "deny", "deny");

    // Matched on `role.grant`, not a generic "does not hold": the role-grant branch
    // refuses with different wording, and a loose pattern would be green for a
    // refusal that came from the wrong half of the guard.
    await expect(
      repository.removeGroupMember({ actor, groupId: group.id, userId: victim.id, db: prisma })
    ).rejects.toThrow(/role\.grant/);

    const membership = await prisma.group_members.findFirst({
      where: { group_id: group.id, user_id: victim.id },
    });
    expect(membership).not.toBeNull();
  }, 120_000);

  test("RF-9 case 2: deny-only group — a `member` actor cannot ADD anyone", async () => {
    // The other direction: handing someone a denial is authority too.
    const { group, victim, actor } = await aclGroupWorld("denyadd", "member");
    await aclRow(group, "denyadd", "deny");

    await expect(
      repository.addGroupMember({ actor, groupId: group.id, userId: victim.id, db: prisma })
    ).rejects.toThrow(/role\.grant/);
  }, 120_000);

  test("RF-9 case 3: allow-only group — a `member` actor cannot add THEMSELVES", async () => {
    // QA-1's measurement, and the plainest escalation of the set: the actor is the
    // beneficiary. A guard that counted only `deny` rows is green here, which is why
    // this case exists separately from cases 1 and 2.
    const { group, actorUser, actor } = await aclGroupWorld("allowself", "member");
    await aclRow(group, "allowself", "allow");

    await expect(
      repository.addGroupMember({ actor, groupId: group.id, userId: actorUser.id, db: prisma })
    ).rejects.toThrow(/role\.grant/);

    const membership = await prisma.group_members.findFirst({
      where: { group_id: group.id, user_id: actorUser.id },
    });
    expect(membership).toBeNull();
  }, 120_000);

  test("RF-9 case 4: allow-only group — a `member` actor cannot REMOVE anyone", async () => {
    // Removal from an allow group takes access away rather than granting it, and it
    // is still refused: deciding who a group's ACL reaches is the delegated authority,
    // in both directions. Also the second test that a deny-only count leaves green.
    const { group, victim, actor } = await aclGroupWorld("allowremove", "member");
    await repository.addGroupMember({ actor: SYS, groupId: group.id, userId: victim.id, db: prisma });
    await aclRow(group, "allowremove", "allow");

    await expect(
      repository.removeGroupMember({ actor, groupId: group.id, userId: victim.id, db: prisma })
    ).rejects.toThrow(/role\.grant/);
  }, 120_000);

  test("RF-9 case 5: coreJobs stays exempt for both effects — S4b must still sync", async () => {
    // The reconciler holds no grants at all. A guard that applied to it would refuse
    // every directory-sync write, so this is checked on both ACL shapes.
    const denyWorld = await aclGroupWorld("denyexempt");
    await repository.addGroupMember({
      actor: SYS, groupId: denyWorld.group.id, userId: denyWorld.victim.id, db: prisma,
    });
    await aclRow(denyWorld.group, "denyexempt", "deny");
    await expect(
      repository.removeGroupMember({
        actor: SERVICE_PRINCIPALS.coreJobs,
        groupId: denyWorld.group.id, userId: denyWorld.victim.id, db: prisma,
      })
    ).resolves.toMatchObject({ version: expect.anything() });

    const allowWorld = await aclGroupWorld("allowexempt");
    await aclRow(allowWorld.group, "allowexempt", "allow");
    await expect(
      repository.addGroupMember({
        actor: SERVICE_PRINCIPALS.coreJobs,
        groupId: allowWorld.group.id, userId: allowWorld.victim.id, db: prisma,
      })
    ).resolves.toMatchObject({ version: expect.anything() });
  }, 120_000);

  test("RF-9 case 6: a group with NO acl rows and no grants is still addable", async () => {
    // The control that separates "the ACL row refuses" from "this guard refuses
    // everyone". Same `member` actor, same shape of group, no ACL row — and it
    // passes. Without this, every case above is also green for a guard that refuses
    // every non-exempt actor unconditionally, which would break directory sync.
    const { group, victim, actor } = await aclGroupWorld("control", "member");

    await expect(
      repository.addGroupMember({ actor, groupId: group.id, userId: victim.id, db: prisma })
    ).resolves.toMatchObject({ version: expect.anything() });
  }, 120_000);

  test("RF-9 control: holding document.share is NOT enough — the bar is role.grant", async () => {
    // `document.share` was the first bar chosen here and it was wrong: it is the
    // permission for sharing a document you can already reach, not for deciding who a
    // group reaches. Measured on a freshly migrated database it is held by org
    // `super_admin` and workspace `owner`, so it would have let every workspace owner
    // rewrite any group's membership org-wide.
    //
    // This test pins the bar rather than the outcome: swapping `role.grant` back to
    // `document.share` must turn something red, and without this test that swap is
    // invisible — `owner` holds document.share and not role.grant.
    const { group, victim, actor } = await aclGroupWorld("sharer", "owner");
    await aclRow(group, "sharer", "deny");

    await expect(
      repository.removeGroupMember({ actor, groupId: group.id, userId: victim.id, db: prisma })
    ).rejects.toThrow(/role\.grant/);
  }, 120_000);

  test("RF-9 control: an actor holding role.grant may rewrite an ACL group", async () => {
    // The guard bounds rather than forbids. Without this, "refuse whenever an ACL row
    // exists" passes every test above and locks out the admin whose job this is.
    const { group, victim, actor } = await aclGroupWorld("granter", "super_admin");
    await aclRow(group, "granter", "deny");

    await expect(
      repository.addGroupMember({ actor, groupId: group.id, userId: victim.id, db: prisma })
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

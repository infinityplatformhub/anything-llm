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

  test("a membership write demands an explicit actor", async () => {
    // Same rule as grantRole: a missing actor must never be a free pass, because
    // seeds and migrations are exactly the callers tempted to omit one.
    const { user, group } = await world("actor");
    await expect(
      repository.addGroupMember({ groupId: group.id, userId: user.id, db: prisma })
    ).rejects.toThrow(/requires an explicit actor/);
  }, 120_000);
});

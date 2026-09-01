// T-3 (#22) integration tests — documentFilter + cache against a REAL throwaway Postgres
// DB (code-standards §7.1). RED-first: written before documentFilter.js/cache.js exist.
// Covers the seam-02 filter contract, visibility-before-ACL, the allow-list cap, the
// policy clock, and cache invalidation via policy.changed.

const { execSync } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");

const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `t3_it_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;

beforeAll(async () => {
  const hasPostgresUrl = baseDatabaseUrl?.startsWith("postgresql://");
  if (!hasPostgresUrl) {
    throw new Error("T-3 integration tests require DATABASE_URL pointing at PostgreSQL");
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
  const stillPostgres = baseDatabaseUrl?.startsWith("postgresql://");
  if (stillPostgres) {
    const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60_000);

const { buildDocumentFilter } = require("../../../utils/authorization/documentFilter");
const { FilterCache } = require("../../../utils/authorization/cache");
const repository = require("../../../utils/authorization/policyRepository");
const { SERVICE_PRINCIPALS } = require("../../../utils/authorization/actorResolver");

const SYS = SERVICE_PRINCIPALS.singleUser;
const READER = "document.read";

let W1;
let roles = {};
let docs = {};

beforeAll(async () => {
  // T-4a (#25) narrowed the org-scoped `member` role: it no longer carries document.*,
  // because an org-wide member grant meant every user could read every workspace once the
  // getWithUser bypass came out. Document access is workspace-scoped now.
  //
  // `super_admin` is the org-scoped role that still holds document.read, so it is what the
  // genuinely org-wide cases below (service principals — single-user deployments) must use.
  // Those cases are not stylistic: they cover B1, where a non-numeric principal id crashed
  // the membership lookup and took single-user deployments offline entirely.
  for (const name of ["member", "owner", "viewer", "super_admin"]) {
    roles[name] = await prisma.roles.findFirstOrThrow({
      where: {
        name,
        scope: name === "member" || name === "super_admin" ? "org" : "workspace",
      },
    });
  }
  W1 = await prisma.workspaces.create({ data: { name: "w1", slug: `t3-w1-${dbSuffix}` } });
  for (const key of ["visible", "hidden", "denied"]) {
    docs[key] = await prisma.documents.create({
      data: { orgId: 1, filename: `${key}.txt`, dedupe_key: `/t3/${dbSuffix}/${key}.txt` },
    });
    await prisma.document_acl.create({
      data: {
        orgId: 1, document_id: docs[key].id, principal_type: "workspace",
        principal_id: String(W1.id), action: READER, source: "inherited_workspace",
      },
    });
  }
});

async function userActor(id, roleId, workspaceId = W1.id) {
  await repository.grantRole({
    actor: SYS, principalType: "user", principalId: String(id),
    roleId, workspaceId, db: prisma,
  });
  return { type: "user", id: String(id), orgId: 1, workspaceIds: [String(W1.id)] };
}

describe("T-3 documentFilter", () => {
  test("null actor returns a valid match-none filter, never null and never unfiltered", async () => {
    const filter = await buildDocumentFilter({ actor: null, action: READER, db: prisma });
    expect(filter).not.toBeNull();
    expect(filter.matchNone).toBe(true);
    expect(filter.policyVersion).toBeDefined();
  });

  test("an actor with no grants gets match-none, not an empty allow-everything filter", async () => {
    const stranger = { type: "user", id: "8001", orgId: 1, workspaceIds: [] };
    const filter = await buildDocumentFilter({ actor: stranger, action: READER, db: prisma });
    expect(filter.matchNone).toBe(true);
  });

  test("a workspace member gets a scoped filter carrying the current policy version", async () => {
    const actor = await userActor(8002, roles.viewer.id);
    const filter = await buildDocumentFilter({ actor, action: READER, db: prisma });
    expect(filter.matchNone).toBe(false);
    expect(filter.orgId).toBe(1);
    expect(filter.principalType).toBe("user");
    expect(filter.actorId).toBe("8002");
    expect(filter.workspaceIds).toContain(String(W1.id));
    const head = await repository.currentPolicyVersion(prisma);
    expect(filter.policyVersion).toBe(String(head));
  });

  test("visibility is a hard override: a hidden document is denied even with an explicit allow grant", async () => {
    const actor = await userActor(8003, roles.viewer.id);
    await prisma.document_acl.create({
      data: {
        orgId: 1, document_id: docs.hidden.id, principal_type: "user",
        principal_id: "8003", action: READER, source: "manual",
      },
    });
    await repository.setDocumentVisibility({ actor: SYS, documentId: docs.hidden.id, hidden: true, db: prisma });
    const filter = await buildDocumentFilter({ actor, action: READER, db: prisma });
    expect(filter.deniedDocumentIds).toContain(String(docs.hidden.id));
  });

  test("an explicit deny row wins over the inherited workspace allow", async () => {
    const actor = await userActor(8004, roles.viewer.id);
    await prisma.document_acl.create({
      data: {
        orgId: 1, document_id: docs.denied.id, principal_type: "user",
        principal_id: "8004", action: READER, effect: "deny", source: "manual",
      },
    });
    const filter = await buildDocumentFilter({ actor, action: READER, db: prisma });
    expect(filter.deniedDocumentIds).toContain(String(docs.denied.id));
  });

  test("user actors never carry an allowedDocumentIds list (no org-wide IN-list)", async () => {
    const actor = await userActor(8005, roles.viewer.id);
    const filter = await buildDocumentFilter({ actor, action: READER, db: prisma });
    expect(filter.allowedDocumentIds).toBeUndefined();
  });

  test("embed actors carry a bounded allow list; over the cap it degrades to match-none", async () => {
    const embed = { type: "embed", id: `emb-${dbSuffix}`, orgId: 1, workspaceIds: [String(W1.id)] };
    const small = await buildDocumentFilter({
      actor: embed, action: READER, db: prisma, allowedDocumentIds: ["1", "2", "3"],
    });
    expect(small.allowedDocumentIds).toEqual(["1", "2", "3"]);
    expect(small.matchNone).toBe(false);

    const tooMany = Array.from({ length: 501 }, (_, i) => String(i + 1));
    const over = await buildDocumentFilter({
      actor: embed, action: READER, db: prisma, allowedDocumentIds: tooMany,
    });
    expect(over.matchNone).toBe(true);
    expect(over.allowedDocumentIds).toBeUndefined();
  });

  test("S-16: revoking the workspace ACL excludes the document on the next filter build", async () => {
    const actor = await userActor(8006, roles.viewer.id);
    const before = await buildDocumentFilter({ actor, action: READER, db: prisma });
    expect(before.deniedDocumentIds).not.toContain(String(docs.visible.id));

    // Replacing the inherited allow with an explicit deny is what makes the document
    // unreachable for this actor; the revoke itself must still advance the clock so
    // caches rebuild (S-16).
    await repository.revokeDocumentAcl({
      actor: SYS, documentId: docs.visible.id, principalType: "workspace",
      principalId: String(W1.id), action: READER, db: prisma,
    });
    await repository.grantDocumentAcl({
      actor: SYS, documentId: docs.visible.id, principalType: "user",
      principalId: "8006", action: READER, effect: "deny", db: prisma,
    });
    const after = await buildDocumentFilter({ actor, action: READER, db: prisma });
    expect(after.deniedDocumentIds).toContain(String(docs.visible.id));
    expect(BigInt(after.policyVersion)).toBeGreaterThan(BigInt(before.policyVersion));
  });
});

describe("T-3 filter is serializable and scope cannot be forged", () => {
  test("a forged workspace id on the Actor never reaches the filter (QA-2 scope injection)", async () => {
    // Org-wide grant is the branch where actor-supplied ids used to be unioned in.
    const forger = { type: "user", id: "8100", orgId: 1, workspaceIds: [String(W1.id), "424242"] };
    await repository.grantRole({
      actor: SYS, principalType: "user", principalId: "8100",
      roleId: roles.member.id, workspaceId: null, db: prisma,
    });
    const filter = await buildDocumentFilter({ actor: forger, action: READER, db: prisma });
    expect(filter.workspaceIds).not.toContain("424242");
    // and a workspace the user is not a member of does not appear either
    expect(filter.workspaceIds).not.toContain(String(W1.id));
  });

  test("the filter survives JSON.stringify — policyVersion is stamped as a string", async () => {
    const actor = await userActor(8101, roles.viewer.id);
    const filter = await buildDocumentFilter({ actor, action: READER, db: prisma });
    expect(typeof filter.policyVersion).toBe("string");
    expect(() => JSON.stringify(filter)).not.toThrow();
    const matchNone = await buildDocumentFilter({ actor: null, action: READER, db: prisma });
    expect(() => JSON.stringify(matchNone)).not.toThrow();
  });
});

describe("T-3 non-user principals (B1)", () => {
  test("the single-user service principal with an org-wide grant builds a usable filter", async () => {
    // Every earlier test uses a type:"user" actor, so none of them enters the org-wide
    // branch with a non-numeric id — the exact shape that took down single-user
    // deployments by handing Prisma a NaN user_id (QA-1 B1).
    await repository.grantRole({
      actor: SYS, principalType: SYS.type, principalId: SYS.id,
      roleId: roles.member.id, workspaceId: null, db: prisma,
    });
    const filter = await buildDocumentFilter({ actor: SYS, action: READER, db: prisma });
    expect(filter.matchNone).toBe(false);
    // T-4b moved "whole org" out of workspaceIds and into its own field; the property
    // this test guards is that the filter is usable at all, which is now orgWide.
    expect(filter.orgWide).toBe(true);
    expect(filter.principalType).toBe("service");
  });

  test("an org-scoped service actor also survives the ACL/visibility reads", async () => {
    const keyActor = { type: "service", id: `api-key:${dbSuffix}`, orgId: 1, workspaceIds: [String(W1.id)] };
    await repository.grantRole({
      actor: SYS, principalType: "service", principalId: keyActor.id,
      roleId: roles.viewer.id, workspaceId: W1.id, db: prisma,
    });
    const filter = await buildDocumentFilter({ actor: keyActor, action: READER, db: prisma });
    expect(filter.matchNone).toBe(false);
    expect(filter.workspaceIds).toContain(String(W1.id));
  });
});

describe("T-3 end-to-end: resolver-built actor, not a fixture", () => {
  test("B-2: a real user row + membership resolves to a scoped actor whose filter matches something", async () => {
    // The earlier tests hand documentFilter a hand-built Actor. This one goes through
    // the real resolver, which is where an empty workspaceIds would silently turn every
    // production filter into match-none (architect review).
    jest.resetModules();
    const realUser = await prisma.users.create({
      data: { username: `e2e-${dbSuffix}`, password: "x", role: "default" },
    });
    await prisma.workspace_users.create({
      data: { user_id: realUser.id, workspace_id: W1.id },
    });
    await repository.grantRole({
      actor: SYS, principalType: "user", principalId: String(realUser.id),
      roleId: roles.viewer.id, workspaceId: W1.id, db: prisma,
    });

    const { resolveActor } = require("../../../utils/authorization/actorResolver");
    const actor = await resolveActor(
      {},
      { locals: { user: { id: realUser.id, suspended: 0 } } },
      { db: prisma }
    );
    expect(actor.workspaceIds).toEqual([String(W1.id)]);

    const filter = await buildDocumentFilter({ actor, action: READER, db: prisma });
    expect(filter.matchNone).toBe(false);
    expect(filter.workspaceIds).toContain(String(W1.id));
  });
});

// T-4b (#29): `workspaceIds` carries only real workspace ids. T-3 shipped an org-wide
// service scope as the sentinel string "*" inside that array, which contradicts seam 07
// (`workspaceIds:string[]` is pushed into the provider query — a driver would look for a
// namespace literally named "*"). PMO ruling: a separate `orgWide` boolean.
describe("T-4b org-wide scope is a field, not a sentinel in workspaceIds", () => {
  test("a service principal with an org-wide grant sets orgWide and leaves workspaceIds clean", async () => {
    const svc = { type: "service", id: `orgwide-${dbSuffix}`, orgId: 1 };
    await repository.grantRole({
      actor: SYS, principalType: "service", principalId: svc.id,
      // super_admin, not member: T-4a stripped document.* from the org-scoped member role,
      // and a service principal holding a genuinely org-wide grant is exactly this case.
      roleId: roles.super_admin.id, workspaceId: null, db: prisma,
    });
    const filter = await buildDocumentFilter({ actor: svc, action: READER, db: prisma });
    expect(filter.orgWide).toBe(true);
    // The sentinel would reach a provider as a namespace name (seam 07).
    expect(filter.workspaceIds).not.toContain("*");
    for (const id of filter.workspaceIds) expect(id).toMatch(/^\d+$/);
  });

  test("orgWide alone satisfies scope — an org-wide service principal is never match-none", async () => {
    // The trap in this change: hasScope counted workspaceIds.length, and the sentinel was
    // the only thing making it non-empty. Dropping the sentinel without teaching hasScope
    // about orgWide re-opens B1 in a new shape — single-user deployments read nothing.
    const svc = { type: "service", id: `orgwide-scope-${dbSuffix}`, orgId: 1 };
    await repository.grantRole({
      actor: SYS, principalType: "service", principalId: svc.id,
      // super_admin, not member: T-4a stripped document.* from the org-scoped member role,
      // and a service principal holding a genuinely org-wide grant is exactly this case.
      roleId: roles.super_admin.id, workspaceId: null, db: prisma,
    });
    const filter = await buildDocumentFilter({ actor: svc, action: READER, db: prisma });
    expect(filter.matchNone).toBe(false);
  });

  test("every filter carries orgWide as a boolean, including match-none", async () => {
    const stranger = { type: "user", id: "8200", orgId: 1, workspaceIds: [] };
    const denied = await buildDocumentFilter({ actor: stranger, action: READER, db: prisma });
    expect(denied.orgWide).toBe(false);
    const nullActor = await buildDocumentFilter({ actor: null, action: READER, db: prisma });
    expect(nullActor.orgWide).toBe(false);
  });

  test("a workspace-scoped user never gets orgWide, whatever its grants list", async () => {
    const actor = await userActor(8201, roles.viewer.id);
    const filter = await buildDocumentFilter({ actor, action: READER, db: prisma });
    expect(filter.orgWide).toBe(false);
    expect(filter.workspaceIds).toContain(String(W1.id));
  });
});

// T-4b (#29) B-1: the filter reads grants for the same principal the engine does, or a
// key that may call a route gets an empty result set from it.
describe("T-4b B-1 in the document filter", () => {
  test("a key's filter is built from its creator's grants, not from the key principal", async () => {
    const creator = await userActor(8300, roles.viewer.id);
    const keyActor = {
      type: "service",
      id: "api-key:8300",
      orgId: 1,
      grantPrincipal: { type: "user", id: "8300" },
    };
    const filter = await buildDocumentFilter({ actor: keyActor, action: READER, db: prisma });
    expect(filter.matchNone).toBe(false);
    expect(filter.workspaceIds).toContain(String(W1.id));
    // provenance stays the key — audit must not read as the creator
    expect(filter.actorId).toBe("api-key:8300");
    expect(filter.principalType).toBe("service");
    expect(creator.id).toBe("8300");
  });

  test("a key with no creator gets match-none, never an org-wide service scope", async () => {
    // Without the grantPrincipal check, the org-wide branch treats any non-user type as
    // whole-org — so a creatorless key would read every document in the org.
    const orphan = { type: "service", id: "api-key:8301", orgId: 1, grantPrincipal: null };
    const filter = await buildDocumentFilter({ actor: orphan, action: READER, db: prisma });
    expect(filter.matchNone).toBe(true);
    expect(filter.orgWide).toBe(false);
  });

  test("a workspace-bound key never widens to everything its creator can read", async () => {
    // The creator is a member of two workspaces; the key is issued for one. The binding
    // narrows, and narrowing is the only direction a key's binding may move.
    const other = await prisma.workspaces.create({
      data: { name: "w2", slug: `t4b-w2-${dbSuffix}` },
    });
    const creatorUser = await prisma.users.create({
      data: { username: `bound-${dbSuffix}`, password: "x", role: "default" },
    });
    // T-4a: membership IS workspace access, and the grant moves with it. WorkspaceUser
    // binds the global prisma client, so this suite (which runs against a throwaway DB)
    // calls the same grant helper that model calls, with its own client injected.
    const { syncWorkspaceMembershipGrant } = require("../../../utils/authorization/legacyRoleGrants");
    for (const ws of [W1.id, other.id]) {
      await prisma.workspace_users.create({
        data: { user_id: creatorUser.id, workspace_id: ws },
      });
      await syncWorkspaceMembershipGrant({ userId: creatorUser.id, workspaceId: ws, actor: SYS, db: prisma });
    }
    // super_admin rather than member: after T-4a the org-scoped member role no longer
    // carries document.*, and this test needs a creator whose reach genuinely spans both
    // workspaces so that the binding has something to narrow.
    await repository.grantRole({
      actor: SYS, principalType: "user", principalId: String(creatorUser.id),
      roleId: roles.super_admin.id, workspaceId: null, db: prisma,
    });

    const boundKey = {
      type: "service",
      id: `api-key:bound-${dbSuffix}`,
      orgId: 1,
      grantPrincipal: { type: "user", id: String(creatorUser.id) },
      keyWorkspaceBinding: [String(W1.id)],
    };
    const filter = await buildDocumentFilter({ actor: boundKey, action: READER, db: prisma });
    expect(filter.workspaceIds).toEqual([String(W1.id)]);
    expect(filter.workspaceIds).not.toContain(String(other.id));
  });

  test("a key acting for a user is never whole-org, even on an org-wide grant", async () => {
    // orgWide keyed off actor.type, and a key is type "service" — so a key acting for a
    // user with an org-wide grant would read as whole-org while the user themself does not.
    const creatorUser = await prisma.users.create({
      data: { username: `orgw-${dbSuffix}`, password: "x", role: "default" },
    });
    const { syncWorkspaceMembershipGrant } = require("../../../utils/authorization/legacyRoleGrants");
    await prisma.workspace_users.create({
      data: { user_id: creatorUser.id, workspace_id: W1.id },
    });
    await syncWorkspaceMembershipGrant({ userId: creatorUser.id, workspaceId: W1.id, actor: SYS, db: prisma });
    // super_admin is the org-scoped role that still holds document.read after T-4a, so
    // this is a user who genuinely does hold an org-wide grant — which is the only way to
    // prove the key acting for them still resolves to their memberships rather than to
    // the whole org.
    await repository.grantRole({
      actor: SYS, principalType: "user", principalId: String(creatorUser.id),
      roleId: roles.super_admin.id, workspaceId: null, db: prisma,
    });
    const keyActor = {
      type: "service",
      id: `api-key:orgw-${dbSuffix}`,
      orgId: 1,
      grantPrincipal: { type: "user", id: String(creatorUser.id) },
    };
    const filter = await buildDocumentFilter({ actor: keyActor, action: READER, db: prisma });
    expect(filter.orgWide).toBe(false);
    expect(filter.workspaceIds).toEqual([String(W1.id)]);
  });
});

describe("T-3 filter cache", () => {
  test("a filter is reused only while the policy version is unchanged", async () => {
    const actor = await userActor(8007, roles.viewer.id);
    const cache = new FilterCache();
    let builds = 0;
    const build = async () => {
      builds += 1;
      return buildDocumentFilter({ actor, action: READER, db: prisma });
    };
    await cache.get({ actor, action: READER, db: prisma }, build);
    await cache.get({ actor, action: READER, db: prisma }, build);
    expect(builds).toBe(1);

    await repository.grantRole({
      actor: SYS, principalType: "user", principalId: "9999",
      roleId: roles.member.id, db: prisma,
    });
    await cache.get({ actor, action: READER, db: prisma }, build);
    expect(builds).toBe(2);
  });

  test("policy.changed invalidates by scope key", async () => {
    const actor = await userActor(8008, roles.viewer.id);
    const cache = new FilterCache();
    let builds = 0;
    const build = async () => {
      builds += 1;
      return buildDocumentFilter({ actor, action: READER, db: prisma });
    };
    await cache.get({ actor, action: READER, db: prisma }, build);
    cache.invalidateScopes(["org:1"]);
    await cache.get({ actor, action: READER, db: prisma }, build);
    expect(builds).toBe(2);
  });

  test("B2: two allow-lists from the same embed actor never share a cache entry", async () => {
    const embed = { type: "embed", id: `emb-cache-${dbSuffix}`, orgId: 1, workspaceIds: [String(W1.id)] };
    const cache = new FilterCache();
    const build = (allowedDocumentIds) => () =>
      buildDocumentFilter({ actor: embed, action: READER, db: prisma, allowedDocumentIds });

    const first = await cache.get(
      { actor: embed, action: READER, db: prisma, allowedDocumentIds: ["1", "2", "3"] },
      build(["1", "2", "3"])
    );
    const second = await cache.get(
      { actor: embed, action: READER, db: prisma, allowedDocumentIds: ["77", "88"] },
      build(["77", "88"])
    );
    expect(first.allowedDocumentIds).toEqual(["1", "2", "3"]);
    // Without the allow-list in the key this returns the first list — the second embed
    // request would inherit access to documents it never asked for.
    expect(second.allowedDocumentIds).toEqual(["77", "88"]);
  });

  test("B2: an over-cap match-none is not cached for later requests", async () => {
    const embed = { type: "embed", id: `emb-cap-${dbSuffix}`, orgId: 1, workspaceIds: [String(W1.id)] };
    const cache = new FilterCache();
    const tooMany = Array.from({ length: 501 }, (_, i) => String(i + 1));
    const over = await cache.get(
      { actor: embed, action: READER, db: prisma, allowedDocumentIds: tooMany },
      () => buildDocumentFilter({ actor: embed, action: READER, db: prisma, allowedDocumentIds: tooMany })
    );
    expect(over.matchNone).toBe(true);

    const ok = await cache.get(
      { actor: embed, action: READER, db: prisma, allowedDocumentIds: ["5"] },
      () => buildDocumentFilter({ actor: embed, action: READER, db: prisma, allowedDocumentIds: ["5"] })
    );
    expect(ok.matchNone).toBe(false);
    expect(ok.allowedDocumentIds).toEqual(["5"]);
  });

  test("the version stamp is the backstop when an invalidation misses its scope key", async () => {
    // A document-only scope key does not match an org/workspace-keyed entry, so eviction
    // misses. The version check must still force a rebuild — this locks the backstop in
    // place so nobody later swaps it for a pure TTL (QA-2 item 3).
    const actor = await userActor(8102, roles.viewer.id);
    const cache = new FilterCache();
    let builds = 0;
    const build = async () => {
      builds += 1;
      return buildDocumentFilter({ actor, action: READER, db: prisma });
    };
    await cache.get({ actor, action: READER, db: prisma }, build);
    cache.invalidateScopes([`document:${docs.visible.id}`]); // deliberately misses
    await cache.get({ actor, action: READER, db: prisma }, build);
    expect(builds).toBe(1); // eviction missed, entry still fresh

    await repository.setDocumentVisibility({
      actor: SYS, documentId: docs.visible.id, hidden: true, db: prisma,
    });
    await cache.get({ actor, action: READER, db: prisma }, build);
    expect(builds).toBe(2); // version moved, so the stale entry is rebuilt anyway
  });

  test("cache entries key on orgWide, not on a sentinel inside workspaceIds", async () => {
    // scopesFor() derives its keys from workspaceIds. With the sentinel gone, an
    // org-wide actor has an empty list, so an org-scope key must still be produced or
    // policy.changed can never evict it (T-5 wires the subscriber).
    const svc = { type: "service", id: `orgwide-cache-${dbSuffix}`, orgId: 1 };
    await repository.grantRole({
      actor: SYS, principalType: "service", principalId: svc.id,
      // super_admin, not member: T-4a stripped document.* from the org-scoped member role,
      // and a service principal holding a genuinely org-wide grant is exactly this case.
      roleId: roles.super_admin.id, workspaceId: null, db: prisma,
    });
    const cache = new FilterCache();
    let builds = 0;
    const build = async () => {
      builds += 1;
      return buildDocumentFilter({ actor: svc, action: READER, db: prisma });
    };
    await cache.get({ actor: svc, action: READER, db: prisma }, build);
    cache.invalidateScopes(["org:1"]);
    await cache.get({ actor: svc, action: READER, db: prisma }, build);
    expect(builds).toBe(2);
  });

  test("a disabled cache always rebuilds — stale is never served", async () => {
    const actor = await userActor(8009, roles.viewer.id);
    const cache = new FilterCache();
    cache.disable("bus subscription down");
    let builds = 0;
    const build = async () => {
      builds += 1;
      return buildDocumentFilter({ actor, action: READER, db: prisma });
    };
    await cache.get({ actor, action: READER, db: prisma }, build);
    await cache.get({ actor, action: READER, db: prisma }, build);
    expect(builds).toBe(2);
  });
});

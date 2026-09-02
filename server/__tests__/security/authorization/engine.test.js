// T-2 (#20) integration tests — the REAL engine against a REAL throwaway Postgres DB
// (code-standards §7.1). World = T-1 migrations + seeded vocabulary/roles + per-test
// principals. Engine-level slices of S-4..S-9; route-level IDOR (S-1..S-3) waits for
// T-4a, documentFilter visibility (S-21/S-22) for T-3/T-5 — see DoD mapping in recon.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");

const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `t2_it_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;

beforeAll(async () => {
  const hasPostgresUrl = baseDatabaseUrl?.startsWith(PG_SCHEME);
  if (!hasPostgresUrl) {
    throw new Error("T-2 integration tests require DATABASE_URL pointing at PostgreSQL");
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
  const stillPostgres = baseDatabaseUrl?.startsWith(PG_SCHEME);
  if (stillPostgres) {
    const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60_000);

const { DatabaseAuthorizationEngine } = require("../../../utils/authorization/engine");
const {
  AuthorizationDeniedError,
  AuthorizationUnavailableError,
} = require("../../../utils/authorization/errors");
const repository = require("../../../utils/authorization/policyRepository");
const { SERVICE_PRINCIPALS } = require("../../../utils/authorization/actorResolver");
// seed-equivalent writes use the built-in principal, exactly as migrations/seeds do
const SYS = SERVICE_PRINCIPALS.singleUser;

let engine;
const roles = {};
let W1; // real workspace ids — grants carry FK workspace_id (e5)

beforeAll(async () => {
  engine = new DatabaseAuthorizationEngine({ db: prisma });
  for (const name of ["super_admin", "setup_admin", "content_moderator", "member", "owner", "editor", "viewer"]) {
    roles[name] = await prisma.roles.findFirstOrThrow({
      where: { name, scope: name === "owner" || name === "editor" || name === "viewer" ? "workspace" : "org" },
    });
  }
  W1 = await prisma.workspaces.create({ data: { name: "w1", slug: `t2-w1-${dbSuffix}` } });
});

async function principal({ type = "user", id, grants = [] }) {
  const actor = { type, id: String(id), orgId: 1 };
  for (const g of grants) {
    const workspaceId = g.workspaceId === "W1" ? W1.id : (g.workspaceId ?? null);
    await repository.grantRole({ actor: SYS, principalType: type, principalId: String(id), roleId: g.roleId, workspaceId, expiresAt: g.expiresAt ?? null, db: prisma });
  }
  return actor;
}

const wsResource = () => ({ type: "workspace", id: null, orgId: 1, workspaceId: W1.id });
// #53: the shape an org-scoped action must be asked about — names no workspace.
const orgResource = () => ({ type: "org", id: "1", orgId: 1, workspaceId: null });
const docResource = () => ({ type: "document", id: "7", orgId: 1, workspaceId: W1.id });

describe("T-2 engine core", () => {
  test("S-4 base: null actor is denied missing_actor — engine is the default-deny point", async () => {
    const d = await engine.authorize({ actor: null, action: "workspace.read", resource: wsResource() });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("missing_actor");
  });

  test("unknown action is denied even for super_admin", async () => {
    const actor = await principal({ id: 900, grants: [{ roleId: roles.super_admin.id }] });
    const d = await engine.authorize({ actor, action: "does.not_exist", resource: wsResource() });
    expect(d).toMatchObject({ allowed: false, reason: "unknown_action" });
  });

  test("matrix: seeded roles evaluate allow/deny per the seed table", async () => {
    // viewer may read documents, may not write workspaces
    const viewer = await principal({ id: 901, grants: [{ roleId: roles.viewer.id, workspaceId: "W1" }] });
    expect(await engine.authorize({ actor: viewer, action: "document.read", resource: docResource() })).toMatchObject({ allowed: true });
    expect(await engine.authorize({ actor: viewer, action: "workspace.write", resource: wsResource() })).toMatchObject({ allowed: false, reason: "no_permission_in_roles" });

    // member (org) may chat.send
    const member = await principal({ id: 902, grants: [{ roleId: roles.member.id }] });
    expect(await engine.authorize({ actor: member, action: "chat.send", resource: wsResource() })).toMatchObject({ allowed: true });

    // super_admin holds every seeded action (generated over the full vocabulary).
    // #53: each action is asked at the scope it declares — an org-scoped action
    // asked about a workspace now THROWS a contract error, which is the point of
    // that column, so asking every action against a workspace would be asserting
    // the engine ignores it.
    const superAdmin = await principal({ id: 903, grants: [{ roleId: roles.super_admin.id }] });
    const permissions = await prisma.permissions.findMany({ select: { action: true, scope: true } });
    expect(permissions.some((p) => p.scope === "org")).toBe(true);
    const decisions = await Promise.all(
      permissions.map(({ action, scope }) =>
        engine.authorize({
          actor: superAdmin,
          action,
          resource: scope === "org" ? orgResource() : wsResource(),
        })
      )
    );
    expect(decisions.every((d) => d.allowed)).toBe(true);
  });

  test("deny-wins: a deny row on ANY granted role beats allows on others", async () => {
    const id = 904;
    await repository.grantRole({ actor: SYS, principalType: "user", principalId: String(id), roleId: roles.member.id, db: prisma });
    // craft a custom role with an explicit deny on chat.send
    const [denyRole] = await prisma.$transaction(async (tx) => {
      const r = await tx.roles.create({ data: { name: `deny-chat-${dbSuffix}`, scope: "org", orgId: 1 } });
      const perm = await tx.permissions.findUniqueOrThrow({ where: { action: "chat.send" } });
      await tx.role_permissions.create({ data: { role_id: r.id, permission_id: perm.id, effect: "deny" } });
      return [r];
    });
    await repository.grantRole({ actor: SYS, principalType: "user", principalId: String(id), roleId: denyRole.id, db: prisma });
    const d = await engine.authorize({ actor: { type: "user", id: String(id), orgId: 1 }, action: "chat.send", resource: wsResource() });
    expect(d).toMatchObject({ allowed: false, reason: "denied_by_role" });
  });

  test("S-8: expired grant grants nothing", async () => {
    const actor = await principal({
      id: 905,
      grants: [{ roleId: roles.member.id, expiresAt: new Date(Date.now() - 1000) }],
    });
    const d = await engine.authorize({ actor, action: "chat.send", resource: wsResource() });
    expect(d).toMatchObject({ allowed: false, reason: "no_grants" });
  });

  test("S-7: impersonated actor — reads allowed, every mutation denied before policy lookup", async () => {
    const base = await principal({ id: 906, grants: [{ roleId: roles.super_admin.id }] });
    const impersonated = { ...base, impersonatedBy: { type: "user", id: "1" } };
    expect(await engine.authorize({ actor: impersonated, action: "document.read", resource: docResource() })).toMatchObject({ allowed: true });
    for (const action of ["workspace.write", "document.delete", "document.export", "role.grant", "settings.write", "key.manage", "user.manage"]) {
      const d = await engine.authorize({ actor: impersonated, action, resource: wsResource() });
      expect(d).toMatchObject({ allowed: false, reason: "impersonated_mutation_denied" });
    }
  });

  test("S-5: repository refuses a grant carrying permissions the granter lacks", async () => {
    const granter = await principal({ id: 907, grants: [{ roleId: roles.viewer.id, workspaceId: "W1" }] });
    await expect(
      repository.grantRole({ actor: granter, principalType: "user", principalId: "908", roleId: roles.super_admin.id, db: prisma })
    ).rejects.toThrow(/granter does not hold/);
  });

  test("S-6 companion: a super_admin granter can grant roles it holds", async () => {
    const granter = await principal({ id: 909, grants: [{ roleId: roles.super_admin.id }] });
    const res = await repository.grantRole({ actor: granter, principalType: "user", principalId: "910", roleId: roles.member.id, db: prisma });
    expect(res.policyVersion).toBeGreaterThan(0n);
  });

  test("S-5 scope: a workspace-scoped owner cannot mint the same role org-wide", async () => {
    // owner of W1 holds workspace.members.manage etc. IN W1 only — an org-wide grant of
    // the same role would hand those permissions across every workspace.
    const wsAdmin = await principal({ id: 914, grants: [{ roleId: roles.owner.id, workspaceId: "W1" }] });
    await expect(
      repository.grantRole({ actor: wsAdmin, principalType: "user", principalId: "915", roleId: roles.owner.id, workspaceId: null, db: prisma })
    ).rejects.toThrow(/does not hold/);
    // the same grant scoped back to W1 is legitimate
    const ok = await repository.grantRole({ actor: wsAdmin, principalType: "user", principalId: "915", roleId: roles.owner.id, workspaceId: W1.id, db: prisma });
    expect(ok.policyVersion).toBeGreaterThan(0n);
  });

  test("S-9: a scoped API-key service actor gets no exemption from the escalation guard", async () => {
    const keyActor = { type: "service", id: "api-key:42", orgId: 1 };
    await expect(
      repository.grantRole({ actor: keyActor, principalType: "user", principalId: "916", roleId: roles.super_admin.id, db: prisma })
    ).rejects.toThrow(/does not hold/);
  });

  test("setDocumentVisibility bumps the policy clock like every other gateway write", async () => {
    const doc = await prisma.documents.create({
      data: { orgId: 1, filename: "v.txt", dedupe_key: `/vis/${dbSuffix}.txt` },
    });
    const before = await repository.currentPolicyVersion(prisma);
    const res = await repository.setDocumentVisibility({ actor: SYS, documentId: doc.id, hidden: true, db: prisma });
    expect(res.hidden).toBe(true);
    expect(await repository.currentPolicyVersion(prisma)).toBeGreaterThan(before);
    expect(res.policyVersion).toBeGreaterThan(before);
  });

  test("D-4: revoking requires role.revoke — not merely a non-null actor", async () => {
    // revokeGrant refused a null actor from T-3 onward, but never asked whether
    // the caller could revoke. Anyone reaching the function could strip anyone's
    // access: fail-safe in direction, but a denial of service all the same.
    const target = await principal({ id: 940, grants: [{ roleId: roles.member.id }] });
    const bystander = await principal({ id: 941, grants: [{ roleId: roles.member.id }] });

    await expect(
      repository.revokeGrant({
        actor: bystander,
        principalType: "user",
        principalId: target.id,
        roleId: roles.member.id,
        db: prisma,
      })
    ).rejects.toThrow(/does not hold role.revoke/);

    // and the grant survives the refusal
    const survived = await prisma.principal_role_grants.findFirst({
      where: { principal_type: "user", principal_id: target.id, role_id: roles.member.id },
    });
    expect(survived).not.toBeNull();
  });

  test("D-4: a revocation outlives the grant it removed", async () => {
    const target = await principal({ id: 942, grants: [{ roleId: roles.member.id }] });
    const before = await repository.currentPolicyVersion(prisma);

    await repository.revokeGrant({
      actor: SYS,
      principalType: "user",
      principalId: target.id,
      roleId: roles.member.id,
      reason: "left the team",
      db: prisma,
    });

    const gone = await prisma.principal_role_grants.findFirst({
      where: { principal_type: "user", principal_id: target.id, role_id: roles.member.id },
    });
    expect(gone).toBeNull();

    // The whole point: the grant row is deleted, so the record of who removed it
    // has to live somewhere else.
    const record = await prisma.grant_revocations.findFirst({
      where: { principal_type: "user", principal_id: target.id },
      orderBy: { id: "desc" },
    });
    expect(record).not.toBeNull();
    expect(record.role_name).toBe("member");
    expect(record.revoked_by_type).toBe(SYS.type);
    expect(record.revoked_by_id).toBe(String(SYS.id));
    expect(record.reason).toBe("left the team");
    expect(record.policy_version).toBeGreaterThan(before);
  });

  test("D-4: a refused revocation writes no audit row and does not bump the clock", async () => {
    const target = await principal({ id: 943, grants: [{ roleId: roles.member.id }] });
    const bystander = await principal({ id: 944, grants: [{ roleId: roles.member.id }] });
    const before = await repository.currentPolicyVersion(prisma);
    const rowsBefore = await prisma.grant_revocations.count();

    await expect(
      repository.revokeGrant({
        actor: bystander,
        principalType: "user",
        principalId: target.id,
        roleId: roles.member.id,
        db: prisma,
      })
    ).rejects.toThrow();

    // The transaction must roll the version bump back with everything else — a
    // refused write that still moves the clock invalidates every cache for
    // nothing, and an audit row for a revocation that did not happen is a lie.
    expect(await prisma.grant_revocations.count()).toBe(rowsBefore);
    expect(await repository.currentPolicyVersion(prisma)).toBe(before);
  });

  test("policy clock: every repository write bumps the monotonic version", async () => {
    const before = await repository.currentPolicyVersion(prisma);
    await repository.grantRole({ actor: SYS, principalType: "user", principalId: "911", roleId: roles.member.id, db: prisma });
    await repository.revokeGrant({ actor: SYS, principalType: "user", principalId: "911", roleId: roles.member.id, db: prisma });
    const after = await repository.currentPolicyVersion(prisma);
    expect(after).toBeGreaterThan(before);
  });

  test("assertAuthorized maps denials to AuthorizationDeniedError without leaking existence", async () => {
    const actor = await principal({ id: 912, grants: [{ roleId: roles.viewer.id, workspaceId: "W1" }] });
    await expect(
      engine.assertAuthorized({ actor, action: "workspace.delete", resource: wsResource() })
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
  });

  test("store failure is AuthorizationUnavailableError, never a silent allow", async () => {
    const boom = {
      permissions: { findUnique: async () => { throw new Error("db down"); } },
      principal_role_grants: { findMany: async () => [] },
      role_permissions: { findMany: async () => [] },
    };
    const broken = new DatabaseAuthorizationEngine({ db: boom });
    await expect(
      broken.authorize({ actor: { type: "user", id: "1", orgId: 1 }, action: "workspace.read", resource: wsResource() })
    ).rejects.toBeInstanceOf(AuthorizationUnavailableError);
  });

  test("authorizeMany: one decision per resource or the call fails closed", async () => {
    const actor = await principal({ id: 913, grants: [{ roleId: roles.member.id }] });
    const map = await engine.authorizeMany({
      actor,
      action: "chat.send",
      resources: [wsResource(), { type: "workspace", id: null, orgId: 1, workspaceId: W1.id + 1 }],
    });
    expect(map.size).toBe(2);
    for (const d of map.values()) expect(d.allowed).toBe(true);
    await expect(engine.authorizeMany({ actor, action: "chat.send", resources: [] })).rejects.toThrow();

    // F-20c: identical resources must still yield one decision each — a content-derived
    // key would collapse them and silently drop decisions the caller asked for.
    const dupes = await engine.authorizeMany({
      actor,
      action: "chat.send",
      resources: [wsResource(), wsResource(), wsResource()],
    });
    expect(dupes.size).toBe(3);
    expect([...dupes.keys()]).toEqual([0, 1, 2]);
  });
});

// T-4b (#29) B-1: a scoped API key holds no grants of its own; it acts for its creator.
// The engine resolves grants against `grantPrincipal` when the Actor carries one, and the
// `api-key:` id stays as audit provenance. The scope half of the intersection is the
// ingress middleware's job (validApiKey), so these cover the grant half only.
describe("T-4b B-1: an API-key Actor evaluates grants as its creator", () => {
  test("a key whose creator holds the grant is ALLOWED — /v1 is not universally denied", async () => {
    const creator = await principal({ id: 950, grants: [{ roleId: roles.member.id }] });
    const keyActor = {
      type: "service",
      id: "api-key:950",
      orgId: 1,
      grantPrincipal: { type: creator.type, id: creator.id },
      attributes: { scopes: ["chat.send"] },
    };
    const decision = await engine.authorize({
      actor: keyActor,
      action: "chat.send",
      resource: wsResource(),
    });
    expect(decision).toMatchObject({ allowed: true });
  });

  test("S-9 grant half: a key whose creator lacks the permission is denied", async () => {
    // The key's own scope list says this action is fine; the creator's grants say it is
    // not. Effective permission is the intersection, so this must deny.
    const creator = await principal({ id: 951, grants: [{ roleId: roles.viewer.id, workspaceId: "W1" }] });
    const keyActor = {
      type: "service",
      id: "api-key:951",
      orgId: 1,
      grantPrincipal: { type: creator.type, id: creator.id },
      attributes: { scopes: ["workspace.delete"] },
    };
    const decision = await engine.authorize({
      actor: keyActor,
      action: "workspace.delete",
      resource: wsResource(),
    });
    expect(decision.allowed).toBe(false);
  });

  test("a key with no creator (createdBy null) is denied, never treated as unscoped", async () => {
    const keyActor = {
      type: "service",
      id: "api-key:952",
      orgId: 1,
      grantPrincipal: null,
      attributes: { scopes: ["chat.send"] },
    };
    const decision = await engine.authorize({
      actor: keyActor,
      action: "chat.send",
      resource: wsResource(),
    });
    expect(decision).toMatchObject({ allowed: false, reason: "no_grant_principal" });
  });

  test("the key principal itself is never consulted, even if a grant row names it", async () => {
    // Defence in depth: if anything ever writes a grant for `api-key:<id>` — a migration
    // slip, an admin UI that treats keys as principals — it must not become a second,
    // unaudited way to hold policy.
    await repository.grantRole({
      actor: SYS, principalType: "service", principalId: "api-key:953",
      roleId: roles.super_admin.id, db: prisma,
    });
    const creator = await principal({ id: 953, grants: [{ roleId: roles.viewer.id, workspaceId: "W1" }] });
    const keyActor = {
      type: "service",
      id: "api-key:953",
      orgId: 1,
      grantPrincipal: { type: creator.type, id: creator.id },
      attributes: { scopes: ["*"] },
    };
    const decision = await engine.authorize({
      actor: keyActor,
      action: "workspace.delete",
      resource: wsResource(),
    });
    expect(decision.allowed).toBe(false);
  });

  test("a workspace-bound key is denied on any OTHER workspace, before the grant lookup", async () => {
    // QA-1 blocker on cfa3388a: the binding was honoured only in documentFilter, so a key
    // bound to workspace X could authorize a mutation against workspace Y through its
    // creator's grants. The binding is a property of the credential, so it gates like
    // impersonation does — blanket, before any policy is read.
    const creator = await principal({ id: 954, grants: [{ roleId: roles.member.id }] });
    const other = await prisma.workspaces.create({
      data: { name: "w-other", slug: `t4b-other-${dbSuffix}` },
    });
    const boundKey = {
      type: "service",
      id: "api-key:954",
      orgId: 1,
      grantPrincipal: { type: creator.type, id: creator.id },
      keyWorkspaceBinding: [String(W1.id)],
      attributes: { scopes: ["chat.send"] },
    };
    // its own workspace still works
    expect(
      await engine.authorize({ actor: boundKey, action: "chat.send", resource: wsResource() })
    ).toMatchObject({ allowed: true });
    // another workspace does not, even though the creator holds an org-wide grant
    expect(
      await engine.authorize({
        actor: boundKey,
        action: "chat.send",
        resource: { type: "workspace", id: null, orgId: 1, workspaceId: other.id },
      })
    ).toMatchObject({ allowed: false, reason: "outside_key_binding" });
  });

  test("a bound key is denied on org-wide resources it cannot attribute to its workspace", async () => {
    // A resource with no workspaceId (system-level) cannot be checked against the binding,
    // so a bound key must not reach it: unattributable is not the same as in-scope.
    await principal({ id: 955, grants: [{ roleId: roles.super_admin.id }] });
    const boundKey = {
      type: "service",
      id: "api-key:955",
      orgId: 1,
      grantPrincipal: { type: "user", id: "955" },
      keyWorkspaceBinding: [String(W1.id)],
      attributes: { scopes: ["system.read"] },
    };
    const decision = await engine.authorize({
      actor: boundKey,
      action: "system.read",
      resource: { type: "system", id: null, orgId: 1, workspaceId: null },
    });
    expect(decision).toMatchObject({ allowed: false, reason: "outside_key_binding" });
  });

  test("an UNBOUND key is not narrowed — the binding only applies when one exists", async () => {
    await principal({ id: 956, grants: [{ roleId: roles.member.id }] });
    const unbound = {
      type: "service",
      id: "api-key:956",
      orgId: 1,
      grantPrincipal: { type: "user", id: "956" },
      keyWorkspaceBinding: [],
      attributes: { scopes: ["chat.send"] },
    };
    expect(
      await engine.authorize({ actor: unbound, action: "chat.send", resource: wsResource() })
    ).toMatchObject({ allowed: true });
  });

  // Handed over from Dev2 (t4a) when B-1 consolidated into the resolver. Rewritten to go
  // through resolveActor against real api_keys rows rather than hand-built Actors: B-1
  // lives in the resolver, so a hand-built Actor tests the half that was removed.
  test("S-9 ingress, both directions: a key never exceeds its creator, and a valid key still passes", async () => {
    const { resolveActor } = require("../../../utils/authorization/actorResolver");
    const keyFor = async ({ creatorId, scopes, workspaceId = null, name }) => {
      const row = await prisma.api_keys.create({
        data: {
          name,
          secretDigest: Buffer.from(crypto.randomBytes(32)),
          keyPrefix: `t4b-${name}-${dbSuffix}`.slice(0, 16),
          scopes: JSON.stringify(scopes),
          workspaceId,
          createdBy: creatorId,
        },
      });
      return resolveActor(
        {},
        { locals: { apiKeyContext: { keyId: row.id, keyPrefix: row.keyPrefix, scopes, workspaceId: workspaceId ? String(workspaceId) : null, keyKind: "api-key" } } },
        { db: prisma }
      );
    };

    // over-scoped: the key's scope string permits workspace.write, the creator holds only
    // viewer, and a grant row deliberately names the key principal itself.
    const limited = await prisma.users.create({
      data: { username: `limited-${dbSuffix}`, password: "unused", role: "default" },
    });
    await repository.grantRole({
      actor: SYS, principalType: "user", principalId: String(limited.id),
      roleId: roles.viewer.id, workspaceId: W1.id, db: prisma,
    });
    const overScoped = await keyFor({
      creatorId: limited.id, scopes: ["workspace.write"], name: "over",
    });
    await repository.grantRole({
      actor: SYS, principalType: "service", principalId: overScoped.id,
      roleId: roles.owner.id, workspaceId: W1.id, db: prisma,
    });
    expect(
      await engine.authorize({
        actor: overScoped,
        action: "workspace.write",
        resource: { type: "workspace", id: String(W1.id), orgId: 1, workspaceId: W1.id },
      })
    ).toMatchObject({ allowed: false });

    // the other direction: a key whose creator DOES hold the grant must still pass, or
    // B-1 has simply broken /v1 instead of securing it.
    const allowed = await prisma.users.create({
      data: { username: `allowed-${dbSuffix}`, password: "unused", role: "default" },
    });
    await repository.grantRole({
      actor: SYS, principalType: "user", principalId: String(allowed.id),
      roleId: roles.viewer.id, workspaceId: W1.id, db: prisma,
    });
    const validKey = await keyFor({
      creatorId: allowed.id, scopes: ["document.read"], name: "ok",
    });
    expect(
      await engine.authorize({
        actor: validKey,
        action: "document.read",
        resource: { type: "document", id: "1", orgId: 1, workspaceId: W1.id },
      })
    ).toMatchObject({ allowed: true });
  });

  test("a service principal without grantPrincipal still evaluates as itself (core-jobs)", async () => {
    // Only API-key Actors carry grantPrincipal. Built-in service principals hold real
    // grants under their own ids and must keep working unchanged.
    const jobs = SERVICE_PRINCIPALS.coreJobs;
    await repository.grantRole({
      actor: SYS, principalType: jobs.type, principalId: jobs.id,
      roleId: roles.member.id, db: prisma,
    });
    const decision = await engine.authorize({
      actor: jobs,
      action: "chat.send",
      resource: wsResource(),
    });
    expect(decision).toMatchObject({ allowed: true });
  });
});

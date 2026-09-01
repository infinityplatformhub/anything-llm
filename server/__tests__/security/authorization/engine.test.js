// T-2 (#20) integration tests — the REAL engine against a REAL throwaway Postgres DB
// (code-standards §7.1). World = T-1 migrations + seeded vocabulary/roles + per-test
// principals. Engine-level slices of S-4..S-9; route-level IDOR (S-1..S-3) waits for
// T-4a, documentFilter visibility (S-21/S-22) for T-3/T-5 — see DoD mapping in recon.

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");

const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `t2_it_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;

beforeAll(async () => {
  const hasPostgresUrl = baseDatabaseUrl?.startsWith("postgresql://");
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
  const stillPostgres = baseDatabaseUrl?.startsWith("postgresql://");
  if (stillPostgres) {
    const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
});

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

    // super_admin holds every seeded action (generated over the full 50-word vocabulary)
    const superAdmin = await principal({ id: 903, grants: [{ roleId: roles.super_admin.id }] });
    const allActions = (await prisma.permissions.findMany({ select: { action: true } })).map((p) => p.action);
    const decisions = await Promise.all(
      allActions.map((action) => engine.authorize({ actor: superAdmin, action, resource: wsResource() }))
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

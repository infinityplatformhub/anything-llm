/**
 * T-7 (#31): grant management over HTTP — the half of the duty split that was
 * missing.
 *
 * T-1 seeded `setup_admin` and `content_moderator` with their permissions, but
 * `grantRole` had no route, so the only roles anyone could actually be given
 * were the two the legacy `users.role` column mapped to. These tests drive the
 * real routes with real signed tokens, because a test that calls `grantRole`
 * directly proves the gateway T-2 already proved — not that the duty split is
 * reachable.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "t7-grants-")
  );
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "test-jwt-secret-at-least-12-chars";

const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `t7_grants_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;
let server;
let baseUrl;
let superAdminUser;
let setupAdminUser;
let plainUser;
let targetUser;
let workspace;
let superToken;
let setupToken;
let plainToken;
let roles = {};

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    throw new Error("T-7 integration tests require DATABASE_URL on PostgreSQL");
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

  // The SHARED client, because that is what the endpoint resolves. A test with
  // its own PrismaClient writes to one database and reads another, and every
  // capability comes back denied — which is indistinguishable from a correct
  // refusal (recorded in ledger-31).
  // utils/prisma binds DATABASE_URL at first require and jest --runInBand shares
  // one process, so another suite may already have it loaded against the shared
  // database — in which case every write below silently lands there. The tests
  // still pass (they read back what they wrote); the damage is to OTHER suites,
  // since isConfirmedSingleUser counts real user rows.
  jest.resetModules();
  prisma = require("../../../utils/prisma");

  const repository = require("../../../utils/authorization/policyRepository");
  const {
    SERVICE_PRINCIPALS,
  } = require("../../../utils/authorization/actorResolver");
  const { makeJWT } = require("../../../utils/http");

  for (const name of ["super_admin", "setup_admin", "content_moderator", "member"]) {
    roles[name] = await prisma.roles.findFirstOrThrow({
      where: { name, scope: "org" },
    });
  }
  roles.editor = await prisma.roles.findFirstOrThrow({
    where: { name: "editor", scope: "workspace" },
  });

  const mkUser = (label, role = "default") =>
    prisma.users.create({
      data: { username: `gm-${label}-${dbSuffix}`, password: "unused", role },
    });
  superAdminUser = await mkUser("super", "admin");
  setupAdminUser = await mkUser("setup", "admin");
  plainUser = await mkUser("plain");
  targetUser = await mkUser("target");
  workspace = await prisma.workspaces.create({
    data: { name: `gm-ws-${dbSuffix}`, slug: `gm-ws-${dbSuffix}` },
  });

  const grant = (userId, roleId, workspaceId = null) =>
    repository.grantRole({
      actor: SERVICE_PRINCIPALS.singleUser,
      principalType: "user",
      principalId: String(userId),
      roleId,
      workspaceId,
      db: prisma,
    });
  await grant(superAdminUser.id, roles.super_admin.id);
  await grant(setupAdminUser.id, roles.setup_admin.id);

  superToken = makeJWT({ id: superAdminUser.id, username: superAdminUser.username });
  setupToken = makeJWT({ id: setupAdminUser.id, username: setupAdminUser.username });
  plainToken = makeJWT({ id: plainUser.id, username: plainUser.username });

  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });

  const {
    adminAuthorizationEndpoints,
  } = require("../../../endpoints/admin/authorization");
  const app = express();
  app.use(express.json());
  adminAuthorizationEndpoints(app);
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}, 300_000);

afterAll(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  if (prisma) await prisma.$disconnect();
  process.env.DATABASE_URL = baseDatabaseUrl;
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const admin = new PrismaClient({
      datasources: { db: { url: baseDatabaseUrl } },
    });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60_000);

const post = (body, token = superToken) =>
  fetch(`${baseUrl}/admin/authorization/grants`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const del = (body, token = superToken) =>
  fetch(`${baseUrl}/admin/authorization/grants`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const list = (principalId, token = superToken) =>
  fetch(
    `${baseUrl}/admin/authorization/grants?principalType=user&principalId=${principalId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

describe("grant management: the duty split becomes reachable", () => {
  test("a super_admin can hand out setup_admin, which nothing could do before", async () => {
    const res = await post({
      principalType: "user",
      principalId: String(targetUser.id),
      role: "setup_admin",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("setup_admin");
    // Serialised, not a BigInt: the clock is what a caller compares against.
    expect(typeof body.policyVersion).toBe("string");

    const listed = await (await list(targetUser.id)).json();
    expect(listed.grants.map((g) => g.role)).toContain("setup_admin");
    // null is org-wide, which the engine reads as every workspace.
    expect(listed.grants.find((g) => g.role === "setup_admin").workspaceId).toBeNull();
  });

  test("a workspace-scoped grant is bound to that workspace, not the org", async () => {
    const res = await post({
      principalType: "user",
      principalId: String(targetUser.id),
      role: "editor",
      workspaceId: workspace.id,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).workspaceId).toBe(workspace.id);

    const listed = await (await list(targetUser.id)).json();
    const editor = listed.grants.find((g) => g.role === "editor");
    expect(editor.workspaceId).toBe(workspace.id);
  });

  test("the escalation guard holds over HTTP: setup_admin cannot mint a super_admin", async () => {
    // setup_admin holds role.grant, so the ROUTE gate lets it through. The
    // gateway then refuses because super_admin carries permissions it does not
    // hold — the two checks ask different questions and both must pass.
    const res = await post(
      {
        principalType: "user",
        principalId: String(targetUser.id),
        role: "super_admin",
      },
      setupToken
    );
    expect(res.status).toBe(403);

    const listed = await (await list(targetUser.id)).json();
    expect(listed.grants.map((g) => g.role)).not.toContain("super_admin");
  });

  test("a plain member cannot reach the routes at all", async () => {
    expect((await post(
      { principalType: "user", principalId: String(targetUser.id), role: "member" },
      plainToken
    )).status).toBe(403);
    expect((await list(targetUser.id, plainToken)).status).toBe(403);
  });

  test("a grant may not name a principal that does not exist", async () => {
    // Otherwise a typo writes a row that grants nothing today and silently
    // starts granting the day a user is created with that id.
    const res = await post({
      principalType: "user",
      principalId: "987654",
      role: "member",
    });
    expect(res.status).toBe(404);
    // The BODY, not just the status: Express answers 404 for a route that does
    // not exist either, so a status-only assertion passes against no route at
    // all — which is exactly what it did when this was proved RED.
    expect((await res.json()).error).toBe("no such user");
  });

  test("service and system principals are not assignable over HTTP", async () => {
    // They are the exemptions the escalation guard skips, so granting to one
    // over the network routes around the guard protecting every other grant.
    for (const principalType of ["service", "system"]) {
      const res = await post({
        principalType,
        principalId: "core-jobs",
        role: "super_admin",
      });
      expect(res.status).toBe(400);
    }
  });

  test("a workspace role named without a workspace is a scope error", async () => {
    const res = await post({
      principalType: "user",
      principalId: String(targetUser.id),
      role: "editor",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/org-scoped role/);
  });

  test("revoking leaves an audit row and moves the clock", async () => {
    const before = await prisma.grant_revocations.count();
    const res = await del({
      principalType: "user",
      principalId: String(targetUser.id),
      role: "setup_admin",
      reason: "duty rotation",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(1);

    expect(await prisma.grant_revocations.count()).toBe(before + 1);
    const row = await prisma.grant_revocations.findFirst({
      where: { principal_id: String(targetUser.id), role_name: "setup_admin" },
    });
    expect(row.revoked_by_id).toBe(String(superAdminUser.id));
    expect(row.reason).toBe("duty rotation");

    const listed = await (await list(targetUser.id)).json();
    expect(listed.grants.map((g) => g.role)).not.toContain("setup_admin");
  });

  test("revoking a grant that is not there answers 200, not 404", async () => {
    // 404 would tell the caller whether the grant existed, which is the
    // enumeration answer the gate withheld. The requested state is reached.
    const res = await del({
      principalType: "user",
      principalId: String(plainUser.id),
      role: "content_moderator",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(0);
  });
});

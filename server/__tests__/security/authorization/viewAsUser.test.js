/**
 * T-7 (#31, D-3): view-as-user, end to end over HTTP.
 *
 * `actorResolver` has read `locals.impersonatedBy` since T-2 and NOTHING wrote
 * it, so the engine's blanket mutation deny was correct, tested, and
 * unreachable in production. These tests go through the real login-shaped path
 * — issue a token, present it, act — because a unit test that hands
 * `{impersonatedBy}` to `authorize()` proves the engine, not the feature.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "t7-viewas-")
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
const testDb = `t7_viewas_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;
let server;
let baseUrl;
let adminUser;
let targetUser;
let adminToken;

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
  prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });

  const repository = require("../../../utils/authorization/policyRepository");
  const {
    SERVICE_PRINCIPALS,
  } = require("../../../utils/authorization/actorResolver");
  const { makeJWT } = require("../../../utils/http");

  adminUser = await prisma.users.create({
    data: { username: `va-admin-${dbSuffix}`, password: "unused", role: "admin" },
  });
  targetUser = await prisma.users.create({
    data: { username: `va-target-${dbSuffix}`, password: "unused", role: "default" },
  });
  const superAdmin = await prisma.roles.findFirstOrThrow({
    where: { name: "super_admin", scope: "org" },
  });
  await repository.grantRole({
    actor: SERVICE_PRINCIPALS.singleUser,
    principalType: "user",
    principalId: String(adminUser.id),
    roleId: superAdmin.id,
    db: prisma,
  });
  adminToken = makeJWT({ id: adminUser.id, username: adminUser.username });

  // validatedRequest refuses JWT sessions unless the instance is in multi-user
  // mode; view-as-user only means anything when there are other users.
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });

  const { adminEndpoints } = require("../../../endpoints/admin");
  const app = express();
  app.use(express.json());
  adminEndpoints(app);
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

const viewAs = (id, token = adminToken) =>
  fetch(`${baseUrl}/admin/view-as-user/${id}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

describe("D-3: view-as-user", () => {
  test("an admin can mint a session for another user, stamped with who they are", async () => {
    const res = await viewAs(targetUser.id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.impersonatedBy).toBe(adminUser.id);
    expect(body.readOnly).toBe(true);

    // The provenance is IN the token: a claim carried alongside it could be
    // dropped by the holder to upgrade a read-only session to a real one.
    const decoded = require("jsonwebtoken").decode(body.token);
    expect(decoded.id).toBe(targetUser.id);
    expect(decoded.impersonatedBy).toBe(adminUser.id);
  });

  test("the impersonated session is denied every mutation, and allowed reads", async () => {
    const { token } = await (await viewAs(targetUser.id)).json();
    const {
      DatabaseAuthorizationEngine,
    } = require("../../../utils/authorization/engine");
    const { resolveActor } = require("../../../utils/authorization/actorResolver");

    // Drive the real middleware so the actor is built the way a request builds
    // it — from the signed token, not by hand.
    const {
      validatedRequest,
    } = require("../../../utils/middleware/validatedRequest");
    const request = { header: () => `Bearer ${token}` };
    const response = { locals: {}, status: () => response, json: () => response };
    await new Promise((resolve) => validatedRequest(request, response, resolve));

    expect(response.locals.impersonatedBy).toBe(adminUser.id);
    const actor = await resolveActor(request, response);
    expect(actor.impersonatedBy).toEqual({
      type: "user",
      id: String(adminUser.id),
    });

    const engine = new DatabaseAuthorizationEngine();
    const org = { type: "org", id: "1", orgId: 1, workspaceId: null };
    for (const action of [
      "chat.send",
      "document.delete",
      "role.grant",
      "settings.write",
      "user.manage",
    ]) {
      const decision = await engine.authorize({ actor, action, resource: org });
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe("impersonated_mutation_denied");
    }
  });

  test("an impersonated session cannot impersonate again", async () => {
    const { token } = await (await viewAs(targetUser.id)).json();
    // Chaining would lose the head of the provenance chain: the second hop would
    // record the first target as the impersonator.
    const res = await viewAs(adminUser.id, token);
    expect(res.status).toBe(403);
  });

  test("you cannot view as yourself, or as a suspended user", async () => {
    expect((await viewAs(adminUser.id)).status).toBe(400);

    const suspended = await prisma.users.create({
      data: {
        username: `va-susp-${dbSuffix}`,
        password: "unused",
        suspended: 1,
      },
    });
    expect((await viewAs(suspended.id)).status).toBe(400);
  });
});

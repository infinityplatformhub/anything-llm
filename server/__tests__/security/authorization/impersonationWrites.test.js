/**
 * #52 BLOCKER-1: an impersonated session could change the victim's credentials.
 *
 * T-7 shipped view-as-user with the engine denying every mutation for an
 * impersonated actor — but that deny only runs on routes that ASK the engine.
 * `POST /system/user` and `POST /onboarding` carry `validatedRequest` alone, so
 * nothing asked, and a support engineer viewing as a user could set that user's
 * username and password and then log in as them for real.
 *
 * The fix is at `validatedRequest`, not on the two routes: adding
 * `requirePermission` to these two closes the two doors found today and leaves
 * the class open for the next route someone writes with session auth alone.
 * An impersonated session is read-only, so it refuses every non-GET regardless
 * of which route it reached. The engine's blanket deny stays as the second
 * layer — two independent refusals, neither relying on the other.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "h52-")
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
const testDb = `h52_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;
let server;
let baseUrl;
let admin;
let victim;
let adminToken;
let impersonatedToken;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    throw new Error("#52 integration tests require DATABASE_URL on PostgreSQL");
  }
  const root = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await root.$executeRawUnsafe(`CREATE DATABASE "${testDb}"`);
  await root.$disconnect();
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

  // §7.10: utils/prisma binds DATABASE_URL at first require and runInBand
  // shares one process, so reset before requiring or this writes into whichever
  // database another suite loaded it against.
  jest.resetModules();
  prisma = require("../../../utils/prisma");

  const repository = require("../../../utils/authorization/policyRepository");
  const {
    SERVICE_PRINCIPALS,
  } = require("../../../utils/authorization/actorResolver");
  const { makeJWT } = require("../../../utils/http");
  const bcrypt = require("bcryptjs");

  admin = await prisma.users.create({
    data: {
      username: `h52-admin-${dbSuffix}`,
      password: bcrypt.hashSync("AdminPw123!", 10),
      role: "admin",
    },
  });
  victim = await prisma.users.create({
    data: {
      username: `h52-victim-${dbSuffix}`,
      password: bcrypt.hashSync("VictimPw123!", 10),
      role: "default",
    },
  });
  const superAdmin = await prisma.roles.findFirstOrThrow({
    where: { name: "super_admin", scope: "org" },
  });
  await repository.grantRole({
    actor: SERVICE_PRINCIPALS.singleUser,
    principalType: "user",
    principalId: String(admin.id),
    roleId: superAdmin.id,
    db: prisma,
  });

  adminToken = makeJWT({ id: admin.id, username: admin.username });
  // The real shape a view-as-user session has: the victim's id, stamped with
  // who is behind it. Signed, so the holder cannot strip the claim.
  impersonatedToken = makeJWT({
    id: victim.id,
    username: victim.username,
    impersonatedBy: admin.id,
  });

  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });

  const { systemEndpoints } = require("../../../endpoints/system");
  const { adminEndpoints } = require("../../../endpoints/admin");
  const app = express();
  app.use(express.json());
  systemEndpoints(app);
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
    const root = new PrismaClient({
      datasources: { db: { url: baseDatabaseUrl } },
    });
    await root.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await root.$disconnect();
  }
}, 60_000);

const call = (method, route, token, body) =>
  fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });

describe("#52: an impersonated session cannot write, on any route", () => {
  test("POST /system/user is refused, and the victim's credentials are unchanged", async () => {
    const before = await prisma.users.findUnique({ where: { id: victim.id } });

    const res = await call("POST", "/system/user", impersonatedToken, {
      username: `stolen-${dbSuffix}`,
      password: "AttackerPw123!",
    });
    expect(res.status).toBe(403);

    // The status alone would not prove much — the row is the claim. A 403 with
    // the write already committed is the failure this test exists to catch.
    const after = await prisma.users.findUnique({ where: { id: victim.id } });
    expect(after.username).toBe(before.username);
    expect(after.password).toBe(before.password);
  });

  test("POST /onboarding is refused too — it is the class, not the route", async () => {
    const res = await call("POST", "/onboarding", impersonatedToken);
    expect(res.status).toBe(403);
  });

  test("reads still work: a view-as-user session is read-only, not blocked", async () => {
    // Without this, refusing every impersonated request would pass the two
    // cases above while destroying the feature.
    // A route gated only on the session, so a 403 here could only come from the
    // impersonation guard — not from a permission the victim happens to lack.
    const res = await call("GET", "/system/footer-data", impersonatedToken);
    expect(res.status).toBe(200);
  });

  test("a real admin session is untouched", async () => {
    // The guard keys on the impersonation claim, not on the method, so an
    // ordinary write must still go through.
    const res = await call("POST", "/system/user", adminToken, {
      bio: "still works",
    });
    expect(res.status).toBe(200);
  });

  test("the guard keys on the claim, not the method: view-as-user still works", async () => {
    // POST /admin/view-as-user/:id is how a session BECOMES impersonated. A
    // guard written on the method alone would refuse it and take the feature
    // out entirely — while every test above still passed.
    const res = await call("POST", `/admin/view-as-user/${victim.id}`, adminToken);
    expect(res.status).toBe(200);
    expect((await res.json()).impersonatedBy).toBe(admin.id);
  });

  test("no chaining: the second layer still answers on its own", async () => {
    // validatedRequest refuses this now, before admin.js is reached. The guard
    // at admin.js:202 stays anyway — this asserts the refusal, not which layer
    // produced it, so removing either one leaves the test meaningful.
    const res = await call("POST", `/admin/view-as-user/${admin.id}`, impersonatedToken);
    expect(res.status).toBe(403);
  });
});

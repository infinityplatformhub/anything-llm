/**
 * #52 nit 1: `POST /system/enable-multi-user` now requires `settings.write`.
 *
 * That route is how a single-user instance BECOMES multi-user, so if the
 * single-user principal cannot satisfy the gate, the instance can never leave
 * single-user mode — a self-lockout introduced by the fix. The engine allowing
 * it in isolation is not enough: what matters is whether a real request, with
 * no session and no user rows, resolves to that principal at all.
 *
 * So this drives the actual route over HTTP against a database with ZERO users,
 * which is what a fresh install is.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "h52-single-")
  );

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
const testDb = `h52_single_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;
let server;
let baseUrl;
const savedEnv = {};

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

  // §7.10: reset first, or this binds to whichever database another suite
  // loaded the shared client against.
  jest.resetModules();
  prisma = require("../../../utils/prisma");

  const { systemEndpoints } = require("../../../endpoints/system");
  const app = express();
  app.use(express.json());
  systemEndpoints(app);
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  // AFTER the mount: requiring the endpoints pulls in dotenv, which repopulates
  // AUTH_TOKEN and JWT_SECRET from a developer's server/.env. Clearing them
  // first therefore does nothing, and the request takes the password branch and
  // 401s — which looks exactly like the self-lockout this test is checking for.
  // A fresh install has neither variable set.
  for (const key of ["AUTH_TOKEN", "JWT_SECRET", "NODE_ENV"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}, 300_000);

afterAll(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  if (prisma) await prisma.$disconnect();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.env.DATABASE_URL = baseDatabaseUrl;
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const root = new PrismaClient({
      datasources: { db: { url: baseDatabaseUrl } },
    });
    await root.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await root.$disconnect();
  }
}, 60_000);

describe("issue 52: a single-user instance can still enable multi-user mode", () => {
  test("the request really takes the single-user path", async () => {
    // Guards the guard: if the resolver saw multi-user mode, the route would
    // 401 at validatedRequest and never reach the gate this test is about —
    // and the failure would look identical to a self-lockout.
    const {
      isConfirmedSingleUser,
    } = require("../../../utils/authorization/actorResolver");
    expect(await isConfirmedSingleUser()).toBe(true);
  });

  test("the database really is a fresh single-user install", async () => {
    // The precondition IS the test's meaning: with users present, the route
    // would take a different branch and prove nothing about a fresh install.
    expect(await prisma.users.count()).toBe(0);
    const grant = await prisma.principal_role_grants.findFirst({
      where: { principal_type: "service", principal_id: "single-user" },
    });
    expect(grant).not.toBeNull();
  });

  test("POST /system/enable-multi-user is not refused by the new gate", async () => {
    const res = await fetch(`${baseUrl}/system/enable-multi-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: `owner-${dbSuffix}`,
        password: "OwnerPw123!",
      }),
    });

    // 403 here is the self-lockout: the instance could never leave single-user
    // mode, because this route is the only way out of it.
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

    // And it did the thing, rather than answering 200 having refused inside.
    expect(await prisma.users.count()).toBe(1);
  });
});

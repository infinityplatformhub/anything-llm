/**
 * issue 58 (ruling C, item 2): `/request-token` must not take the AUTH_TOKEN
 * branch on an instance that has user accounts.
 *
 * The boot repair fixes shape (b) found at startup. It cannot cover shape (b)
 * that ARISES while the server runs — a restore into a live instance, a
 * settings row edited by hand. This branch authenticates against
 * `process.env.AUTH_TOKEN` rather than any account, so taking it on an instance
 * WITH accounts mints a session no user's credentials were checked for.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "h58-rt-")
  );
process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER || "h58-rt-api-key-pepper-32-bytes-minimum";
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "h58-single-user-password";

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
const testDb = `h58_rt_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;
let server;
let baseUrl;

const setMode = (value) =>
  prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: String(value) },
    create: { label: "multi_user_mode", value: String(value) },
  });

const login = (password) =>
  fetch(`${baseUrl}/request-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    throw new Error("issue 58 integration tests require PostgreSQL");
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

afterEach(async () => {
  await prisma.users.deleteMany({});
});

describe("issue 58: /request-token and shape (b) arising at runtime", () => {
  test("a genuine single-user instance still mints a token", async () => {
    // The positive control, and the one that would fail if the guard were
    // written as "never take this branch". Single-user login must keep working.
    await setMode(false);
    expect(await prisma.users.count()).toBe(0);

    const res = await login(process.env.AUTH_TOKEN);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.token).toBeTruthy();
  });

  test("shape (b) at runtime: the AUTH_TOKEN branch mints nothing", async () => {
    await setMode(false);
    await prisma.users.create({
      data: { username: `rt-${dbSuffix}`, password: "irrelevant" },
    });

    // The CORRECT single-user password, which is exactly the point: the
    // instance has accounts now, so this credential must not produce a session.
    const res = await login(process.env.AUTH_TOKEN);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.token).toBeNull();
    // Indistinguishable from an ordinary bad password: which branch refused is
    // not something an unauthenticated caller gets to learn.
    expect(body.message).toMatch(/Invalid password/);
  });
});

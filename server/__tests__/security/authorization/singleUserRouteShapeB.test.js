/**
 * issue 52 (QA-2 addendum 7): the two halves of "which mode is this" disagreed.
 *
 * Shape (b) is `multi_user_mode = false` WITH user rows present — a partial
 * restore, a dropped setting row, or an instance mid-migration.
 *
 *   `isSingleUserMode` (deploymentMode.js) read the raw setting → "single-user"
 *                                         → let the request through.
 *   `validatedRequest` used `isConfirmedSingleUser` (setting AND zero users)
 *                                         → "multi-user"
 *                                         → accepted a session JWT.
 *
 * So a route reachable only in single-user mode accepted an IMPERSONATED
 * multi-user session and executed. Three of the seventeen routes on the
 * single-user allowlist wrote real side effects that way.
 *
 * This is the FINDING-1 class again: two places answering "what mode is this"
 * differently, where one of them decides whether to check anything at all. The
 * fix makes `isSingleUserMode` ask `isConfirmedSingleUser`, so there is one
 * answer. The static sweep could never have caught it — the middleware WAS
 * present on all seventeen routes; it just said yes.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "h52-shapeb-")
  );
process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER || "shapeb-test-api-key-pepper-32-bytes-min";
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "test-jwt-secret-at-least-12-chars";

const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");
const {
  SINGLE_USER_ONLY_ROUTES,
  buildRouter,
} = require("./routeGateSweep.test.js");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `h52_shapeb_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;
let server;
let baseUrl;
let impersonatedToken;
let ordinaryToken;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    throw new Error("issue 52 integration tests require PostgreSQL");
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
  const { makeJWT } = require("../../../utils/http");

  const admin = await prisma.users.create({
    data: { username: `sb-admin-${dbSuffix}`, password: "unused", role: "admin" },
  });
  const victim = await prisma.users.create({
    data: { username: `sb-victim-${dbSuffix}`, password: "unused", role: "default" },
  });
  // Shape (b): the setting says single-user, the user table disagrees.
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "false" },
    create: { label: "multi_user_mode", value: "false" },
  });
  impersonatedToken = makeJWT({
    id: victim.id,
    username: victim.username,
    impersonatedBy: admin.id,
  });
  // QA-1: the impersonation claim was incidental. These routes carry no
  // requirePermission at all (telegram.js, scheduledJobs.js), so in shape (b)
  // an ORDINARY session reaches them too — nothing about the hole needed
  // view-as-user.
  ordinaryToken = makeJWT({ id: victim.id, username: victim.username });

  const app = express();
  app.use(express.json());
  const built = buildRouter();
  app._router = built.app._router;
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

describe("issue 52: single-user-only routes refuse an impersonated session in shape (b)", () => {
  test("the fixture really is shape (b), or the rest proves nothing", async () => {
    const { SystemSettings } = require("../../../models/systemSettings");
    const {
      isConfirmedSingleUser,
    } = require("../../../utils/authorization/actorResolver");
    // The setting says single-user...
    expect(await SystemSettings.isMultiUserMode()).toBe(false);
    // ...while the evidence says otherwise. This gap IS the vulnerability.
    expect(await isConfirmedSingleUser()).toBe(false);
    expect(await prisma.users.count()).toBeGreaterThan(0);
  });

  test.each([
    ["an impersonated session", () => impersonatedToken],
    ["an ORDINARY session", () => ordinaryToken],
  ])("no single-user-only route answers 2xx to %s", async (_label, token) => {
    const reached = [];
    for (const signature of SINGLE_USER_ONLY_ROUTES) {
      const [method, routePath] = signature.split(" ");
      // Params filled with a value that no row will match: a 404 is a fine
      // answer, a 2xx is not.
      const url = routePath.replace(/:[A-Za-z]+/g, "999999");
      const response = await fetch(`${baseUrl}${url}`, {
        method,
        headers: {
          Authorization: `Bearer ${token()}`,
          "Content-Type": "application/json",
        },
        ...(method === "GET" ? {} : { body: JSON.stringify({}) }),
      });
      if (response.status >= 200 && response.status < 300)
        reached.push(`${signature} → ${response.status}`);
    }
    expect(reached).toEqual([]);
  });
});

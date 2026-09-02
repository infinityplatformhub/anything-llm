/**
 * issue 58 (ruling C): refuse to boot in shape (b).
 *
 * `/request-token` cannot simply swap its predicate — its two branches
 * authenticate against DIFFERENT credentials (a password against the `users`
 * row, versus `process.env.AUTH_TOKEN`), so flipping it would reroute
 * authentication on a legacy instance rather than tighten a check. Refusing to
 * run in the ambiguous state is the fix instead, and it closes the whole class
 * rather than one route.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "h58-boot-")
  );
process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER || "h58-boot-api-key-pepper-32-bytes-minimum";

const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `h58_boot_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;
let assertDeploymentShape;
let DeploymentShapeError;

const setMode = (value) =>
  prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: String(value) },
    create: { label: "multi_user_mode", value: String(value) },
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
  ({
    assertDeploymentShape,
    DeploymentShapeError,
  } = require("../../../utils/boot/assertDeploymentShape"));
}, 300_000);

afterAll(async () => {
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

describe("issue 58: the deployment-shape check", () => {
  test("a genuine single-user instance boots (setting false, no users)", async () => {
    await setMode(false);
    expect(await prisma.users.count()).toBe(0);
    await expect(assertDeploymentShape()).resolves.toBeUndefined();
  });

  test("a genuine multi-user instance boots (setting true, users present)", async () => {
    await setMode(true);
    await prisma.users.create({
      data: { username: `boot-ok-${dbSuffix}`, password: "x" },
    });
    await expect(assertDeploymentShape()).resolves.toBeUndefined();
  });

  test("shape (b) refuses, and the message names BOTH fixes", async () => {
    await setMode(false);
    await prisma.users.create({
      data: { username: `boot-bad-${dbSuffix}`, password: "x" },
    });

    await expect(assertDeploymentShape()).rejects.toBeInstanceOf(
      DeploymentShapeError
    );

    // The message is the whole deliverable of a refuse-to-boot: an operator
    // staring at a stopped server needs to know which way out to take.
    const error = await assertDeploymentShape().catch((e) => e);
    expect(error.message).toMatch(/multi_user_mode/);
    expect(error.message).toMatch(/UPDATE system_settings/);
    expect(error.message).toMatch(/DELETE FROM users/);
  });

  test("an unreadable database does not become 'misconfigured deployment'", async () => {
    // A database outage is a different failure and this check is not entitled
    // to relabel it. It should let the boot proceed and fail where it really
    // fails, rather than telling the operator to edit their settings table.
    await setMode(false);
    const brokenDb = {
      users: {
        count: async () => {
          throw new Error("connection refused");
        },
      },
    };
    await expect(
      assertDeploymentShape({ db: brokenDb })
    ).resolves.toBeUndefined();
  });
});

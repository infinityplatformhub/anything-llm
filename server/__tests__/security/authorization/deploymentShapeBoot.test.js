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
let SystemSettings;

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `h58_boot_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;
let repairDeploymentShape;

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
  ({ SystemSettings } = require("../../../models/systemSettings"));
  ({
    repairDeploymentShape,
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

describe("issue 58: the deployment-shape repair", () => {
  test("a genuine single-user instance is left alone (setting false, no users)", async () => {
    await setMode(false);
    expect(await prisma.users.count()).toBe(0);
    const result = await repairDeploymentShape();
    expect(result.repaired).toBe(false);
    // And the setting is untouched — a repair that "fixes" a correct instance
    // would turn every fresh install into multi-user mode.
    expect(await SystemSettings.isMultiUserMode()).toBe(false);
  });

  test("a genuine multi-user instance is left alone (setting true, users present)", async () => {
    await setMode(true);
    await prisma.users.create({
      data: { username: `boot-ok-${dbSuffix}`, password: "x" },
    });
    const result = await repairDeploymentShape();
    expect(result.repaired).toBe(false);
    expect(await SystemSettings.isMultiUserMode()).toBe(true);
  });

  test("shape (b) is repaired, loudly, with the count in the message", async () => {
    await setMode(false);
    await prisma.users.create({
      data: { username: `boot-bad-${dbSuffix}`, password: "x" },
    });
    delete process.env.MODE_REPAIR_ACKNOWLEDGED;
    const logged = [];
    const realError = console.error;
    console.error = (...args) => logged.push(args.join(" "));

    const result = await repairDeploymentShape();

    console.error = realError;
    expect(result.repaired).toBe(true);
    expect(result.userCount).toBe(1);
    // The repair actually landed, not just reported.
    expect(await SystemSettings.isMultiUserMode()).toBe(true);

    // Loud: silently rewriting a setting that decides who may log in is not a
    // thing to do quietly, and the message has to say how to undo it.
    const message = logged.join("\n");
    expect(message).toMatch(/DEPLOYMENT SHAPE REPAIRED/);
    expect(message).toMatch(/1 user account/);
    expect(message).toMatch(/DELETE FROM users/);
  });

  test("MODE_REPAIR_ACKNOWLEDGED silences the log but not the repair", async () => {
    await setMode(false);
    await prisma.users.create({
      data: { username: `boot-ack-${dbSuffix}`, password: "x" },
    });
    process.env.MODE_REPAIR_ACKNOWLEDGED = "1";
    const logged = [];
    const realError = console.error;
    console.error = (...args) => logged.push(args.join(" "));

    const result = await repairDeploymentShape();

    console.error = realError;
    delete process.env.MODE_REPAIR_ACKNOWLEDGED;
    // Acknowledging the message must not disable the fix it describes.
    expect(result.repaired).toBe(true);
    expect(await SystemSettings.isMultiUserMode()).toBe(true);
    expect(logged.join("\n")).not.toMatch(/DEPLOYMENT SHAPE REPAIRED/);
  });

  test("an unreadable database is not repaired and not relabelled", async () => {
    // An outage is a different failure. This check may not write to a database
    // it could not read, nor tell the operator their deployment is misconfigured.
    await setMode(false);
    const brokenDb = {
      users: {
        count: async () => {
          throw new Error("connection refused");
        },
      },
    };
    const result = await repairDeploymentShape({ db: brokenDb });
    expect(result).toEqual({ repaired: false, reason: "unreadable" });
  });
});

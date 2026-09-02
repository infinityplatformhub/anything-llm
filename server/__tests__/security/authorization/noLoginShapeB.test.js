/**
 * #50 (from #58's ledger): SIMPLE_SSO_NO_LOGIN must still block in shape (b).
 *
 * `simpleSSOLoginDisabledMiddleware` read `SystemSettings.isMultiUserMode()` —
 * the raw setting. In shape (b) (`multi_user_mode = false` WITH user rows) that
 * answers false while `validatedRequest` authenticates real sessions, so the
 * middleware skipped its own restriction: credential login stayed open on an
 * instance whose operator had forbidden it. It fails OPEN, which is why this is
 * the half of #58's sweep that mattered.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "s50-nologin-")
  );
process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER || "s50-nologin-api-key-pepper-32-bytes-ok";

const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `s50_nologin_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;
let simpleSSOLoginDisabledMiddleware;

const runMiddleware = (middleware) =>
  new Promise((resolve) => {
    const response = {
      locals: {},
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        resolve({ response, nextCalled: false });
        return this;
      },
    };
    middleware({}, response, () => resolve({ response, nextCalled: true }));
  });

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
    throw new Error("issue 50 integration tests require PostgreSQL");
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
    simpleSSOLoginDisabledMiddleware,
  } = require("../../../utils/middleware/simpleSSOEnabled"));

  // Shape (b): setting says single-user, the user table says otherwise.
  await prisma.users.create({
    data: { username: `s50-nologin-${dbSuffix}`, password: "unused" },
  });
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "false" },
    create: { label: "multi_user_mode", value: "false" },
  });
}, 300_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  process.env.DATABASE_URL = baseDatabaseUrl;
  const root = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await root.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
  await root.$disconnect();
}, 60_000);

afterEach(() => {
  delete process.env.SIMPLE_SSO_ENABLED;
  delete process.env.SIMPLE_SSO_NO_LOGIN;
});

describe("#50: NO_LOGIN blocks in shape (b)", () => {
  test("the fixture really is shape (b), or nothing below means anything", async () => {
    const {
      SystemSettings,
    } = require("../../../models/systemSettings");
    const {
      isConfirmedSingleUser,
    } = require("../../../utils/authorization/actorResolver");
    expect(await SystemSettings.isMultiUserMode()).toBe(false);
    expect(await isConfirmedSingleUser()).toBe(false);
    expect(await prisma.users.count()).toBeGreaterThan(0);
  });

  test("NO_LOGIN is enforced even though the raw setting says single-user", async () => {
    process.env.SIMPLE_SSO_ENABLED = "1";
    process.env.SIMPLE_SSO_NO_LOGIN = "1";
    const { nextCalled, response } = await runMiddleware(
      simpleSSOLoginDisabledMiddleware
    );
    expect(nextCalled).toBe(false);
    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({
      success: false,
      error: "Login via credentials has been disabled by the administrator.",
    });
  });

  test("without the flags set, the same shape (b) request passes through", async () => {
    // The control: the fix must not turn into "always block". A guard that
    // refused everything would pass the test above while breaking every login.
    const { nextCalled } = await runMiddleware(simpleSSOLoginDisabledMiddleware);
    expect(nextCalled).toBe(true);
  });

  test("SIMPLE_SSO_ENABLED alone does not block — both flags are required", async () => {
    process.env.SIMPLE_SSO_ENABLED = "1";
    const { nextCalled } = await runMiddleware(simpleSSOLoginDisabledMiddleware);
    expect(nextCalled).toBe(true);
  });
});

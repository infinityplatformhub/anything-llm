/**
 * issue 58: every guard that decides WHETHER TO CHECK must ask the same
 * question as the layer that authenticated the request.
 *
 * `SystemSettings.isMultiUserMode()` reads the raw setting.
 * `isConfirmedSingleUser()` requires the setting AND zero user rows. Shape (b)
 * — `multi_user_mode = false` with users present — makes them disagree, and
 * every site that reads the raw setting to decide whether to run a check skips
 * that check while `validatedRequest` (which uses the confirmed helper) is
 * happily authenticating real sessions.
 *
 * Same root cause as issue 52's addendum 7, in four more places.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "h58-")
  );
process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER || "h58-test-api-key-pepper-32-bytes-minimum";
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "test-jwt-secret-at-least-12-chars";

const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `h58_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;
let suspendedUser;
let extensionSecret;

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

  suspendedUser = await prisma.users.create({
    data: {
      username: `h58-suspended-${dbSuffix}`,
      password: "unused",
      role: "default",
      suspended: 1,
    },
  });

  // Shape (b): the setting says single-user, the user table says otherwise.
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "false" },
    create: { label: "multi_user_mode", value: "false" },
  });

  const {
    BrowserExtensionApiKey,
  } = require("../../../models/browserExtensionApiKey");
  const created = await BrowserExtensionApiKey.create(suspendedUser.id);
  extensionSecret = created?.apiKey?.key ?? created?.apiKey?.secret ?? null;
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

const runMiddleware = (middleware, request) =>
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
      sendStatus(code) {
        this.statusCode = code;
        resolve({ response, nextCalled: false });
        return this;
      },
    };
    middleware(request, response, () => resolve({ response, nextCalled: true }));
  });

describe("issue 58: shape (b) does not disable identity checks", () => {
  test("the fixture is shape (b), or nothing below means anything", async () => {
    const { SystemSettings } = require("../../../models/systemSettings");
    const {
      isConfirmedSingleUser,
    } = require("../../../utils/authorization/actorResolver");
    expect(await SystemSettings.isMultiUserMode()).toBe(false);
    expect(await isConfirmedSingleUser()).toBe(false);
    expect(await prisma.users.count()).toBeGreaterThan(0);
  });

  test("B: a suspended user's browser-extension key is refused", async () => {
    expect(extensionSecret).toBeTruthy();
    const {
      validBrowserExtensionApiKey,
    } = require("../../../utils/middleware/validBrowserExtensionApiKey");
    const { nextCalled, response } = await runMiddleware(
      // A scope the extension DOES hold: with document.read the middleware
      // answers 403 "Insufficient scope" and the test passes without ever
      // reaching the suspension check it exists to prove.
      validBrowserExtensionApiKey("browser-extension.read"),
      { header: () => `Bearer ${extensionSecret}` }
    );
    expect(nextCalled).toBe(false);
    expect(response.statusCode).toBe(403);
    expect(response.body).toEqual({ error: "No valid api key found." });
  });

  test("A/B: locals.multiUserMode stays TRUE in shape (b)", async () => {
    // Ruling A/B keeps the local's meaning ("is this multi-user"), inverted
    // from the confirmed helper rather than replaced by it — handlers read this
    // boolean and a flipped meaning would break them silently.
    const {
      validBrowserExtensionApiKey,
    } = require("../../../utils/middleware/validBrowserExtensionApiKey");
    const { response } = await runMiddleware(
      validBrowserExtensionApiKey("browser-extension.read"),
      { header: () => "Bearer nope" }
    );
    expect(response.locals.multiUserMode).toBe(true);
  });

  test("mobile: a registration token for a suspended user is refused", async () => {
    // NOT in the brief's site list. Identical shape: the if (multiUserMode)
    // block is the ONLY place the token's user is loaded and checked, so in
    // shape (b) a token naming a suspended user registers a device.
    const { MobileDevice } = require("../../../models/mobileDevice");
    const {
      validRegistrationToken,
    } = require("../../../endpoints/mobile/middleware");
    // registerTempToken, not createTempToken. The earlier version of this test
    // called a method that does not exist, got undefined, and RETURNED before
    // asserting anything — a green test that tested nothing.
    const token = MobileDevice.registerTempToken(suspendedUser);
    expect(typeof token).toBe("string");

    const { nextCalled } = await runMiddleware(validRegistrationToken, {
      header: () => `Bearer ${token}`,
    });
    expect(nextCalled).toBe(false);
  });
});

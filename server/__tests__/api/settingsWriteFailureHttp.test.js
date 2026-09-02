/**
 * #59: `SystemSettings._updateSettings` catches its own errors and returns
 * `{success: false, error}`. Four callers awaited it bare, so a failed write was
 * indistinguishable from a successful one and execution continued as though it worked:
 *
 *   - `enable-multi-user` created the admin, failed to set `multi_user_mode`, answered
 *     200. The instance is left with user rows and `multi_user_mode: false` — deployment
 *     shape (b), the state #58's boot repair exists to correct.
 *   - the rollback in that handler's own catch block had the same defect, so the
 *     recovery path reported itself as having run while doing nothing.
 *   - `liveSync` started the sync workers and answered 200 for a setting never written.
 *   - `markOnboardingComplete` returned `true` for a flag never written.
 *
 * The recon said shape (b) needed a SIGKILL between two writes. It does not: a failing
 * settings store reaches it through the supported path.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-fail-"));
const schema = `settings_fail_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.API_KEY_PEPPER = "settings-fail-pepper-32-bytes-min";
process.env.SIG_KEY = "settings-fail-sig-key-long-enough-for-scrypt";
process.env.STORAGE_DIR = path.join(tempDir, "storage");
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
  throw new Error("DATABASE_URL must point to PostgreSQL for HTTP tests");
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set("schema", schema);
process.env.DATABASE_URL = databaseUrl.toString();
fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });

const testSchema = path.resolve(__dirname, "../../prisma/schema.prisma");
execFileSync(
  path.resolve(__dirname, "../../node_modules/.bin/prisma"),
  // 7.1a: migrate deploy — the seeded roles requirePermission reads are migration INSERTs.
  ["migrate", "deploy", "--schema", testSchema],
  { cwd: path.resolve(__dirname, "../.."), env: process.env, stdio: "ignore" }
);

jest.mock("../../utils/logger", () => () => {});
jest.mock("../../utils/boot", () => ({ bootHTTP: jest.fn(), bootSSL: jest.fn() }));
jest.mock("../../utils/boot/patchSdkTimeouts", () => jest.fn());
jest.mock("../../utils/AiProviders/modelMap", () => ({
  MODEL_MAP: { get: jest.fn(() => null) },
}));
jest.mock("../../utils/helpers/modelPricing", () => ({
  addChatCostToMetrics: jest.fn((metrics) => metrics),
}));
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn(), flush: jest.fn() },
}));
jest.mock("../../utils/boot/MetaGenerator", () => ({
  MetaGenerator: jest.fn().mockImplementation(() => ({
    generate: jest.fn(),
    generateManifest: jest.fn(),
  })),
}));

const { CommunicationKey } = require("../../utils/comKey");
new CommunicationKey(true);

const request = require("supertest");
const prisma = require("../../utils/prisma");
const { app } = require("../../index");
const { SystemSettings } = require("../../models/systemSettings");
const { makeJWT } = require("../../utils/http");
const { EncryptionManager } = require("../../utils/EncryptionManager");
const { resetRequestControls } = require("../../utils/middleware/requestControls");

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// `enable-multi-user` runs while the instance is still SINGLE-USER — no user rows yet,
// which is the point of the route. Single-user session auth is not a user JWT:
// `validatedRequest` expects a token carrying an encrypted `p` (the AUTH_TOKEN
// password). So the fixture authenticates the way the real operator does.
const operatorToken = () =>
  makeJWT({ p: new EncryptionManager().encrypt(process.env.AUTH_TOKEN) }, "1h");

/** Makes the settings write fail the way a database problem would. */
const failSettingsWrite = () =>
  jest
    .spyOn(prisma.system_settings, "upsert")
    .mockRejectedValue(new Error("system_settings unavailable"));

beforeEach(async () => {
  jest.restoreAllMocks();
  // The login route is rate limited per IP and per account; without this the positive
  // control 429s after the refusal cases have each spent a request.
  await resetRequestControls();
  await prisma.users.deleteMany({});
  await prisma.system_settings.deleteMany({ where: { label: "multi_user_mode" } });
});

describe("(a) enable-multi-user rolls back when the settings write fails", () => {
  const enable = () =>
    request(app)
      .post("/api/system/enable-multi-user")
      .set("Authorization", `Bearer ${operatorToken()}`)
      .send({ username: "first-admin", password: "Pw123456!" });

  it("answers 500 rather than 200", async () => {
    failSettingsWrite();

    const response = await enable();

    expect(response.status).toBe(500);
  });

  it("leaves no user rows behind — the rollback actually ran", async () => {
    // This is deployment shape (b): accounts present, multi_user_mode false. Before #59
    // the handler continued past the failed write, answered 200, and left it.
    failSettingsWrite();
    await enable();

    expect(await prisma.users.count()).toBe(0);
  });

  it("reports the rollback's own failure instead of claiming it ran", async () => {
    // The catch block writes multi_user_mode:false, and the reason we are in the catch
    // is usually that this same write is failing. Unchecked, the recovery path claimed
    // to have run while doing nothing.
    const errors = [];
    const spy = jest
      .spyOn(console, "error")
      .mockImplementation((...args) => errors.push(args.map(String).join(" ")));
    failSettingsWrite();

    await enable();

    spy.mockRestore();
    expect(errors.join("\n")).toMatch(/MULTI-USER ROLLBACK FAILED/);
    expect(errors.join("\n")).toMatch(/shape \(b\)/);
  });

  it("still succeeds when the settings write works (positive control)", async () => {
    // Without this, every assertion above is equally consistent with a route that is
    // simply broken for everyone.
    const response = await enable();

    expect(response.status).toBe(200);
    expect(await prisma.users.count()).toBe(1);
    expect(await SystemSettings.isMultiUserMode()).toBe(true);
  });
});

describe("(c) markOnboardingComplete reports a failed write", () => {
  it("returns false rather than true", async () => {
    failSettingsWrite();

    expect(await SystemSettings.markOnboardingComplete()).toBe(false);
  });

  it("returns true when the write succeeds (positive control)", async () => {
    expect(await SystemSettings.markOnboardingComplete()).toBe(true);
    const row = await prisma.system_settings.findFirst({
      where: { label: "onboarding_complete" },
    });
    expect(row?.value).toBe("true");
  });
});

describe("M10: /request-token never answers 500 for a bad login", () => {
  // `bcrypt.compareSync` throws when either argument is not a string. Two ways in: no
  // AUTH_TOKEN configured, or a request that omits `password`. Both used to be 500,
  // which tells a caller something broke here — and is not true.
  const login = (body) => request(app).post("/api/request-token").send(body);

  it("a request with no password field is 401, not 500", async () => {
    expect(process.env.AUTH_TOKEN).toBeTruthy(); // the interesting case: token IS set
    const response = await login({});

    expect(response.status).toBe(401);
    expect(response.body.message).toMatch(/\[003\]/);
  });

  it("a non-string password is 401, not 500", async () => {
    const response = await login({ password: { nested: "object" } });

    expect(response.status).toBe(401);
    expect(response.body.message).toMatch(/\[003\]/);
  });

  it("no AUTH_TOKEN configured is 401, not 500", async () => {
    const original = process.env.AUTH_TOKEN;
    delete process.env.AUTH_TOKEN;

    const response = await login({ password: "anything" });

    if (original === undefined) delete process.env.AUTH_TOKEN;
    else process.env.AUTH_TOKEN = original;
    expect(response.status).toBe(401);
    expect(response.body.message).toMatch(/\[003\]/);
  });

  it("the refusals are indistinguishable from a wrong password", async () => {
    // If they differ, the status or body becomes an oracle for whether the instance has
    // a password set at all.
    const wrong = await login({ password: "definitely-not-the-password" });
    const missing = await login({});

    expect(wrong.status).toBe(missing.status);
    expect(wrong.body.message).toBe(missing.body.message);
  });

  it("the correct password still works (positive control)", async () => {
    const response = await login({ password: process.env.AUTH_TOKEN });

    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(true);
  });
});

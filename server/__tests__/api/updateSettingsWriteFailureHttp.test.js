/**
 * #70: `updateSettings` resolves `{success:false, error}` when its write fails. These
 * routes used to ignore that result and answer 200, so drive both public surfaces through
 * real auth and routing while making only the settings store fail.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "update-settings-fail-"));
const schema = `update_settings_fail_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.API_KEY_PEPPER = "update-settings-fail-pepper-32-bytes";
process.env.SIG_KEY = "update-settings-fail-sig-key-long-enough";
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
const bcrypt = require("bcryptjs");
const prisma = require("../../utils/prisma");
const { app } = require("../../index");
const { SystemSettings } = require("../../models/systemSettings");
const { ApiKey } = require("../../models/apiKeys");
const { makeJWT } = require("../../utils/http");
const repository = require("../../utils/authorization/policyRepository");
const { SERVICE_PRINCIPALS } = require("../../utils/authorization/actorResolver");

let admin;
let apiSecret;
const auth = () => `Bearer ${makeJWT({ id: admin.id, username: admin.username })}`;
const uiUpdate = () =>
  request(app)
    .post("/api/admin/system-preferences")
    .set("Authorization", auth())
    .send({ support_email: "ops@example.com" });
const apiUpdate = () =>
  request(app)
    .post("/api/v1/admin/preferences")
    .set("Authorization", `Bearer ${apiSecret}`)
    .send({ support_email: "ops@example.com" });

beforeAll(async () => {
  admin = await prisma.users.create({
    data: {
      username: "settings-write-admin",
      password: bcrypt.hashSync("Pw123456!", 10),
      role: "admin",
    },
  });
  const role = await prisma.roles.findFirst({
    where: { name: "super_admin", scope: "org" },
  });
  await repository.grantRole({
    actor: SERVICE_PRINCIPALS.singleUser,
    principalType: "user",
    principalId: String(admin.id),
    roleId: role.id,
    db: prisma,
  });
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });
  const created = await ApiKey.create(admin.id, "settings-writer", {
    scopes: ["system.write"],
  });
  if (!created.apiKey) throw new Error(created.error);
  apiSecret = created.apiKey.secret;
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => jest.restoreAllMocks());

const failSettingsWrite = () =>
  jest.spyOn(SystemSettings, "_updateSettings").mockResolvedValue({
    success: false,
    error: "system_settings unavailable",
  });

describe("settings preference routes report failed writes", () => {
  test.each([
    ["admin route", uiUpdate],
    ["v1 route", apiUpdate],
  ])("%s answers 500 with the settings error", async (_name, update) => {
    failSettingsWrite();

    const response = await update();

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      success: false,
      error: "system_settings unavailable",
    });
  });

  test.each([
    ["admin route", uiUpdate],
    ["v1 route", apiUpdate],
  ])("%s still answers 200 after a successful write", async (_name, update) => {
    const response = await update();

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, error: null });
  });
});

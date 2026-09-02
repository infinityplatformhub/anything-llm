/** Drive every affected route through real auth and routing so status mapping,
 * all-or-nothing writes, and model failure handling are exercised together. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "unknown-key-refusal-"));
const schema = `unknown_key_refusal_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.API_KEY_PEPPER = "unknown-key-refusal-pepper-32-bytes";
process.env.SIG_KEY = "unknown-key-refusal-sig-key-long-enough";
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
let manager;
let apiSecret;
const auth = () => `Bearer ${makeJWT({ id: admin.id, username: admin.username })}`;
const managerAuth = () =>
  `Bearer ${makeJWT({ id: manager.id, username: manager.username })}`;
const routes = [
  ["admin route", "/api/admin/system-preferences", () => auth(), (body) => body],
  ["v1 route", "/api/v1/admin/preferences", () => `Bearer ${apiSecret}`, (body) => body],
  ["community hub route", "/api/community-hub/settings", () => auth(), (body) => body],
  [
    "default system prompt route",
    "/api/system/default-system-prompt",
    () => auth(),
    (body) => ({ defaultSystemPrompt: body.default_system_prompt }),
  ],
];
const update = (path, authorization, body) =>
  request(app).post(path).set("Authorization", authorization()).send(body);

beforeAll(async () => {
  admin = await prisma.users.create({
    data: {
      username: "unknown-key-admin",
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
  manager = await prisma.users.create({
    data: {
      username: "unknown-key-manager",
      password: bcrypt.hashSync("Pw123456!", 10),
      role: "manager",
    },
  });
  const managerRole = await prisma.roles.findFirstOrThrow({
    where: { name: "setup_admin", scope: "org" },
  });
  await repository.grantRole({
    actor: SERVICE_PRINCIPALS.singleUser,
    principalType: "user",
    principalId: String(manager.id),
    roleId: managerRole.id,
    db: prisma,
  });
  const created = await ApiKey.create(admin.id, "unknown-key-writer", {
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

describe("unknown settings keys over HTTP", () => {
  const directRoutes = [
    ["admin route", "/api/admin/system-preferences", () => auth()],
    ["v1 route", "/api/v1/admin/preferences", () => `Bearer ${apiSecret}`],
  ];
  const snapshotSettings = async () =>
    JSON.stringify(
      await prisma.system_settings.findMany({ orderBy: { id: "asc" } })
    );

  test.each(directRoutes)(
    "%s rejects mixed keys without changing any database row",
    async (_name, path, authorization) => {
      await prisma.system_settings.upsert({
        where: { label: "support_email" },
        update: { value: "already@example.com" },
        create: { label: "support_email", value: "already@example.com" },
      });
      const before = await snapshotSettings();

      const response = await update(path, authorization, {
        not_a_real_key: "x",
        support_email: "already@example.com",
      });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        success: false,
        code: "unknown_keys",
        unknownKeys: ["not_a_real_key"],
        unknownKeyCount: 1,
      });
      expect(await snapshotSettings()).toBe(before);
    }
  );

  test.each(directRoutes)(
    "%s rejects an all-unknown body",
    async (_name, path, authorization) => {
      const response = await update(path, authorization, {
        not_a_real_key: "x",
      });

      expect(response.status).toBe(400);
      expect(response.body.unknownKeys).toEqual(["not_a_real_key"]);
    }
  );

  test.each(directRoutes)(
    "%s accepts and writes an all-valid body",
    async (_name, path, authorization) => {
      const response = await update(path, authorization, {
        support_email: "valid@example.com",
      });

      expect(response.status).toBe(200);
      await expect(
        prisma.system_settings.findUnique({ where: { label: "support_email" } })
      ).resolves.toMatchObject({ value: "valid@example.com" });
    }
  );

  test("community hub rejects unknown keys outside its 500 catch path", async () => {
    const response = await update("/api/community-hub/settings", () => auth(), {
      not_a_real_key: "x",
    });

    expect(response.status).toBe(400);
    expect(response.status).not.toBe(500);
    expect(response.body).toMatchObject({
      code: "unknown_keys",
      unknownKeys: ["not_a_real_key"],
    });
  });

  test("every protected and supported key remains writable", async () => {
    const overlap = SystemSettings.protectedFields.filter((key) =>
      SystemSettings.supportedFields.includes(key)
    );
    expect(overlap.length).toBeGreaterThan(0);

    for (const key of overlap) {
      await expect(
        SystemSettings.updateSettings({ [key]: "overlap-value" })
      ).resolves.toEqual({ success: true, error: null });
      await expect(
        prisma.system_settings.findUnique({ where: { label: key } })
      ).resolves.toMatchObject({ value: "overlap-value" });
    }
  });

  test("community hub writes its supported API key", async () => {
    const response = await update(
      "/api/community-hub/settings",
      () => auth(),
      { hub_api_key: "community-key" }
    );

    expect(response.status).toBe(200);
    await expect(
      prisma.system_settings.findUnique({ where: { label: "hub_api_key" } })
    ).resolves.toMatchObject({ value: "community-key" });
  });

  test("manager unknown keys stay silent and write no rows", async () => {
    const before = await snapshotSettings();

    const response = await update(
      "/api/admin/system-preferences",
      managerAuth,
      { not_a_real_key: "x" }
    );

    expect(response.status).toBe(200);
    expect(await snapshotSettings()).toBe(before);
  });

  test.each(["__proto__", "constructor", "prototype"])(
    "%s remains unpolluted through parsed HTTP JSON",
    async (key) => {
      const response = await request(app)
        .post("/api/v1/admin/preferences")
        .set("Authorization", `Bearer ${apiSecret}`)
        .set("Content-Type", "application/json")
        .send(`{"${key}":{"x":"polluted"}}`);

      expect(response.status).toBe(400);
      expect(response.body.unknownKeys).toEqual([key]);
      expect({}.x).toBeUndefined();
    }
  );

  test.each(routes)(
    "%s maps typed refusal failures to 400",
    async (_name, path, authorization, bodyFor) => {
      jest.spyOn(SystemSettings, "updateSettings").mockResolvedValue({
        success: false,
        error: "Protected setting keys: multi_user_mode",
        code: "protected_keys",
        protectedKeys: ["multi_user_mode"],
      });

      const response = await update(
        path,
        authorization,
        bodyFor({ not_a_real_key: "x", default_system_prompt: "prompt" })
      );

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        success: false,
        code: "protected_keys",
        protectedKeys: ["multi_user_mode"],
      });
    }
  );

  test.each(routes)(
    "%s keeps settings write failures at 500",
    async (_name, path, authorization, bodyFor) => {
      failSettingsWrite();

      const response = await update(
        path,
        authorization,
        bodyFor({
          support_email: "ops@example.com",
          default_system_prompt: "prompt",
        })
      );

      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.error || response.body.message).toBe(
        "system_settings unavailable"
      );
    }
  );

  test("default system prompt exposes the model error as its HTTP message", async () => {
    failSettingsWrite();

    const response = await update(
      "/api/system/default-system-prompt",
      () => auth(),
      { defaultSystemPrompt: "prompt" }
    );

    expect(response.status).toBe(500);
    expect(response.body.message).toBe("system_settings unavailable");
  });
});

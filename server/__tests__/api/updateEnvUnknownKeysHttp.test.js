/** Exercise updateENV refusal and status mapping through real auth and routing. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "update-env-unknown-"));
const schema = `update_env_unknown_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.API_KEY_PEPPER = "update-env-unknown-pepper-32-bytes";
process.env.SIG_KEY = "update-env-unknown-sig-key-long-enough";
process.env.STORAGE_DIR = path.join(tempDir, "storage");
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
  throw new Error("DATABASE_URL must point to PostgreSQL for HTTP tests");
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set("schema", schema);
process.env.DATABASE_URL = databaseUrl.toString();
fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });

const serverRoot = path.resolve(__dirname, "../..");
execFileSync(
  path.join(serverRoot, "node_modules/.bin/prisma"),
  ["migrate", "deploy", "--schema", path.join(serverRoot, "prisma/schema.prisma")],
  { cwd: serverRoot, env: process.env, stdio: "ignore" }
);
execFileSync(process.execPath, [path.join(serverRoot, "prisma/seed.js")], {
  cwd: serverRoot,
  env: process.env,
  stdio: "ignore",
});

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
const { ApiKey } = require("../../models/apiKeys");
const { makeJWT } = require("../../utils/http");
const { KEY_MAPPING } = require("../../utils/helpers/updateENV");
const { Telemetry } = require("../../models/telemetry");
const { CredentialStore } = require("../../models/credentialStore");

let admin;
let manager;
let apiSecret;
const webAuth = (user) =>
  `Bearer ${makeJWT({ id: user.id, username: user.username })}`;
const post = (route, authorization, body) =>
  request(app).post(route).set("Authorization", authorization).send(body);
const routes = [
  ["admin route", "/api/system/update-env", () => webAuth(admin)],
  ["v1 route", "/api/v1/system/update-env", () => `Bearer ${apiSecret}`],
];

function unknownKey(suffix = "") {
  let key = `issue_91_unknown_${suffix}`;
  while (Object.hasOwn(KEY_MAPPING, key)) key += "_unknown";
  return key;
}

beforeAll(async () => {
  const { syncLegacyRoleGrant } = require("../../utils/authorization/legacyRoleGrants");
  admin = await prisma.users.create({
    data: {
      username: "update-env-admin",
      password: bcrypt.hashSync("Pw123456!", 10),
      role: "admin",
    },
  });
  manager = await prisma.users.create({
    data: {
      username: "update-env-manager",
      password: bcrypt.hashSync("Pw123456!", 10),
      role: "manager",
    },
  });
  await syncLegacyRoleGrant(admin, { db: prisma });
  await syncLegacyRoleGrant(manager, { db: prisma });
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });
  const created = await ApiKey.create(admin.id, "update-env-writer", {
    scopes: ["system.write"],
  });
  if (!created.apiKey) throw new Error(created.error);
  apiSecret = created.apiKey.secret;
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.LLM_PROVIDER;
  delete process.env.OPEN_AI_KEY;
  delete process.env.DISABLE_TELEMETRY;
});

describe("update environment unknown keys over HTTP", () => {
  test.each(routes)("%s rejects an all-unknown body", async (_name, route, authorization) => {
    const key = unknownKey("only");
    const response = await post(route, authorization(), { [key]: "x" });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      newValues: {},
      code: "unknown_keys",
      unknownKeys: [key],
      unknownKeyCount: 1,
    });
    expect(response.body.error).toContain(key);
  });

  test.each(routes)("%s rejects mixed keys without writing valid values", async (_name, route, authorization) => {
    // OpenAiKey is `secret: true`, so a write persists a row in the credential store.
    // Reading that row back is what proves nothing was written: process.env alone is
    // in-memory and a refusal placed after the write loop would still leave the row.
    const stored = "sk-stored-before-the-refusal";
    await CredentialStore.set("OPEN_AI_KEY", stored);

    const response = await post(route, authorization(), {
      [unknownKey("mixed")]: "x",
      LLMProvider: "openai",
      OpenAiKey: "sk-must-never-be-persisted",
    });

    expect(response.status).toBe(400);
    expect(await CredentialStore.get("OPEN_AI_KEY")).toBe(stored);
    expect(process.env.LLM_PROVIDER).toBeUndefined();

    await CredentialStore.delete("OPEN_AI_KEY");
  });

  test.each(routes)("%s accepts and writes an all-valid body", async (_name, route, authorization) => {
    const response = await post(route, authorization(), {
      LLMProvider: "openai",
    });

    expect(response.status).toBe(200);
    expect(response.body.error).toBe(false);
    expect(process.env.LLM_PROVIDER).toBe("openai");
  });

  it("keeps a masked placeholder without treating it as unknown or overwriting it", async () => {
    process.env.OPEN_AI_KEY = "stored-openai-key";

    const response = await post(
      "/api/system/update-env",
      webAuth(admin),
      { OpenAiKey: "****" }
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ newValues: {}, error: false });
    expect(process.env.OPEN_AI_KEY).toBe("stored-openai-key");
  });

  test.each(routes)("%s maps a validation error to 500", async (_name, route, authorization) => {
    const response = await post(route, authorization(), {
      LLMProvider: "not-a-provider",
    });

    expect(response.status).toBe(500);
    expect(response.body.error).toBeTruthy();
  });

  it("refuses a manager before updateENV runs", async () => {
    const response = await post(
      "/api/system/update-env",
      webAuth(manager),
      { LLMProvider: "openai" }
    );

    expect(response.status).toBe(403);
    expect(process.env.LLM_PROVIDER).toBeUndefined();
  });

  it("checks unknown keys before preUpdate hooks", async () => {
    const response = await post(
      "/api/system/update-env",
      webAuth(admin),
      { DisableTelemetry: "true", [unknownKey("ordering")]: "x" }
    );

    expect(response.status).toBe(400);
    expect(Telemetry.sendTelemetry).not.toHaveBeenCalled();
    expect(process.env.DISABLE_TELEMETRY).toBeUndefined();
  });

  it("caps reflected keys and truncates by Unicode code points", async () => {
    const keys = [
      "a".repeat(63),
      "b".repeat(64),
      "c".repeat(65),
      "😀".repeat(64),
    ];
    while (keys.length < 60) keys.push(unknownKey(`cap_${keys.length}`));
    const body = Object.fromEntries(keys.map((key) => [key, "x"]));

    const response = await post("/api/system/update-env", webAuth(admin), body);

    expect(response.status).toBe(400);
    expect(response.body.unknownKeyCount).toBe(60);
    expect(response.body.unknownKeys).toHaveLength(50);
    expect(response.body.unknownKeys[0]).toBe(keys[0]);
    expect(response.body.unknownKeys[1]).toBe(keys[1]);
    expect([...response.body.unknownKeys[1]]).toHaveLength(64);
    expect(response.body.unknownKeys[2]).toBe(`${"c".repeat(64)}…`);
    expect([...response.body.unknownKeys[2]]).toHaveLength(65);
    expect(response.body.unknownKeys[3]).toBe(keys[3]);
    expect([...response.body.unknownKeys[3]]).toHaveLength(64);
  });

  it("keeps fixed-key bodies in password and multi-user routes", () => {
    const source = fs.readFileSync(path.join(serverRoot, "endpoints/system.js"), "utf8");
    const passwordBranch = source.slice(
      source.indexOf('app.post(\n    "/system/update-password"'),
      source.indexOf('app.post(\n    "/system/enable-multi-user"')
    );
    const multiUserBranch = source.slice(
      source.indexOf('app.post(\n    "/system/enable-multi-user"'),
      source.indexOf('app.post(\n    "/system/disable-multi-user"')
    );

    // #116 reordered these two keys (JWTSecret first, so a store failing on its FIRST write
    // leaves the recoverable half rather than the one that opens the instance). This test's
    // subject is that the key set is FIXED and hardcoded — not caller-controlled — so it is
    // asserted per key rather than as one ordered literal. Pinning the order here would make
    // an unrelated safety improvement look like a regression.
    expect(passwordBranch).toMatch(/updateENV\(\s*\{/);
    expect(passwordBranch).toMatch(/AuthToken: newPassword,/);
    expect(passwordBranch).toMatch(/JWTSecret: v4\(\),/);
    // And nothing caller-derived reaches the key set: the only names passed are these two.
    const passwordCall = passwordBranch.slice(
      passwordBranch.indexOf("updateENV("),
      passwordBranch.indexOf("true\n          );")
    );
    expect(passwordCall.match(/^\s*\w+:/gm).map((k) => k.trim()).sort()).toEqual([
      "AuthToken:",
      "JWTSecret:",
    ]);
    expect(multiUserBranch).toMatch(/updateENV\(\s*\{\s*JWTSecret: process\.env\.JWT_SECRET \|\| v4\(\),\s*\}/);
  });
});

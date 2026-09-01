/**
 * #8 QA-2 round 3: HTTP-level proof of the SSO issuance lock, adapted from
 * QA-2's pattern-8 exploit file. Fires real requests through the full app
 * (require("../index")), counts temporary_auth_tokens rows, and checks
 * response BODIES to prove which middleware rejected the call — the lock's
 * 403 and validApiKey's 403 are indistinguishable by status alone.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sso-http-"));
const schema = `sso_http_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.STORAGE_DIR = path.join(tempDir, "storage");
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith("postgresql://")) {
  throw new Error("DATABASE_URL must point to PostgreSQL for HTTP tests");
}
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set("schema", schema);
process.env.DATABASE_URL = databaseUrl.toString();
fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });

const testSchema = path.resolve(__dirname, "../prisma/schema.prisma");
execFileSync(
  path.resolve(__dirname, "../node_modules/.bin/prisma"),
  ["db", "push", "--skip-generate", "--schema", testSchema],
  { cwd: path.resolve(__dirname, ".."), env: process.env, stdio: "ignore" }
);

jest.mock("../utils/logger", () => () => {});
jest.mock("../utils/boot", () => ({ bootHTTP: jest.fn(), bootSSL: jest.fn() }));
jest.mock("../utils/boot/patchSdkTimeouts", () => jest.fn());
jest.mock("../utils/AiProviders/modelMap", () => ({
  MODEL_MAP: { get: jest.fn(() => null) },
}));
jest.mock("../utils/helpers/modelPricing", () => ({
  addChatCostToMetrics: jest.fn((m) => m),
}));
jest.mock("../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn(), flush: jest.fn() },
}));
jest.mock("../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn().mockResolvedValue(true) },
}));
jest.mock("../utils/helpers", () => ({
  ...jest.requireActual("../utils/helpers"),
  getVectorDbClass: jest.fn(() => ({
    name: "fake-vector-db",
    namespaceCount: jest.fn(async () => 0),
  })),
  resolveProviderConnector: jest.fn(async () => ({
    connector: {},
    routingMetadata: null,
  })),
}));
jest.mock("../utils/boot/MetaGenerator", () => ({
  MetaGenerator: jest.fn().mockImplementation(() => ({
    generate: jest.fn(),
    generateManifest: jest.fn(),
  })),
}));

const { CommunicationKey } = require("../utils/comKey");
new CommunicationKey(true);

const request = require("supertest");
const bcrypt = require("bcryptjs");
const prisma = require("../utils/prisma");
const { app } = require("../index");

const FLAG = "SIMPLE_SSO_ISSUE_UNSAFE_ALLOW";
const setFlag = (v) =>
  v === undefined ? delete process.env[FLAG] : (process.env[FLAG] = v);
const tokenRows = () => prisma.temporary_auth_tokens.count();

let apiKeySecret, targetAdmin;

beforeAll(async () => {
  const existing = await prisma.system_settings.findFirst({
    where: { label: "multi_user_mode" },
  });
  if (existing)
    await prisma.system_settings.update({
      where: { id: existing.id },
      data: { value: "true" },
    });
  else
    await prisma.system_settings.create({
      data: { label: "multi_user_mode", value: "true" },
    });
  process.env.SIMPLE_SSO_ENABLED = "true";

  const mkUser = (username, role) =>
    prisma.users.create({
      data: { username, password: bcrypt.hashSync("Pw123456!", 10), role },
    });
  const caller = await mkUser("caller-admin", "admin");
  targetAdmin = await mkUser("target-admin", "admin");
  const { ApiKey } = require("../models/apiKeys");
  const { apiKey } = await ApiKey.create(caller.id, "test key");
  apiKeySecret = apiKey.secret;
});
afterEach(() => setFlag(undefined));
afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("SSO issuance lock over HTTP - QA-2 issue 8", () => {
  it("valid key + lock closed → 403 with lock's body AND zero token rows", async () => {
    setFlag(undefined);
    const before = await tokenRows();
    const res = await request(app)
      .get(`/api/v1/users/${targetAdmin.id}/issue-auth-token`)
      .set("Authorization", `Bearer ${apiKeySecret}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/disabled pending/i);
    expect(await tokenRows()).toBe(before);
  });

  it("no auth header → lock body, not validApiKey body (lock runs FIRST)", async () => {
    setFlag(undefined);
    const res = await request(app).get(
      `/api/v1/users/${targetAdmin.id}/issue-auth-token`
    );
    expect(res.body.error).toMatch(/disabled pending/i);
    expect(res.body.error).not.toMatch(/No valid api key found/i);
  });

  it("lock open + garbage key → validApiKey rejects (chain continues)", async () => {
    setFlag("1");
    const res = await request(app)
      .get(`/api/v1/users/${targetAdmin.id}/issue-auth-token`)
      .set("Authorization", "Bearer not-a-real-key");
    expect(res.body.error).toMatch(/No valid api key found/i);
  });

  it('flag = "disabled" (operator intent: off) stays CLOSED — allowlist proof', async () => {
    setFlag("disabled");
    const before = await tokenRows();
    const res = await request(app)
      .get(`/api/v1/users/${targetAdmin.id}/issue-auth-token`)
      .set("Authorization", `Bearer ${apiKeySecret}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/disabled pending/i);
    expect(await tokenRows()).toBe(before);
  });

  it("positive control: flag=1 mints; exchange works once then single-use rejects", async () => {
    setFlag("1");
    const mint = await request(app)
      .get(`/api/v1/users/${targetAdmin.id}/issue-auth-token`)
      .set("Authorization", `Bearer ${apiKeySecret}`);
    expect(mint.status).toBe(200);
    const t = mint.body.token;
    const ex1 = await request(app).get(
      `/api/request-token/sso/simple?token=${encodeURIComponent(t)}`
    );
    expect(ex1.status).toBe(200);
    const ex2 = await request(app).get(
      `/api/request-token/sso/simple?token=${encodeURIComponent(t)}`
    );
    expect(ex2.status).toBe(401);
  });
});

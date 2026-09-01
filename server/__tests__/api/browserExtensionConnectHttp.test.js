const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-extension-http-"));
const schema = `browser_extension_http_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.STORAGE_DIR = path.join(tempDir, "storage");
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith("postgresql:")) {
  throw new Error("DATABASE_URL must point to PostgreSQL for HTTP tests");
}
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set("schema", schema);
process.env.DATABASE_URL = databaseUrl.toString();
process.env.API_KEY_PEPPER = "http-test-api-key-pepper-32-bytes";
fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });

const testSchema = path.resolve(__dirname, "../../prisma/schema.prisma");
execFileSync(
  path.resolve(__dirname, "../../node_modules/.bin/prisma"),
  ["db", "push", "--skip-generate", "--schema", testSchema],
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
jest.mock("../../utils/helpers", () => ({
  ...jest.requireActual("../../utils/helpers"),
  getVectorDbClass: jest.fn(() => ({
    name: "fake-vector-db",
    namespaceCount: jest.fn(async () => 0),
  })),
  resolveProviderConnector: jest.fn(async () => ({ connector: {}, routingMetadata: null })),
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
const { BrowserExtensionApiKey } = require("../../models/browserExtensionApiKey");
const { resetRequestControls } = require("../../utils/middleware/requestControls");

beforeAll(async () => {
  await resetRequestControls();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("browser extension checks connection", async () => {
  const { apiKey } = await BrowserExtensionApiKey.create();

  const response = await request(app)
    .get("/api/browser-extension/check")
    .set("Authorization", `Bearer ${apiKey.secret}`);

  expect(response.status).toBe(200);
  expect(response.body.apiKeyId).toBe(apiKey.id);
});

test("browser extension disconnects and revokes key", async () => {
  const { apiKey } = await BrowserExtensionApiKey.create();

  const response = await request(app)
    .delete("/api/browser-extension/disconnect")
    .set("Authorization", `Bearer ${apiKey.secret}`);

  expect(response.status).toBe(200);
  expect(await BrowserExtensionApiKey.get({ id: apiKey.id })).toBeNull();
});

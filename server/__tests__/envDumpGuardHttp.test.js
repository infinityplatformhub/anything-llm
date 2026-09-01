/**
 * #10 QA-2 round 3: HTTP-level guard proof for internal GET /api/env-dump,
 * from QA-2's pattern-10. Six personas in multi-user mode, plus single-user
 * mode (flexUserRoleValid bypass territory). Node env-dump early-returns 200
 * outside production, so these assertions never touch the real .env file.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "envdump-http-"));
const schema = `envdump_http_${process.pid}`;
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
process.env.API_KEY_PEPPER = "http-test-api-key-pepper-32-bytes";
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
const { resetRequestControls } = require("../utils/middleware/requestControls");
const { makeJWT } = require("../utils/http");

const auth = (user) =>
  `Bearer ${makeJWT({ id: user.id, username: user.username })}`;

async function setMultiUserMode(on) {
  const existing = await prisma.system_settings.findFirst({
    where: { label: "multi_user_mode" },
  });
  if (existing)
    await prisma.system_settings.update({
      where: { id: existing.id },
      data: { value: String(on) },
    });
  else
    await prisma.system_settings.create({
      data: { label: "multi_user_mode", value: String(on) },
    });
}

const mkUser = (username, role) =>
  prisma.users.create({
    data: { username, password: bcrypt.hashSync("Pw123456!", 10), role },
  });

let admin, manager, plain;

beforeAll(async () => {
  await resetRequestControls();
  admin = await mkUser("p-admin", "admin");
  manager = await mkUser("p-manager", "manager");
  plain = await mkUser("p-plain", "default");
  const { digestSecret, keyPrefix } = require("../utils/apiKeySecurity");
  const secret = "apw-key-a-valid-api-key";
  await prisma.api_keys.create({
    data: { name: "k", secretDigest: digestSecret(secret), keyPrefix: keyPrefix(secret), scopes: JSON.stringify(["*"]) },
  });
});
afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("internal /api/env-dump — multi-user", () => {
  beforeAll(() => setMultiUserMode(true));

  it.each([
    ["no credential", undefined, 401],
    ["manager JWT", () => auth(manager), 401],
    ["default JWT", () => auth(plain), 401],
    ["API key (not a session)", () => "Bearer apw-key-a-valid-api-key", 401],
    [
      "forged JWT for ghost user",
      () => `Bearer ${makeJWT({ id: 99999, username: "ghost" })}`,
      401,
    ],
    ["admin JWT (positive control)", () => auth(admin), 200],
  ])("%s → %i", async (_label, header, expected) => {
    const req = request(app).get("/api/env-dump");
    if (header) req.set("Authorization", header());
    expect((await req).status).toBe(expected);
  });
});

describe("internal /api/env-dump — SINGLE-user (flexUserRoleValid bypass territory)", () => {
  beforeAll(() => setMultiUserMode(false));

  it("unauth still rejected", async () => {
    expect((await request(app).get("/api/env-dump")).status).toBe(401);
  });
  it("garbage bearer still rejected", async () => {
    const res = await request(app)
      .get("/api/env-dump")
      .set("Authorization", "Bearer garbage");
    expect(res.status).toBe(401);
  });
});

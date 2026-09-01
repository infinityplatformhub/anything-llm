const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "eventlogs-http-"));
const schema = `eventlogs_http_${process.pid}`;
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
// T-4a (#25): `db push` creates tables but runs no seed, so the roles and
// permissions the engine reads would not exist and every request would 403.
// Authorization is now part of the HTTP path, so the seed is part of the world
// these suites need.
execFileSync(
  process.execPath,
  [path.resolve(__dirname, "../../prisma/seed.js")],
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
  resolveProviderConnector: jest.fn(async () => ({
    connector: {},
    routingMetadata: null,
  })),
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
const { resetRequestControls } = require("../../utils/middleware/requestControls");
const { makeJWT } = require("../../utils/http");

let authorization;

// T-4a (#25): raw `prisma.users.create` bypasses `User.create`, which is where
// the legacy-role -> grant sync lives. The engine reads grants, so a fixture
// user must be granted the same way production grants.
async function grantLegacyRole(prisma, user) {
  const {
    syncLegacyRoleGrant,
  } = require("../../utils/authorization/legacyRoleGrants");
  await syncLegacyRoleGrant(user, { db: prisma });
}

beforeAll(async () => {
  await resetRequestControls();
  // upsert: the seed already writes this label (T-4a added the seed run above)
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });
  // T-4a: raw prisma.users.create bypasses User.create, which is where the
  // legacy role -> grant sync lives. The engine reads grants, so the fixture
  // must grant like production does.
  const admin = await prisma.users.create({
    data: {
      username: "event-logs-admin",
      password: bcrypt.hashSync("Pw123456!", 10),
      role: "admin",
    },
  });
  await grantLegacyRole(prisma, admin);
  authorization = `Bearer ${makeJWT({ id: admin.id, username: admin.username })}`;
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("admin reads event logs", async () => {
  const response = await request(app)
    .post("/api/system/event-logs")
    .set("Authorization", authorization)
    .send({ offset: 0, limit: 10 });

  expect(response.status).toBe(200);
  expect(Array.isArray(response.body.logs)).toBe(true);
  expect(typeof response.body.totalLogs).toBe("number");
});

test("admin clears event logs", async () => {
  const response = await request(app)
    .delete("/api/system/event-logs")
    .set("Authorization", authorization);

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ success: true });
});

/**
 * PR-4c over the real HTTP stack: a row that still says `["*"]` opens nothing.
 *
 * The model refuses to mint one now (`validateScopes`) and the migration rewrites the
 * ones already in the table, so the only way such a row exists is a direct write —
 * a partially applied migration, a restored backup, an operator with SQL access.
 * That is exactly the case worth proving, and it is why the fixture goes in with raw
 * SQL rather than through `ApiKey.create`: a test that could not create the bad row
 * would be testing the model's guard a second time, not the middleware's.
 *
 * The key's creator is an admin holding every legacy grant, so a 403 here can only
 * come from the scope half. The positive control at the end rewrites the same row to
 * a named scope list and expects 200 — without it, a broken fixture would look
 * identical to a working refusal.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wildcard-key-"));
const schema = `wildcard_key_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.API_KEY_PEPPER = "wildcard-key-test-pepper-32-bytes";
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
  // §7.1a: `migrate deploy`, not `db push` — the roles and permissions the engine
  // reads are migration INSERTs, and without them every route 403s for the wrong reason.
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
const { digestSecret, keyPrefix } = require("../../utils/apiKeySecurity");
const {
  ADMIN_DEFAULT_SCOPES,
} = require("../../utils/apiKeySecurity/scopes");
const {
  syncLegacyRoleGrant,
} = require("../../utils/authorization/legacyRoleGrants");

const SECRET = "apw-key-legacy-wildcard-row-AAAAAAAAAAAA";
const bearer = () => ["Authorization", `Bearer ${SECRET}`];

// Three routes with three different required scopes, so a pass could not come from one
// of them happening to be unguarded.
const ROUTES = [
  ["GET", "/v1/auth", "system.read"],
  ["GET", "/v1/workspaces", "workspace.read"],
  ["GET", "/v1/admin/users", "user.read"],
];

let keyId;

beforeAll(async () => {
  const admin = await prisma.users.create({
    data: {
      username: "wildcard-admin",
      password: bcrypt.hashSync("Pw123456!", 10),
      role: "admin",
    },
  });
  // The grant half reads the creator's grants. Granting the widest legacy role here
  // means the scope half is the only thing left that can refuse.
  await syncLegacyRoleGrant(admin, { db: prisma });
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });
  // Raw SQL on purpose: ApiKey.create rejects "*" and the column has no default any
  // more, so no supported path can produce this row.
  const rows = await prisma.$queryRaw`
    INSERT INTO "api_keys" ("name", "secretDigest", "keyPrefix", "scopes", "createdBy", "lastUpdatedAt")
    VALUES ('legacy', ${digestSecret(SECRET)}, ${keyPrefix(SECRET)}, '["*"]', ${admin.id}, CURRENT_TIMESTAMP)
    RETURNING "id"
  `;
  keyId = rows[0].id;
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("a key row still carrying the wildcard scope", () => {
  it.each(ROUTES)("%s %s (needs %s) is refused", async (method, route) => {
    const response = await request(app)
      [method.toLowerCase()](`/api${route}`)
      .set(...bearer());
    expect({ status: response.status, body: response.body }).toEqual({
      status: 403,
      body: { error: "Insufficient scope." },
    });
  });

  it("stores the wildcard verbatim — the refusal is the middleware's, not a rewrite", async () => {
    const row = await prisma.api_keys.findUnique({ where: { id: keyId } });
    expect(JSON.parse(row.scopes)).toEqual(["*"]);
  });

  it("the same row with named scopes reaches the handler (positive control)", async () => {
    await prisma.api_keys.update({
      where: { id: keyId },
      data: { scopes: JSON.stringify(ADMIN_DEFAULT_SCOPES) },
    });
    const response = await request(app).get("/api/v1/auth").set(...bearer());
    expect(response.status).toBe(200);
  });
});

// T-6 Phase A (#28): the audit export through the real stack.
//
// Built with `migrate deploy` per code-standards section 7.1a — the permission
// rows the engine reads come from migration INSERTs, and `db push` would leave
// the permissions table empty, where every request 403s for the wrong reason and
// the test would pass with the endpoint deleted.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "audit-export-http-"));
const schema = `audit_export_http_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.STORAGE_DIR = path.join(tempDir, "storage");
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
  throw new Error("DATABASE_URL must point to PostgreSQL for HTTP tests");
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set("schema", schema);
process.env.DATABASE_URL = databaseUrl.toString();
process.env.API_KEY_PEPPER = "http-test-api-key-pepper-32-bytes";
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
const {
  resetRequestControls,
} = require("../../utils/middleware/requestControls");
const { makeJWT } = require("../../utils/http");
const { WorkspaceUser } = require("../../models/workspaceUsers");
const {
  syncLegacyRoleGrant,
} = require("../../utils/authorization/legacyRoleGrants");

const SENTINEL_EMAIL = "leak.check@example.co.th";
let adminAuth;
let memberAuth;

async function makeUser(username, role) {
  const user = await prisma.users.create({
    data: { username, password: bcrypt.hashSync("Pw123456!", 10), role },
  });
  await syncLegacyRoleGrant(user, { db: prisma });
  return user;
}

beforeAll(async () => {
  await resetRequestControls();
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });

  const admin = await makeUser("audit-export-admin", "admin");
  const member = await makeUser("audit-export-member", "default");
  adminAuth = `Bearer ${makeJWT({ id: admin.id, username: admin.username })}`;
  memberAuth = `Bearer ${makeJWT({ id: member.id, username: member.username })}`;

  // A member is a member of the org; workspace access comes from the model, which
  // is what moves the grant with it (code-standards section 7.7).
  const workspace = await prisma.workspaces.create({
    data: { name: "Audit WS", slug: `audit-ws-${process.pid}` },
  });
  await WorkspaceUser.create(member.id, workspace.id);

  // A row written straight to the table, carrying PII the way pre-T-6 rows did.
  await prisma.event_logs.create({
    data: {
      eventId: `audit-export-seed-${process.pid}`,
      event: "user_updated",
      metadata: JSON.stringify({ username: SENTINEL_EMAIL }),
      userId: admin.id,
      occurredAt: new Date(),
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("audit export is guarded and redacted", () => {
  test("super admin exports rows as json", async () => {
    const response = await request(app)
      .get("/api/audit/export?format=json")
      .set("Authorization", adminAuth);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.rows)).toBe(true);
    expect(response.body.rows.length).toBeGreaterThan(0);
  });

  test("export redacts rows that were stored before the sink guarded them", async () => {
    const response = await request(app)
      .get("/api/audit/export?format=json")
      .set("Authorization", adminAuth);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain(SENTINEL_EMAIL);
    expect(body).toContain("[redacted:email]");
  });

  test("csv export carries a header row and the same redaction", async () => {
    const response = await request(app)
      .get("/api/audit/export?format=csv")
      .set("Authorization", adminAuth);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.text.split("\n")[0]).toBe(
      "id,eventId,event,userId,occurredAt,metadata"
    );
    expect(response.text).not.toContain(SENTINEL_EMAIL);
  });

  test("csv escapes cells a spreadsheet would run as a formula", async () => {
    // The event type is caller-controlled and lands in a CSV column, so a crafted
    // type is code the moment an operator opens the file.
    await prisma.event_logs.create({
      data: {
        eventId: `audit-export-formula-${process.pid}`,
        event: "=cmd()|'/c calc'!A1",
        metadata: JSON.stringify({ name: "+SUM(1,2)" }),
        userId: null,
        occurredAt: new Date(),
      },
    });

    const response = await request(app)
      .get("/api/audit/export?format=csv")
      .set("Authorization", adminAuth);

    expect(response.status).toBe(200);
    const dangerous = response.text
      .split("\n")
      .filter((line) => /(^|,)\s*["']?[=+\-@]/.test(line));
    expect(dangerous).toEqual([]);
    expect(response.text).toContain("\"'=cmd()");
  });

  test("an ordinary member is refused", async () => {
    const response = await request(app)
      .get("/api/audit/export?format=json")
      .set("Authorization", memberAuth);

    expect(response.status).toBe(403);
  });

  test("an unauthenticated caller is refused", async () => {
    const response = await request(app).get("/api/audit/export?format=json");

    expect(response.status).toBe(401);
  });

  test("a malformed range is a client error rather than an empty export", async () => {
    const response = await request(app)
      .get("/api/audit/export?format=json&from=not-a-date")
      .set("Authorization", adminAuth);

    expect(response.status).toBe(400);
  });

  test("the export itself is recorded in the audit log", async () => {
    await request(app)
      .get("/api/audit/export?format=json")
      .set("Authorization", adminAuth);

    const logged = await prisma.event_logs.findFirst({
      where: { event: "audit_exported" },
      orderBy: { occurredAt: "desc" },
    });
    expect(logged).not.toBeNull();
  });
});

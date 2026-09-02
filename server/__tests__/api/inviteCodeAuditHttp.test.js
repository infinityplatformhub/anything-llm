// #71 — an invite created through the REAL route leaves no code in the audit log.
//
// RED-first: written before the fix.
//
// The unit test in `__tests__/utils/events/auditRedaction.test.js` asserts that
// redaction drops the code. This asserts the whole path: the admin route runs,
// emits its event, the subscriber writes the row, and the code is not in it.
//
// Both are needed. The unit test can pass while the route puts the code under a
// different allowlisted key, and the route test can pass while redaction is
// unwired if the route simply stopped sending the field. Only together do they
// pin "an invite code cannot reach event_logs".

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "invite-audit-"));
const schema = `invite_audit_${process.pid}`;
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
  ["migrate", "deploy", "--schema", testSchema],
  { cwd: path.resolve(__dirname, "../.."), env: process.env, stdio: "ignore" }
);
// The seed writes the roles and permissions the authorization engine reads;
// without it every request 403s before reaching the handler under test.
execFileSync(
  process.execPath,
  [path.resolve(__dirname, "../../prisma/seed.js")],
  { cwd: path.resolve(__dirname, "../.."), env: process.env, stdio: "ignore" }
);

jest.mock("../../utils/logger", () => () => {});
jest.mock("../../utils/boot", () => ({ bootHTTP: jest.fn(), bootSSL: jest.fn() }));
jest.mock("../../utils/boot/patchSdkTimeouts", () => jest.fn());
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
const {
  resetRequestControls,
} = require("../../utils/middleware/requestControls");
const { makeJWT } = require("../../utils/http");

let authorization;
let adminId;

async function grantLegacyRole(user) {
  const {
    syncLegacyRoleGrant,
  } = require("../../utils/authorization/legacyRoleGrants");
  await syncLegacyRoleGrant(user, { db: prisma });
}

beforeAll(async () => {
  await resetRequestControls();
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });
  const admin = await prisma.users.create({
    data: {
      username: "invite-audit-admin",
      password: bcrypt.hashSync("Pw123456!", 10),
      role: "admin",
    },
  });
  await grantLegacyRole(admin);
  adminId = admin.id;
  authorization = `Bearer ${makeJWT({ id: admin.id, username: admin.username })}`;
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("#71: creating an invite writes no code to the audit log", () => {
  test("the code the route returns appears nowhere in event_logs", async () => {
    const response = await request(app)
      .post("/api/admin/invite/new")
      .set("Authorization", authorization)
      .send({ workspaceIds: [] });

    expect(response.status).toBe(200);
    // Guard the guard: if the route stopped returning a code, every assertion
    // below would pass against an empty string and prove nothing.
    const code = response.body?.invite?.code;
    expect(typeof code).toBe("string");
    expect(code.length).toBeGreaterThan(20);

    // The whole table, not just the invite_created row: the point is that the
    // credential is absent from the audit log, whichever event carries it.
    const rows = await prisma.event_logs.findMany({ take: 200 });
    for (const row of rows) expect(JSON.stringify(row)).not.toContain(code);
  });

  test("the /v1 API route also creates an audit record", async () => {
    // #71 second defect: `/v1/admin/invite/new` emitted nothing at all, so an
    // invite minted through the API left no trace of who could now join the
    // instance. Asserted through the real route rather than by reading the
    // source, because "an emit call exists" and "a row lands" are different
    // claims — the second is the one the audit log makes.
    const before = await prisma.event_logs.count({
      where: { event: "api_invite_created" },
    });

    // The key is minted by the admin fixture and scoped to this one route:
    // `ApiKey.create` refuses a creator without `key.manage` (PR-4d #35), and a
    // key may not hold more than its creator does.
    const { ApiKey } = require("../../models/apiKeys");
    const { apiKey, error } = await ApiKey.create(adminId, "invite-audit-key", {
      scopes: ["invite.create"],
    });
    expect(error).toBeNull();
    const response = await request(app)
      .post("/api/v1/admin/invite/new")
      .set("Authorization", `Bearer ${apiKey.secret}`)
      .send({ workspaceIds: [] });

    expect(response.status).toBe(200);
    const code = response.body?.invite?.code;
    expect(typeof code).toBe("string");

    const after = await prisma.event_logs.count({
      where: { event: "api_invite_created" },
    });
    expect(after).toBe(before + 1);

    // And the same rule applies to this route's record: the id, never the code.
    const rows = await prisma.event_logs.findMany({ take: 200 });
    for (const row of rows) expect(JSON.stringify(row)).not.toContain(code);
    // 30s: minting a key runs the scope-ceiling resolution against the database,
    // which exceeds jest's 5s default under load. A timing limit, not behaviour.
  }, 30_000);

  test("the invite_created event still says which invite, and who created it", async () => {
    // Redaction that empties the event is not a fix — an audit row that records
    // nothing identifiable cannot answer the question it exists for.
    const response = await request(app)
      .post("/api/admin/invite/new")
      .set("Authorization", authorization)
      .send({ workspaceIds: [] });
    expect(response.status).toBe(200);

    const row = await prisma.event_logs.findFirst({
      where: { event: "invite_created" },
      orderBy: { id: "desc" },
    });
    expect(row).not.toBeNull();

    const metadata = JSON.parse(row.metadata);
    expect(metadata.inviteId).toBe(response.body.invite.id);
    expect(metadata.createdBy).toBe("invite-audit-admin");
  });
});

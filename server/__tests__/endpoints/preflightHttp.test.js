/**
 * O2b (#112) — GET /system/preflight, at the HTTP level.
 *
 * The rule, stated as a rule rather than by analogy with a neighbouring route:
 *
 *   answer when the instance has no users yet, OR when the caller holds
 *   system.write. Never otherwise.
 *
 * The route that matters is the one an operator opens when something is broken,
 * so the interesting cases are the broken ones: the transition mid-process, a
 * caller with the adjacent permission, and a database that is down.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-http-"));
const schema = `preflight_http_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.STORAGE_DIR = path.join(tempDir, "storage");
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
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
  addChatCostToMetrics: jest.fn((m) => m),
}));
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn(), flush: jest.fn() },
}));
jest.mock("../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn().mockResolvedValue(true) },
}));
jest.mock("../../utils/helpers", () => ({
  ...jest.requireActual("../../utils/helpers"),
  getVectorDbClass: jest.fn(() => ({
    name: "fake-vector-db",
    namespaceCount: jest.fn(async () => 0),
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
const { makeJWT } = require("../../utils/http");
const { CHECK_IDS } = require("../../utils/doctor");
const doctor = require("../../utils/doctor");

const auth = (user) =>
  `Bearer ${makeJWT({ id: user.id, username: user.username })}`;

async function setMultiUserMode(on) {
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: String(on) },
    create: { label: "multi_user_mode", value: String(on) },
  });
}

const mkUser = async (username, role) => {
  const user = await prisma.users.create({
    data: { username, password: bcrypt.hashSync("Pw123456!", 10), role },
  });
  const {
    syncLegacyRoleGrant,
  } = require("../../utils/authorization/legacyRoleGrants");
  await syncLegacyRoleGrant(user, { db: prisma });
  return user;
};

/**
 * A principal holding system.read and NOT system.write.
 *
 * No stock role is shaped this way — measured: only super_admin carries either,
 * and it carries both. So the adjacent-permission case has to be built, and
 * building it is the point: without it the test would be asserting that a user
 * with NO permissions is refused, which proves nothing about the gate's choice
 * of system.write over system.read.
 */
async function mkSystemReader(username) {
  const user = await mkUser(username, "default");
  const permission = await prisma.permissions.findFirst({
    where: { action: "system.read" },
  });
  expect(permission).not.toBeNull();

  const role = await prisma.roles.create({
    data: { name: `preflight-reader-${process.pid}`, scope: "org", orgId: 1 },
  });
  await prisma.role_permissions.create({
    data: { role_id: role.id, permission_id: permission.id, effect: "allow" },
  });
  await prisma.principal_role_grants.create({
    data: {
      orgId: 1,
      principal_type: "user",
      principal_id: String(user.id),
      role_id: role.id,
    },
  });
  return user;
}

async function clearUsers() {
  await prisma.principal_role_grants.deleteMany({
    where: { principal_type: "user" },
  });
  await prisma.users.deleteMany();
}

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("the gate: pre-user OR system.write", () => {
  beforeEach(async () => {
    await clearUsers();
    await setMultiUserMode(false);
  });

  it("answers an anonymous request while the instance has no users", async () => {
    const res = await request(app).get("/api/system/preflight");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.checks)).toBe(true);
    expect(res.body.checks.length).toBeGreaterThan(0);
  });

  it("closes to anonymous callers the moment a user exists, in the SAME process", async () => {
    // RF-1. The transition happens inside one process: the first User.create
    // during onboarding closes the window with no restart. A boolean cached at
    // module load would leave this route open for the life of that process, and
    // nothing about a restarted app would reveal it.
    const before = await request(app).get("/api/system/preflight");
    expect(before.status).toBe(200);

    await mkUser("first-admin", "admin");

    const after = await request(app).get("/api/system/preflight");
    expect(after.status).not.toBe(200);
    expect(after.body.checks).toBeUndefined();
  });

  it("answers a caller holding system.write", async () => {
    const admin = await mkUser("write-holder", "admin");
    await setMultiUserMode(true);
    const res = await request(app)
      .get("/api/system/preflight")
      .set("Authorization", auth(admin));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.checks)).toBe(true);
  });

  it("refuses a caller holding system.read but NOT system.write, with no checks in the body", async () => {
    // RF-2. `permissions.js:59` draws the line that a key which may read system
    // status must not thereby read provider configuration — and a check detail
    // naming an unreachable database host, or reporting metrics exposure, is on
    // the far side of it. The body assertion matters as much as the status: a
    // 403 that still carried the checks would leak exactly what it refused.
    const reader = await mkSystemReader("read-only-holder");
    await setMultiUserMode(true);

    const res = await request(app)
      .get("/api/system/preflight")
      .set("Authorization", auth(reader));

    expect([403, 404]).toContain(res.status);
    expect(res.body.checks).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("db.reachable");
  });

  it("refuses an unauthenticated caller once users exist", async () => {
    await mkUser("someone", "admin");
    await setMultiUserMode(true);
    const res = await request(app).get("/api/system/preflight");
    expect(res.status).not.toBe(200);
    expect(res.body.checks).toBeUndefined();
  });
});

describe("the response carries no credential (RF-3)", () => {
  beforeEach(async () => {
    await clearUsers();
    await setMultiUserMode(false);
  });

  // The hosts this project actually ships. `db.internal` is deliberately NOT
  // used: it contains a dot, so scrubValue's EMAIL pattern catches a password
  // beside it by accident — that accident is what made #94's first test pass.
  const PASSWORD = "sup3rsecret-preflight-password";
  const HOSTS = ["postgres:5432", "localhost:5432"];

  it.each(HOSTS)(
    "removes a password quoted in a check detail on host %s",
    async (host) => {
      const url = `postgresql://appuser:${PASSWORD}@${host}/anythingllm`;
      const spy = jest.spyOn(doctor, "runChecks").mockResolvedValue([
        {
          id: "db.reachable",
          ok: false,
          level: "block",
          detail: `Cannot connect: connection to ${url} failed`,
          remedy: `Check that ${url} is reachable`,
        },
      ]);
      try {
        const res = await request(app).get("/api/system/preflight");
        expect(res.status).toBe(200);
        const body = JSON.stringify(res.body);
        expect(body).not.toContain(PASSWORD);
        // Partial too: a redaction keeping the first eight characters would
        // pass a whole-value assertion and still hand over most of a short
        // password.
        expect(body).not.toContain(PASSWORD.slice(0, 8));
        expect(body).not.toContain("appuser");
        // and the host survives, because it is the diagnostic part
        expect(body).toContain(host.split(":")[0]);
      } finally {
        spy.mockRestore();
      }
    }
  );
});

describe("a database that is down (RF-5)", () => {
  beforeEach(async () => {
    await clearUsers();
    await setMultiUserMode(false);
  });

  it("reports every check id, with the downstream ones failed rather than absent", async () => {
    // A doctor that drops the checks it could not run reports a shorter list
    // that reads as a shorter checklist. #74 already answers this by returning
    // ok:false with "could not run" for everything downstream of the
    // connection; this holds that through HTTP.
    const spy = jest
      .spyOn(doctor, "runChecks")
      .mockResolvedValue(
        CHECK_IDS.map((id) => ({
          id,
          ok: false,
          level: "block",
          detail:
            id === "db.reachable"
              ? "Cannot connect: ECONNREFUSED"
              : "Not checked: the database could not be reached, so this check could not run.",
          remedy: "Start the database",
        }))
      );
    try {
      const res = await request(app).get("/api/system/preflight");
      expect(res.status).toBe(200);
      const ids = res.body.checks.map((check) => check.id);
      expect(ids).toEqual(CHECK_IDS);
      expect(res.body.checks.every((check) => check.ok === false)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("still REFUSES an anonymous caller when users exist and the users table cannot be read", async () => {
    // The reason the gate is `isConfirmedSingleUser` and not `User.count()`:
    // models/user.js:305 returns 0 when the query throws, so
    // `User.count() === 0` is TRUE while the database is down — opening this
    // route at exactly the moment its details are most revealing.
    //
    // The failure is induced at the PRISMA layer, not by spying on whichever
    // helper the gate happens to call. Spying on `isConfirmedSingleUser` would
    // test the mock: a gate rewired to `User.count()` never calls it, so the
    // assertion would pass on the very mutation it exists to catch. Measured —
    // that first version stayed green through it.
    await mkUser("existing-admin", "admin");
    await setMultiUserMode(true);

    const spy = jest
      .spyOn(prisma.users, "count")
      .mockRejectedValue(new Error("connection terminated unexpectedly"));
    try {
      const res = await request(app).get("/api/system/preflight");
      expect(res.status).not.toBe(200);
      expect(res.body.checks).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

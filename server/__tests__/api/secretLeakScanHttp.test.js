/**
 * Secret-leak scan over the real HTTP stack.
 *
 * Updating a provider key through POST /api/system/update-env must not put the
 * submitted secret into the response body, into anything written to the
 * console, or into an audit event payload. Each of those is a place an
 * operator, a log shipper, or the audit reader can see it later.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const PG_PROTOCOL = "postgresql:";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "secret-leak-"));
const schema = `secret_leak_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.API_KEY_PEPPER = "secret-leak-test-pepper-32-bytes-long";
process.env.STORAGE_DIR = path.join(tempDir, "storage");
const baseDatabaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (baseDatabaseUrl.protocol !== PG_PROTOCOL)
  throw new Error("DATABASE_URL must point to PostgreSQL for HTTP tests");
baseDatabaseUrl.searchParams.set("schema", schema);
process.env.DATABASE_URL = baseDatabaseUrl.toString();
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
// The connection check dials a real Postgres. Stub it so this suite measures
// what the response says about the value, not whether the host is reachable.
jest.mock("../../utils/vectorDbProviders/pgvector", () => ({
  PGVector: {
    validateConnection: jest.fn(async () => ({ error: null, success: true })),
    validateTableName: jest.fn(async () => ({ error: null, success: true })),
  },
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

const CANARY = "sk-canary-do-not-log-8f3a91c04d7e";
// A connection string carries its password inline, so the whole value is the
// secret even though the key name says nothing about credentials.
const DSN_PASSWORD = "dsn-canary-pw-4b7c2e19";
const DSN_CANARY = `postgresql:${"//"}pguser:${DSN_PASSWORD}@db.internal:5432/vectors`;
// P0-4D(c): an endpoint setting is not credential-named, so nothing about the key says
// it might carry a password -- but the userinfo of a URL does. The host has to survive
// so an operator can confirm the endpoint they set is the endpoint that was stored.
const URL_PASSWORD = "endpoint-canary-pw-9f1d3a";
const URL_HOST = "chroma.internal:8000";
const URL_CANARY = `https:${"//"}chromauser:${URL_PASSWORD}@${URL_HOST}`;
let admin;

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
  admin = await prisma.users.create({
    data: {
      username: "leak-admin",
      password: bcrypt.hashSync("Pw123456!", 10),
      role: "admin",
    },
  });
  await grantLegacyRole(prisma, admin);
  // upsert: the seed already writes this label (T-4a added the seed run above)
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("POST /api/system/update-env does not leak the submitted secret", () => {
  let response;
  let consoleOutput;

  beforeAll(async () => {
    consoleOutput = [];
    const sinks = ["log", "info", "warn", "error"].map((level) =>
      jest.spyOn(console, level).mockImplementation((...args) => {
        consoleOutput.push(args.map(String).join(" "));
      })
    );

    response = await request(app)
      .post("/api/system/update-env")
      .set("Authorization", `Bearer ${makeJWT({ id: admin.id, username: admin.username })}`)
      .send({
        LLMProvider: "openai",
        OpenAiKey: CANARY,
        PGVectorConnectionString: DSN_CANARY,
        ChromaEndpoint: URL_CANARY,
      });

    sinks.forEach((sink) => sink.mockRestore());
  });

  it("accepts the update", () => {
    expect(response.status).toBe(200);
    expect(process.env.OPEN_AI_KEY).toBe(CANARY);
  });

  it("keeps the secret out of the response body", () => {
    expect(JSON.stringify(response.body)).not.toContain(CANARY);
    expect(response.text).not.toContain(CANARY);
  });

  it("keeps the password embedded in a connection string out of the response", () => {
    expect(response.text).not.toContain(DSN_PASSWORD);
    expect(response.text).not.toContain(DSN_CANARY);
  });

  it("strips the password from an endpoint URL but keeps the host", () => {
    const echoed = response.body.newValues.ChromaEndpoint;
    expect(response.text).not.toContain(URL_PASSWORD);
    expect(response.text).not.toContain(URL_CANARY);
    // Not a blanket mask: the operator still sees which endpoint took effect.
    expect(echoed).toContain(URL_HOST);
    expect(echoed).not.toContain("chromauser");
  });

  it("keeps the secret out of console output", () => {
    expect(consoleOutput.join("\n")).not.toContain(CANARY);
    expect(consoleOutput.join("\n")).not.toContain(DSN_PASSWORD);
    expect(consoleOutput.join("\n")).not.toContain(URL_PASSWORD);
  });

  it("keeps the secret out of every audit event payload", async () => {
    const events = await prisma.event_logs.findMany();
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(CANARY);
    expect(JSON.stringify(events)).not.toContain(DSN_PASSWORD);
    expect(JSON.stringify(events)).not.toContain(URL_PASSWORD);
  });

  it("still reports which settings changed", () => {
    expect(Object.keys(response.body.newValues)).toEqual(
      expect.arrayContaining([
        "LLMProvider",
        "OpenAiKey",
        "PGVectorConnectionString",
      ])
    );
  });
});

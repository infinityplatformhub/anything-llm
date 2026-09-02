/**
 * PR-4d (#35) over the real HTTP stack — the hole QA-2 confirmed on main.
 *
 * On main an admin could POST /admin/generate-api-key with `["system.env.read"]` and be
 * handed it, because the preset was only a default and nothing checked the creator's own
 * grants. That key then read the provider credentials through /v1/system/env-dump. The
 * ceiling closes it at the mint site: a creator who does not hold a scope cannot put it
 * in a key, whatever the endpoint's preset says.
 *
 * Driven over HTTP rather than through the model because that is where QA-2 reproduced
 * it, and because the status code and the body an operator sees are part of the fix: a
 * refusal has to NAME the scopes so they know what to ask for.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "key-ceiling-"));
const schema = `key_ceiling_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.API_KEY_PEPPER = "key-ceiling-test-pepper-32-bytes-x";
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
  // §7.1a: migrate deploy, not db push — the roles and permissions the ceiling reads
  // are migration INSERTs, and without them every scope would answer unknown_action.
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
const { makeJWT } = require("../../utils/http");
const repository = require("../../utils/authorization/policyRepository");
const { SERVICE_PRINCIPALS } = require("../../utils/authorization/actorResolver");
const {
  ADMIN_DEFAULT_SCOPES,
} = require("../../utils/apiKeySecurity/scopes");

const SYS = SERVICE_PRINCIPALS.singleUser;
const auth = (user) => `Bearer ${makeJWT({ id: user.id, username: user.username })}`;
const mint = (user, body) =>
  request(app).post("/api/admin/generate-api-key").set("Authorization", auth(user)).send(body);

let superAdmin;
let setupAdmin;

beforeAll(async () => {
  const roleRows = await prisma.roles.findMany({ select: { id: true, name: true, scope: true } });
  const roles = Object.fromEntries(roleRows.map((r) => [`${r.name}:${r.scope}`, r.id]));

  [superAdmin, setupAdmin] = await Promise.all(
    ["ceil-http-super", "ceil-http-setup"].map((username) =>
      prisma.users.create({
        data: { username, password: bcrypt.hashSync("Pw123456!", 10), role: "admin" },
      })
    )
  );
  // Both are legacy-role "admin", so nothing about the ROLE STRING separates them —
  // only their grants do, which is the whole point of the ceiling.
  await repository.grantRole({
    actor: SYS, principalType: "user", principalId: String(superAdmin.id),
    roleId: roles["super_admin:org"], db: prisma,
  });
  await repository.grantRole({
    actor: SYS, principalType: "user", principalId: String(setupAdmin.id),
    roleId: roles["setup_admin:org"], db: prisma,
  });
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

describe("POST /admin/generate-api-key enforces the creator's ceiling", () => {
  it("refuses a creator who does not hold system.env.read, and names it", async () => {
    // The exact request QA-2 reproduced on main. setup_admin holds key.manage, so it
    // reaches the handler; it does not hold system.env.read, so it cannot grant it.
    const response = await mint(setupAdmin, {
      name: "env-reader",
      scopes: ["workspace.read", "system.env.read"],
    });

    expect(response.status).toBe(400);
    expect(response.body.apiKey).toBeNull();
    expect(response.body.error).toMatch(/system\.env\.read/);
    // Named so the operator knows what to ask for — not a bare "Forbidden".
    expect(response.body.error).not.toMatch(/workspace\.read/);
  });

  it("allows super_admin the same request, because it holds that scope", async () => {
    const response = await mint(superAdmin, {
      name: "env-reader-allowed",
      scopes: ["workspace.read", "system.env.read"],
    });

    expect(response.status).toBe(200);
    expect(response.body.error).toBeNull();
    expect(JSON.parse(response.body.apiKey.scopes)).toEqual([
      "workspace.read",
      "system.env.read",
    ]);
  });

  it("the refused key was never written — a 400 is not a partial mint", async () => {
    const rows = await prisma.api_keys.findMany({ where: { name: "env-reader" } });
    expect(rows).toHaveLength(0);
  });

  it("an unmodified client posting only {name} gets the preset trimmed to its grants", async () => {
    // The compatibility half of PMO ruling 2: no scopes named, so the preset applies —
    // but narrowed. Before PR-4d this same call handed setup_admin the full preset.
    const response = await mint(setupAdmin, { name: "defaulted" });

    expect(response.status).toBe(200);
    const granted = JSON.parse(response.body.apiKey.scopes);
    expect(granted).toContain("workspace.read");
    expect(granted).not.toContain("system.env.read");
    expect(granted).not.toContain("document.delete");
    for (const scope of granted) expect(ADMIN_DEFAULT_SCOPES).toContain(scope);
  });

  it("the scopes reported to the caller are the scopes stored", async () => {
    // A response echoing the preset while storing less would be a lie the operator only
    // discovers when a route refuses the key.
    const response = await mint(setupAdmin, { name: "echo" });
    const stored = await prisma.api_keys.findFirst({ where: { name: "echo" } });

    expect(JSON.parse(response.body.apiKey.scopes)).toEqual(JSON.parse(stored.scopes));
  });
});

describe("end to end: the credential-reading scope reaches only a creator who holds it", () => {
  it("setup_admin cannot obtain any key that reads env-dump", async () => {
    // The exact path QA-2 walked on main: ask explicitly for the scope, get the key,
    // read the credentials. The mint is refused, so there is no secret to try — and
    // that is the assertion, not a 403 from a key that was never going to have it.
    const explicit = await mint(setupAdmin, {
      name: "explicit-env",
      scopes: ["system.env.read"],
    });
    expect(explicit.status).toBe(400);
    expect(explicit.body.apiKey).toBeNull();

    // The default path does not smuggle it in either: the preset never contained
    // system.env.read, and after trimming it still does not.
    const defaulted = await mint(setupAdmin, { name: "defaulted-env" });
    const secret = defaulted.body.apiKey.secret;
    expect(JSON.parse(defaulted.body.apiKey.scopes)).not.toContain("system.env.read");

    const denied = await request(app)
      .get("/api/v1/system/env-dump")
      .set("Authorization", `Bearer ${secret}`);
    expect(denied.status).toBe(403);
  });

  it("super_admin's key does read env-dump — the route works, the ceiling is what refuses", async () => {
    // Positive control. Without it, the 403 above is equally consistent with a broken
    // route, a broken fixture, or a scope table that names nothing.
    const allowed = await mint(superAdmin, {
      name: "super-env",
      scopes: ["system.env.read"],
    });
    expect(allowed.status).toBe(200);

    const dump = await request(app)
      .get("/api/v1/system/env-dump")
      .set("Authorization", `Bearer ${allowed.body.apiKey.secret}`);
    expect(dump.status).toBe(200);
  });
});

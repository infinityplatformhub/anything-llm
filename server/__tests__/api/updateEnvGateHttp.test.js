/** Authorization gate for POST /system/update-env over real auth and HTTP routing. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "update-env-gate-"));
const schema = `update_env_gate_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.API_KEY_PEPPER = "update-env-gate-pepper-at-least-32-bytes";
process.env.SIG_KEY = "update-env-gate-sig-key-long-enough-for-scrypt";
process.env.STORAGE_DIR = path.join(tempDir, "storage");
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
  throw new Error("DATABASE_URL must point to PostgreSQL for HTTP tests");
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set("schema", schema);
process.env.DATABASE_URL = databaseUrl.toString();
fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });

execFileSync(
  path.resolve(__dirname, "../../node_modules/.bin/prisma"),
  ["migrate", "deploy", "--schema", path.resolve(__dirname, "../../prisma/schema.prisma")],
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
const { CredentialStore } = require("../../models/credentialStore");
const { KEY_MAPPING } = require("../../utils/helpers/updateENV");
const { ROUTE_SCOPES } = require("../../utils/apiKeySecurity/scopes");
const repository = require("../../utils/authorization/policyRepository");
const { DatabaseAuthorizationEngine } = require("../../utils/authorization/engine");
const { SERVICE_PRINCIPALS } = require("../../utils/authorization/actorResolver");

const engine = new DatabaseAuthorizationEngine({ db: prisma });
const resource = { type: "organization", id: "1", orgId: 1, workspaceId: null };
const actorFor = (user) => ({ type: "user", id: String(user.id), orgId: 1 });
const authFor = (user) =>
  `Bearer ${makeJWT({ id: user.id, username: user.username })}`;
const update = (user, body) =>
  request(app).post("/api/system/update-env").set("Authorization", authFor(user)).send(body);
const hasNoHooks = ({ checks = [], preUpdate = [], postUpdate = [], postSettled = [] }) =>
  checks.length + preUpdate.length + postUpdate.length + postSettled.length === 0;
const secretKeys = Object.keys(KEY_MAPPING).filter(
  (key) => KEY_MAPPING[key].secret === true
);
const nonSecretKeys = Object.keys(KEY_MAPPING).filter(
  (key) => KEY_MAPPING[key].secret === false
);
const secretKey = secretKeys.find((key) => hasNoHooks(KEY_MAPPING[key]));
const nonSecretKey = nonSecretKeys.find((key) => hasNoHooks(KEY_MAPPING[key]));
if (!secretKey || !nonSecretKey)
  throw new Error("KEY_MAPPING must contain side-effect-free secret and non-secret keys");
const secretEnvKey = KEY_MAPPING[secretKey].envKey;
const nonSecretEnvKey = KEY_MAPPING[nonSecretKey].envKey;
const ORIGINAL_SECRET = "manager-must-not-overwrite-this-secret";
const REPLACEMENT_SECRET = "admin-may-write-this-secret";
const ORIGINAL_NON_SECRET = "manager-must-not-overwrite-this-setting";

let manager;
let admin;

beforeAll(async () => {
  const roles = await prisma.roles.findMany({
    where: { scope: "org", name: { in: ["setup_admin", "super_admin"] } },
  });
  const roleId = Object.fromEntries(roles.map((role) => [role.name, role.id]));
  [manager, admin] = await Promise.all(
    ["update-env-manager", "update-env-admin"].map((username) =>
      prisma.users.create({
        data: { username, password: bcrypt.hashSync("Pw123456!", 10), role: "admin" },
      })
    )
  );
  await repository.grantRole({
    actor: SERVICE_PRINCIPALS.singleUser,
    principalType: "user",
    principalId: String(manager.id),
    roleId: roleId.setup_admin,
    db: prisma,
  });
  await repository.grantRole({
    actor: SERVICE_PRINCIPALS.singleUser,
    principalType: "user",
    principalId: String(admin.id),
    roleId: roleId.super_admin,
    db: prisma,
  });
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });
});

afterAll(async () => {
  await CredentialStore.delete(secretEnvKey);
  await CredentialStore.delete(KEY_MAPPING.OpenAiKey.envKey);
  delete process.env[secretEnvKey];
  delete process.env[KEY_MAPPING.OpenAiKey.envKey];
  delete process.env[nonSecretEnvKey];
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("issue 84 update environment authorization gate", () => {
  it("guards the manager fixture premise through the authorization engine", async () => {
    await expect(
      engine.authorize({ actor: actorFor(manager), action: "settings.write", resource })
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      engine.authorize({ actor: actorFor(manager), action: "system.write", resource })
    ).resolves.toMatchObject({ allowed: false });
  });

  it("refuses a manager secret write and leaves live and stored values unchanged", async () => {
    process.env[secretEnvKey] = ORIGINAL_SECRET;
    await CredentialStore.set(secretEnvKey, ORIGINAL_SECRET);

    const response = await update(manager, { [secretKey]: REPLACEMENT_SECRET });

    expect(response.status).toBe(403);
    expect(process.env[secretEnvKey]).toBe(ORIGINAL_SECRET);
    await expect(CredentialStore.get(secretEnvKey)).resolves.toBe(ORIGINAL_SECRET);
  });

  it("refuses a manager non-secret write", async () => {
    process.env[nonSecretEnvKey] = ORIGINAL_NON_SECRET;

    const response = await update(manager, {
      [nonSecretKey]: "manager-replacement-setting",
    });

    expect(response.status).toBe(403);
    expect(process.env[nonSecretEnvKey]).toBe(ORIGINAL_NON_SECRET);
  });

  it("lets an actor holding system.write write the same secret body", async () => {
    process.env[secretEnvKey] = ORIGINAL_SECRET;
    await CredentialStore.set(secretEnvKey, ORIGINAL_SECRET);

    const response = await update(admin, { [secretKey]: REPLACEMENT_SECRET });

    expect(response.status).toBe(200);
    expect(process.env[secretEnvKey]).toBe(REPLACEMENT_SECRET);
    await expect(CredentialStore.get(secretEnvKey)).resolves.toBe(REPLACEMENT_SECRET);
  });

  // The UI resubmits forms containing secrets it never received in cleartext, sending
  // asterisks in place of the value; `updateENV` strips those before writing. This gate
  // sits in front of that path, so a suite testing only refusals would not notice the
  // allowed path starting to write literal asterisks over a live credential.
  it("leaves a secret untouched when the caller submits the masked placeholder", async () => {
    process.env[secretEnvKey] = ORIGINAL_SECRET;
    await CredentialStore.set(secretEnvKey, ORIGINAL_SECRET);

    const response = await update(admin, { [secretKey]: "****" });

    expect(response.status).toBe(200);
    expect(process.env[secretEnvKey]).toBe(ORIGINAL_SECRET);
    await expect(CredentialStore.get(secretEnvKey)).resolves.toBe(ORIGINAL_SECRET);
  });

  it("keeps a stored OpenAI key when an authorized actor submits its mask", async () => {
    const envKey = KEY_MAPPING.OpenAiKey.envKey;
    process.env[envKey] = ORIGINAL_SECRET;
    await CredentialStore.set(envKey, ORIGINAL_SECRET);

    const response = await update(admin, { OpenAiKey: "****" });

    expect(response.status).toBe(200);
    expect(process.env[envKey]).toBe(ORIGINAL_SECRET);
    await expect(CredentialStore.get(envKey)).resolves.toBe(ORIGINAL_SECRET);
  });

  it("agrees with the API key surface scope", () => {
    expect(ROUTE_SCOPES["POST /v1/system/update-env"]).toBe("system.write");
  });
});

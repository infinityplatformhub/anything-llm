/**
 * #104: a credential that could not be persisted must not be reported as written.
 *
 * `persistCredential` returns `{error}` (S11a/#80, TL-1) and `updateENV` drops it
 * (updateENV.js, the `await persistCredential(...)` line). The value is live in
 * process.env for this process and nowhere durable, so the caller is told the write
 * succeeded while the next restart comes up without it.
 *
 * Driven through the real routes, with the credential store's write stubbed to fail.
 * A mocked `updateENV` would only assert that the `if` we just wrote runs.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "persist-credential-"));
const schema = `persist_credential_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.API_KEY_PEPPER = "persist-credential-pepper-32-bytes";
process.env.SIG_KEY = "persist-credential-sig-key-long-enough";
process.env.STORAGE_DIR = path.join(tempDir, "storage");
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
  throw new Error("DATABASE_URL must point to PostgreSQL for HTTP tests");
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set("schema", schema);
process.env.DATABASE_URL = databaseUrl.toString();
fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });

const serverRoot = path.resolve(__dirname, "../..");
execFileSync(
  path.join(serverRoot, "node_modules/.bin/prisma"),
  ["migrate", "deploy", "--schema", path.join(serverRoot, "prisma/schema.prisma")],
  { cwd: serverRoot, env: process.env, stdio: "ignore" }
);
execFileSync(process.execPath, [path.join(serverRoot, "prisma/seed.js")], {
  cwd: serverRoot,
  env: process.env,
  stdio: "ignore",
});

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
const { EncryptionManager } = require("../../utils/EncryptionManager");
const {
  resetRequestControls,
} = require("../../utils/middleware/requestControls");

let admin;
/** Single-user session auth: a token carrying the encrypted AUTH_TOKEN, not a user id. */
const operatorToken = () =>
  makeJWT({ p: new EncryptionManager().encrypt(process.env.AUTH_TOKEN) }, "1h");
const webAuth = (user) =>
  `Bearer ${makeJWT({ id: user.id, username: user.username })}`;

/** Make the encrypted store refuse writes, the way an unavailable table would. */
const STORE_ERROR = "credential store unavailable";
let realSet;
const failStoreWrites = () => {
  CredentialStore.set = async () => ({ error: STORE_ERROR });
};

const {
  syncLegacyRoleGrant,
} = require("../../utils/authorization/legacyRoleGrants");

beforeAll(async () => {
  realSet = CredentialStore.set.bind(CredentialStore);
  admin = await prisma.users.create({
    data: {
      username: "persist-admin",
      password: bcrypt.hashSync("Pw123456!", 10),
      role: "admin",
    },
  });
  await syncLegacyRoleGrant(admin, { db: prisma });
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });
});

afterAll(async () => {
  CredentialStore.set = realSet;
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  CredentialStore.set = realSet;
  jest.clearAllMocks();
  delete process.env.OPEN_AI_KEY;
  delete process.env.LLM_PROVIDER;
  // update-password is behind the login limiters; without this the control case 429s
  // after the refusal cases have each spent a request.
  await resetRequestControls();
});

/**
 * The routes here disagree about which mode they run in: `update-env` needs an
 * authenticated admin (multi-user), while `update-password` and `enable-multi-user`
 * are single-user routes and refuse otherwise. Each test says which it needs, so no
 * case depends on the order jest happens to pick.
 */
async function multiUser() {
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });
  admin = await prisma.users.upsert({
    where: { username: "persist-admin" },
    update: {},
    create: {
      username: "persist-admin",
      password: bcrypt.hashSync("Pw123456!", 10),
      role: "admin",
    },
  });
  await syncLegacyRoleGrant(admin, { db: prisma });
}

async function singleUser() {
  await prisma.users.deleteMany({});
  await prisma.system_settings.deleteMany({
    where: { label: "multi_user_mode" },
  });
}

describe("a credential that could not be persisted is not reported as written", () => {
  it("answers 500 rather than 200 when the store refuses the write", async () => {
    await multiUser();
    failStoreWrites();

    const response = await request(app)
      .post("/api/system/update-env")
      .set("Authorization", webAuth(admin))
      .send({ OpenAiKey: "sk-value-that-cannot-be-stored" });

    expect(response.status).toBe(500);
    expect(response.body.error).toContain(STORE_ERROR);
  });

  it("names the key whose credential was lost, not just that something failed", async () => {
    await multiUser();
    // An operator reading "a write failed" cannot tell which provider to re-enter.
    failStoreWrites();

    const response = await request(app)
      .post("/api/system/update-env")
      .set("Authorization", webAuth(admin))
      .send({ OpenAiKey: "sk-value-that-cannot-be-stored" });

    expect(response.body.error).toContain("OPEN_AI_KEY");
  });

  it("still answers 200 when the store accepts the write", async () => {
    await multiUser();
    // The positive control: without it, every case above is equally consistent
    // with a route that refuses all credential writes.
    const response = await request(app)
      .post("/api/system/update-env")
      .set("Authorization", webAuth(admin))
      .send({ OpenAiKey: "sk-value-that-stores-fine" });

    expect(response.status).toBe(200);
    expect(response.body.error).toBe(false);
    expect(await CredentialStore.get("OPEN_AI_KEY")).toBe(
      "sk-value-that-stores-fine"
    );
  });

  it("leaves a non-secret key unaffected, so the check is scoped to persistence", async () => {
    await multiUser();
    // LLMProvider is `secret: false` and never reaches persistCredential; a failing
    // store must not turn an unrelated setting into a 500.
    failStoreWrites();

    const response = await request(app)
      .post("/api/system/update-env")
      .set("Authorization", webAuth(admin))
      .send({ LLMProvider: "openai" });

    expect(response.status).toBe(200);
    expect(response.body.error).toBe(false);
  });

  it("refuses the multi-user flip when its JWT rotation cannot be stored", async () => {
    await singleUser();
    // RF-1 also writes JWT_SECRET. Without clearing the row first, a `get` here could
    // read what that case stored and the assertion would pass on the wrong evidence.
    await CredentialStore.delete("JWT_SECRET");
    await CredentialStore.delete("AUTH_TOKEN");
    expect(await CredentialStore.get("JWT_SECRET")).toBeNull();
    // The route #104 was opened for. JWT_SECRET is secret:true, so dumpENV does not
    // write it to the .env file either — a rotation that fails to persist exists only
    // in this process, and the next boot mints a different one, invalidating every
    // session issued in between while the operator was told it worked.
    //
    // The route runs while the instance is still SINGLE-USER, so there is no user to
    // sign a JWT for: `validatedRequest` expects the operator token carrying the
    // encrypted AUTH_TOKEN, which is how the real caller authenticates.
    failStoreWrites();

    const response = await request(app)
      .post("/api/system/enable-multi-user")
      .set("Authorization", `Bearer ${operatorToken()}`)
      .send({ username: "first-admin", password: "Pw123456!" });

    expect(response.status).toBe(500);
    // The rollback must have run: no half-enabled instance left behind, and no
    // orphaned admin row.
    const mode = await prisma.system_settings.findUnique({
      where: { label: "multi_user_mode" },
    });
    expect(mode?.value).not.toBe("true");
    expect(await prisma.users.count()).toBe(0);
  });

  it("RF-1: update-password reports failure when the new password cannot be stored", async () => {
    await singleUser();
    // AuthToken is secret:true. A password change that does not persist leaves the
    // operator signed in with a password the next boot will not recognise.
    failStoreWrites();

    const response = await request(app)
      .post("/api/system/update-password")
      .set("Authorization", `Bearer ${operatorToken()}`)
      .send({ usePassword: true, newPassword: "NewPw123456!" });

    expect(response.body.success).toBe(false);
    expect(response.body.error).toContain("AUTH_TOKEN");
    // ponytail: reporting only. The route rotates AUTH_TOKEN and JWT_SECRET in one
    // call, and a store that fails on the second leaves the first stored — undoing
    // that needs the prior values read back and restored under the same failure, a
    // transaction rather than a return-value check. Tracked in #116.
  });

  it("RF-1 control: update-password succeeds when the store accepts the write", async () => {
    await singleUser();
    // Without this, RF-1 is equally consistent with a route that refuses every
    // password change.
    const response = await request(app)
      .post("/api/system/update-password")
      .set("Authorization", `Bearer ${operatorToken()}`)
      .send({ usePassword: true, newPassword: "NewPw123456!" });

    expect(response.body.success).toBe(true);
    expect(response.body.error).toBeFalsy();
  });

  it("RF-3: a later key is still applied when an earlier one fails to persist", async () => {
    await multiUser();
    // The reason the persist error is accumulated rather than `break`-ing the loop:
    // the failure happens AFTER the value was written, so the remaining keys have not
    // been rejected and stopping would leave them silently unapplied.
    failStoreWrites();

    const response = await request(app)
      .post("/api/system/update-env")
      .set("Authorization", webAuth(admin))
      .send({ OpenAiKey: "sk-cannot-store", LLMProvider: "openai" });

    expect(response.status).toBe(500);
    expect(response.body.error).toContain("OPEN_AI_KEY");
    // The key that follows the failure is reported AND applied.
    expect(process.env.LLM_PROVIDER).toBe("openai");
    // `newValues` is what the UI renders as "changed", so the key whose credential
    // was lost must not appear in it — otherwise the operator has to read `error` to
    // learn which of the listed keys is lying.
    expect(Object.keys(response.body.newValues)).toEqual(["LLMProvider"]);
  });

  it("JWT_SECRET is secret:true, which is why a failed persist loses it entirely", () => {
    // The premise of the case above, asserted rather than assumed. If JWTSecret ever
    // stops being secret:true, dumpENV would write it to .env and the failure mode
    // this suite describes would no longer be the one that happens.
    expect(KEY_MAPPING.JWTSecret.secret).toBe(true);
    expect(KEY_MAPPING.OpenAiKey.secret).toBe(true);
    expect(KEY_MAPPING.LLMProvider.secret).toBe(false);
  });
});

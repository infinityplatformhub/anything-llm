/**
 * #48: an operator must be able to take a stored credential back.
 *
 * `persistCredential` has a delete branch for an empty value, but 49 of the 91
 * `secret: true` keys carry a validator that rejects "" before `updateENV` reaches it —
 * and `force` does not help, because those validators never read the flag. So for the
 * keys most worth revoking the branch is dead: the row stays decryptable, and
 * `loadStoredCredentials()` puts the value back into `process.env` on every boot. There
 * was no way to revoke a leaked provider key short of editing the database.
 *
 * Driven over HTTP against a real database and a real encrypted row, because the claim
 * is about what survives a restart — a mocked store would answer whatever the test said.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cred-clear-"));
const schema = `cred_clear_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.API_KEY_PEPPER = "cred-clear-test-pepper-32-bytes-x";
process.env.SIG_KEY = "cred-clear-sig-key-long-enough-for-scrypt-derivation";
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
  // §7.1a: migrate deploy — the seeded roles and permissions requirePermission reads
  // are migration INSERTs.
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
const {
  loadStoredCredentials,
  KEY_MAPPING,
  INSTANCE_AUTH_KEYS,
  ENV_KEY_PATTERN,
} = require("../../utils/helpers/updateENV");
const repository = require("../../utils/authorization/policyRepository");
const { SERVICE_PRINCIPALS } = require("../../utils/authorization/actorResolver");

const SYS = SERVICE_PRINCIPALS.singleUser;
const ENV_KEY = "OPEN_AI_KEY";
const SECRET = "sk-canary-to-be-revoked-8f3a91c0";

let admin;
let moderator;
const auth = (user) => `Bearer ${makeJWT({ id: user.id, username: user.username })}`;
const clear = (user, key) =>
  request(app).delete(`/api/system/credential/${key}`).set("Authorization", auth(user));

beforeAll(async () => {
  const roleRows = await prisma.roles.findMany({ select: { id: true, name: true, scope: true } });
  const roles = Object.fromEntries(roleRows.map((r) => [`${r.name}:${r.scope}`, r.id]));

  [admin, moderator] = await Promise.all(
    ["cred-admin", "cred-mod"].map((username) =>
      prisma.users.create({
        data: { username, password: bcrypt.hashSync("Pw123456!", 10), role: "admin" },
      })
    )
  );
  await repository.grantRole({
    actor: SYS, principalType: "user", principalId: String(admin.id),
    roleId: roles["super_admin:org"], db: prisma,
  });
  // Holds no settings.write — both users carry the legacy role string "admin", so only
  // the grant separates them.
  await repository.grantRole({
    actor: SYS, principalType: "user", principalId: String(moderator.id),
    roleId: roles["content_moderator:org"], db: prisma,
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

beforeEach(async () => {
  await CredentialStore.set(ENV_KEY, SECRET);
  process.env[ENV_KEY] = SECRET;
});

afterEach(async () => {
  await CredentialStore.delete(ENV_KEY);
  delete process.env[ENV_KEY];
});

describe("the gap: an empty value cannot clear these credentials", () => {
  it("the validator refuses '' before the delete branch is reachable", async () => {
    // The premise of the whole issue, asserted rather than assumed. If a future change
    // makes empty values acceptable, this fails and the new route may be redundant.
    const response = await request(app)
      .post("/api/system/update-env")
      .set("Authorization", auth(admin))
      .send({ OpenAiKey: "" });

    // 500, not 200: the route used to answer 200 while reporting a failure in the body,
    // so a client that checked the status alone read a rejected write as applied.
    // What this test guards is the refusal and the surviving row, not the status code.
    expect(response.status).toBe(500);
    expect(response.body.error).toMatch(/empty/i);
    // ...and the credential is still there, which is the actual harm.
    expect(await CredentialStore.get(ENV_KEY)).toBe(SECRET);
  });

  it("force does not bypass it either", async () => {
    // `force` exists on the validation path, so "just send force" looks like an answer.
    // It is not: these validators never read the flag.
    const checks = KEY_MAPPING.OpenAiKey.checks ?? [];
    const forced = await Promise.all(checks.map((check) => check("", true)));

    expect(forced.some((result) => typeof result === "string")).toBe(true);
  });
});

describe("DELETE /system/credential/:envKey", () => {
  it("removes the stored row", async () => {
    const response = await clear(admin, ENV_KEY);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ cleared: true, error: null });
    expect(await CredentialStore.get(ENV_KEY)).toBeNull();
  });

  it("unsets the live value, so the provider stops working now", async () => {
    // Deleting only the row would leave the process serving the revoked credential
    // until the next restart — the operator is told it is gone while it still works.
    await clear(admin, ENV_KEY);

    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  it("and it does not come back on the next boot", async () => {
    // The half that makes it a revocation rather than a restart away from undone.
    await clear(admin, ENV_KEY);
    const { loaded } = await loadStoredCredentials();

    expect(loaded).not.toContain(ENV_KEY);
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  it("writes an audit event naming the key but never the value", async () => {
    await clear(admin, ENV_KEY);
    const events = await prisma.event_logs.findMany({
      where: { event: "credential_cleared" },
    });

    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).toContain(ENV_KEY);
    // An audit row holding the secret would outlive the credential it was written to retire.
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });
});

describe("what it refuses", () => {
  it("a key that is not a stored credential is refused", async () => {
    // Without this the route is a way to unset any process environment variable —
    // STORAGE_DIR, JWT_SECRET, DATABASE_URL — from an HTTP request.
    const response = await clear(admin, "LLM_PROVIDER");

    expect(response.status).toBe(400);
    expect(response.body.cleared).toBe(false);
    expect(response.body.error).toMatch(/not a stored credential/i);
  });

  it.each(["STORAGE_DIR", "JWT_SECRET", "DATABASE_URL", "SIG_KEY"])(
    "%s is refused and stays set",
    async (key) => {
      const before = process.env[key];
      const response = await clear(admin, key);

      expect(response.status).toBe(400);
      expect(process.env[key]).toBe(before);
    }
  );

  it("a caller without settings.write is refused", async () => {
    const response = await clear(moderator, ENV_KEY);

    expect(response.status).toBe(403);
    // The credential is untouched, not just the response refused.
    expect(await CredentialStore.get(ENV_KEY)).toBe(SECRET);
  });

  it("an unauthenticated caller is refused", async () => {
    const response = await request(app).delete(`/api/system/credential/${ENV_KEY}`);

    expect(response.status).toBe(401);
    expect(await CredentialStore.get(ENV_KEY)).toBe(SECRET);
  });

  it("clearing a credential that is not stored reports failure rather than success", async () => {
    // A 200 here would tell an operator a credential was revoked when no row existed —
    // which reads as "it is gone" whether or not it ever was.
    await CredentialStore.delete(ENV_KEY);
    const response = await clear(admin, ENV_KEY);

    expect(response.status).toBe(400);
    expect(response.body.cleared).toBe(false);
  });
});

describe("QA-1 BLOCKER-1: instance authentication is not a provider credential", () => {
  // Captured before any case runs: these are the values the suite itself authenticates
  // with, so each case must put back exactly what it found.
  const originalEnv = Object.fromEntries(
    [...INSTANCE_AUTH_KEYS].map((key) => [key, process.env[key]])
  );

  // `secret: true` answers "must not be written to .env in plaintext". It does NOT
  // answer "safe to unset". AUTH_TOKEN and JWT_SECRET carry the flag and are the
  // instance's own authentication: clearing AUTH_TOKEN sends validatedRequest down its
  // passthrough branch (`!process.env.AUTH_TOKEN` skips session auth), so an
  // unauthenticated caller reaches POST /system/update-env — and because the row is
  // deleted, boot does not put it back. The instance stays open.
  it.each([...INSTANCE_AUTH_KEYS])("%s is refused, and its row survives", async (key) => {
    // §7.9: a 400 for a key with no stored row proves nothing — the route would answer
    // 400 anyway. Store a real row first, so the only thing that can explain the
    // refusal is the denylist, and assert the row is still readable afterwards.
    const canary = `stored-value-for-${key}`;
    await CredentialStore.set(key, canary);
    // The live value is deliberately NOT overwritten. SIG_KEY derives the store's own
    // encryption key, so assigning a canary to it would make the row written a moment
    // ago undecryptable — the test would fail on its own fixture and read as a broken
    // denylist. What the clear must not touch is asserted against whatever was there.
    const liveBefore = process.env[key];

    const response = await clear(admin, key);

    expect(response.status).toBe(400);
    expect(response.body.cleared).toBe(false);
    expect(response.body.error).toMatch(/instance authentication/i);
    // Neither half of the clear may have run.
    expect(await CredentialStore.get(key)).toBe(canary);
    expect(process.env[key]).toBe(liveBefore);

    // Restore rather than delete: JWT_SECRET and AUTH_TOKEN are this suite's own
    // authentication too, and leaving them unset breaks every later test in the file
    // with "Cannot create JWT as JWT_SECRET is unset" — a fixture that takes the harness
    // down looks exactly like the code being broken.
    await CredentialStore.delete(key);
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  });

  it("the instance stays authenticated after a refused clear", async () => {
    // The consequence, asserted end to end rather than inferred from a 400: an
    // unauthenticated write must still be refused afterwards.
    await clear(admin, "AUTH_TOKEN");
    const response = await request(app)
      .post("/api/system/update-env")
      .send({ OpenAiKey: "sk-should-not-be-accepted" });

    expect(response.status).toBe(401);
  });

  it("every denylisted key is well-formed, so none of them is a typo", () => {
    // A misspelled entry protects nothing and looks identical to a correct one.
    // Not asserted as a subset of KEY_MAPPING: SIG_KEY, SIG_SALT and API_KEY_PEPPER are
    // deliberately listed while not being mapped today — they are refused by the
    // credential-key check now, and by name if one is ever added.
    for (const key of INSTANCE_AUTH_KEYS) expect(key).toMatch(ENV_KEY_PATTERN);
  });

  it("no secret:true key outside the denylist appears in the passthrough condition", () => {
    // Guards the general case rather than today's two: if a future `secret: true` key
    // is ever named in validatedRequest's passthrough condition and is not denylisted,
    // clearing it would reopen exactly this hole, and this fails instead.
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../utils/middleware/validatedRequest.js"),
      "utf8"
    );
    const condition = source.match(
      /process\.env\.NODE_ENV === "development" \|\|[\s\S]{0,200}?\)\s*\{/
    );
    expect(condition).not.toBeNull();
    const namedInCondition = new Set(
      [...condition[0].matchAll(/process\.env\.([A-Z0-9_]+)/g)]
        .map((match) => match[1])
        .filter((name) => name !== "NODE_ENV")
    );
    expect(namedInCondition.size).toBeGreaterThan(0);

    for (const values of Object.values(KEY_MAPPING)) {
      if (values.secret !== true) continue;
      if (INSTANCE_AUTH_KEYS.has(values.envKey)) continue;
      expect(namedInCondition).not.toContain(values.envKey);
    }
  });

  it("the two that ARE mapped would otherwise be clearable", () => {
    // Pins why the denylist is load-bearing rather than belt-and-braces: without it,
    // these two pass the credential-key check.
    const credentialKeys = new Set(
      Object.values(KEY_MAPPING)
        .filter((values) => values.secret === true)
        .map((values) => values.envKey)
    );
    expect(credentialKeys).toContain("AUTH_TOKEN");
    expect(credentialKeys).toContain("JWT_SECRET");
  });

});

describe("Techlead NIT-1: the key name is validated before it is used", () => {
  it.each([
    ["lowercase", "open_ai_key"],
    ["a path segment", "..%2Fetc%2Fpasswd"],
    ["punctuation", "OPEN-AI-KEY"],
    ["over-long", "A".repeat(65)],
  ])("%s is refused without echoing what was sent", async (_label, key) => {
    const response = await clear(admin, key);

    expect(response.status).toBe(400);
    // The name comes off a URL path. Reflecting it back would put caller-controlled
    // text in the response body, and would also say which spellings get further.
    expect(response.body.error).toBe("Invalid credential key.");
  });
});

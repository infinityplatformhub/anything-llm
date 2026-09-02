/**
 * #114: `GET /setup-complete` answered every field of `currentSettings()` to anyone.
 *
 * Credentials were already booleanised, so no API key left the route. What did leave it
 * raw is every endpoint, base path and connection string — on a self-hosted install that
 * is the shape of someone's private network, readable by whoever can reach the instance.
 *
 * Three branches, decided per request:
 *   1. unauthenticated, users exist  -> the six fields the login screen needs
 *   2. pre-user (no users yet)       -> every key, endpoints emptied
 *   3. authenticated                 -> unchanged
 *
 * Driven over the real routes with a real database: whether users exist is the branch
 * condition, and a mocked count would let the window stay open with rows in the table.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-complete-"));
const schema = `setup_complete_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.API_KEY_PEPPER = "setup-complete-pepper-32-bytes-ok";
process.env.SIG_KEY = "setup-complete-sig-key-long-enough";
process.env.STORAGE_DIR = path.join(tempDir, "storage");
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
  throw new Error("DATABASE_URL must point to PostgreSQL for HTTP tests");
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set("schema", schema);
process.env.DATABASE_URL = databaseUrl.toString();
fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });

/**
 * Internal addresses a self-hosted install would really carry. Set BEFORE the app is
 * required, because `currentSettings()` reads process.env at call time and the point of
 * R2 is to scan a body built from values that actually exist.
 */
const INTERNAL_HOSTS = {
  AZURE_OPENAI_ENDPOINT: "https://internal-azure.corp.invalid",
  OLLAMA_BASE_PATH: "http://ollama.internal.invalid:11434",
  LMSTUDIO_BASE_PATH: "http://lmstudio.internal.invalid:1234",
  EMBEDDING_BASE_PATH: "http://embed.internal.invalid:8080",
  QDRANT_ENDPOINT: "http://qdrant.internal.invalid:6333",
  AGENT_SEARXNG_API_URL: "http://searxng.internal.invalid:8888",
  CHROMA_ENDPOINT: "http://chroma.internal.invalid:8000",
};
Object.assign(process.env, INTERNAL_HOSTS);

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
const { EncryptionManager } = require("../../utils/EncryptionManager");
const {
  syncLegacyRoleGrant,
} = require("../../utils/authorization/legacyRoleGrants");

/** The six a browser needs before it can show a login screen. */
const PUBLIC_FIELDS = [
  "MultiUserMode",
  "RequiresAuth",
  "SSOProviders",
  "SimpleSSOEnabled",
  "SimpleSSONoLogin",
  "SimpleSSONoLoginRedirect",
].sort();

const get = (authorization) => {
  const req = request(app).get("/api/setup-complete");
  return authorization ? req.set("Authorization", authorization) : req;
};

/** Single-user session auth: a token carrying the encrypted AUTH_TOKEN. */
const operatorToken = () =>
  `Bearer ${makeJWT({ p: new EncryptionManager().encrypt(process.env.AUTH_TOKEN) }, "1h")}`;

/** An instance that has been set up: a real admin row, multi-user on. */
async function withUsers() {
  const admin = await prisma.users.upsert({
    where: { username: "setup-admin" },
    update: {},
    create: {
      username: "setup-admin",
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
  return admin;
}

/** A fresh install: no user rows at all, single-user mode. */
async function preUser() {
  await prisma.users.deleteMany({});
  await prisma.system_settings.deleteMany({
    where: { label: "multi_user_mode" },
  });
}

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("R1: an unauthenticated caller on a set-up instance gets the login fields only", () => {
  it("returns exactly the six public fields", async () => {
    await withUsers();

    const response = await get();

    expect(response.status).toBe(200);
    // `toEqual` on the sorted key set, not a count: a count passes while the wrong
    // six fields are returned.
    expect(Object.keys(response.body.results).sort()).toEqual(PUBLIC_FIELDS);
  });

  it("gives each of the six the type the login screen expects", async () => {
    // Asserted per field rather than "all booleans": SimpleSSONoLoginRedirect is a
    // URL or null, and SSOProviders is a list. A blanket boolean assertion would
    // have to be wrong about two of the six to pass.
    await withUsers();

    const { results } = (await get()).body;

    expect(typeof results.MultiUserMode).toBe("boolean");
    expect(typeof results.RequiresAuth).toBe("boolean");
    expect(typeof results.SimpleSSOEnabled).toBe("boolean");
    expect(typeof results.SimpleSSONoLogin).toBe("boolean");
    expect(
      results.SimpleSSONoLoginRedirect === null ||
        typeof results.SimpleSSONoLoginRedirect === "string"
    ).toBe(true);
    expect(Array.isArray(results.SSOProviders)).toBe(true);
  });
});

describe("R2: no internal address survives in an unauthenticated body", () => {
  it("scans the whole serialised body, not a field list", async () => {
    // A per-field assertion only catches the fields someone thought of. The values
    // above are distinctive enough that finding one anywhere in the response is the
    // failure, wherever it was nested.
    await withUsers();

    const text = JSON.stringify((await get()).body);

    for (const [envKey, value] of Object.entries(INTERNAL_HOSTS))
      expect([envKey, text.includes(value)]).toEqual([envKey, false]);
  });

  it("scans the pre-user body too, which is the wider one", async () => {
    // The pre-user branch returns every KEY, so it is the branch where a leak is
    // most likely and least likely to be noticed.
    await preUser();

    const text = JSON.stringify((await get()).body);

    for (const [envKey, value] of Object.entries(INTERNAL_HOSTS))
      expect([envKey, text.includes(value)]).toEqual([envKey, false]);
  });
});

describe("TL-2: no masked field reaches an unauthenticated caller at all", () => {
  it("the narrow branch omits every masked field, not merely empties it", async () => {
    // The six-field allowlist already implies this, but the two are separate decisions:
    // if PUBLIC_SETTING_FIELDS ever grows, this is what says an endpoint may not be
    // what it grows by.
    const {
      MASKED_ENDPOINT_FIELDS,
    } = require("../../utils/helpers/publicSettings");
    await withUsers();

    const keys = Object.keys((await get()).body.results);

    expect(keys.filter((key) => MASKED_ENDPOINT_FIELDS.includes(key))).toEqual([]);
  });
});

describe("R8: the pre-user window returns keys, not endpoint values", () => {
  it("empties every endpoint field while keeping the key present", async () => {
    // Empty string, not null or undefined: onboarding renders these into controlled
    // inputs, and React warns — then switches the input to uncontrolled — when the
    // value flips between undefined and a string.
    await preUser();

    const { results } = (await get()).body;

    // Each of these carries a real internal address in this fixture, so "" is a
    // change the branch had to make rather than the value it already had.
    expect(results.OllamaLLMBasePath).toBe("");
    expect(results.AzureOpenAiEndpoint).toBe("");
    expect(results.ChromaEndpoint).toBe("");
    // And an endpoint field that is UNSET must also arrive as "" rather than being
    // dropped: JSON.stringify omits undefined, which is what makes a controlled
    // input flip to uncontrolled between renders.
    expect(results.TTSKokoroEndpoint).toBe("");
    // PGVectorConnectionString is the ONE masked field currentSettings already
    // booleanises. It is in the list anyway so that a future change turning it back
    // into a passthrough — the shape every neighbour has — does not silently start
    // publishing a DSN. Masking it costs a boolean the pre-user form never reads.
    expect(results.PGVectorConnectionString).toBe("");
  });

  it("still answers the non-endpoint fields the onboarding form needs", async () => {
    // The positive control. Without it, emptying everything would pass R8 while
    // leaving onboarding with nothing to render.
    //
    // The fields named here are ones `currentSettings()` gives a real value on a
    // fresh install. An unset setting is `undefined`, and `JSON.stringify` drops
    // those keys entirely — so asserting on one would be asserting that the branch
    // omits it, which is true before this change and after it.
    await preUser();

    const { results } = (await get()).body;

    expect(Object.keys(results).length).toBeGreaterThan(PUBLIC_FIELDS.length);
    expect(results).toHaveProperty("EmbeddingEngine");
    expect(results).toHaveProperty("WhisperProvider");
    expect(results).toHaveProperty("TextToSpeechProvider");
  });
});

describe("R9: the window closes on a real user row, not on a mocked count", () => {
  it("stops returning the wide body once a user exists", async () => {
    await preUser();
    const wide = Object.keys((await get()).body.results).length;

    await withUsers();
    const narrow = Object.keys((await get()).body.results).length;

    // Both measured from the same running instance, so this cannot pass by the two
    // branches happening to agree on a hardcoded number.
    expect(wide).toBeGreaterThan(narrow);
    expect(narrow).toBe(PUBLIC_FIELDS.length);
  });

  it("a user row with multi-user mode still off also closes it", async () => {
    // `isConfirmedSingleUser` is a conjunction. A row present while the mode flag was
    // never set is the state an aborted setup leaves behind, and it must not reopen
    // the window.
    await preUser();
    await prisma.users.create({
      data: {
        username: "half-setup",
        password: bcrypt.hashSync("Pw123456!", 10),
        role: "admin",
      },
    });

    const { results } = (await get()).body;

    expect(Object.keys(results).sort()).toEqual(PUBLIC_FIELDS);
  });
});

describe("R5: an authenticated caller still gets everything", () => {
  it("returns the provider fields with their real values", async () => {
    // The route feeds eight admin settings pages, which read ~200 fields off this
    // response. Narrowing it for an authenticated caller would break all of them.
    await withUsers();
    const admin = await prisma.users.findFirstOrThrow({
      where: { username: "setup-admin" },
    });

    const { results } = (
      await get(`Bearer ${makeJWT({ id: admin.id, username: admin.username })}`)
    ).body;

    expect(Object.keys(results).length).toBeGreaterThanOrEqual(92);
    expect(results.OllamaLLMBasePath).toBe(INTERNAL_HOSTS.OLLAMA_BASE_PATH);
    expect(results.AzureOpenAiEndpoint).toBe(INTERNAL_HOSTS.AZURE_OPENAI_ENDPOINT);
  });

  it("the single-user operator token opens it, and outranks the pre-user masking", async () => {
    // Single-user installs authenticate with the AUTH_TOKEN session rather than a user
    // id, and that state is ALSO pre-user — no rows, mode off. So this is the case
    // where the two conditions disagree, and it pins which one wins: an operator who
    // has proved they hold the password sees the real endpoints, not "".
    await preUser();

    const { results } = (await get(operatorToken())).body;

    expect(results.OllamaLLMBasePath).toBe(INTERNAL_HOSTS.OLLAMA_BASE_PATH);
    expect(results.QdrantEndpoint).toBe(INTERNAL_HOSTS.QDRANT_ENDPOINT);
  });

  it("a bad operator token gets the pre-user body, not a 401 and not the real endpoints", async () => {
    // The route must keep answering an unauthenticated browser; a failed session is an
    // ANSWER here, not a status. Without this, `callerHasSession` swallowing the
    // middleware's 401 could equally mean "treated everyone as authenticated".
    await preUser();

    const response = await get("Bearer not-a-real-token");

    expect(response.status).toBe(200);
    expect(response.body.results.OllamaLLMBasePath).toBe("");
  });
});

describe("drift: a new endpoint-shaped field cannot be added without listing it", () => {
  it("every field whose name ends in an endpoint suffix is in the masked list", async () => {
    // The list is written out rather than derived from this same rule, so that adding
    // `FooBasePath` to KEY_MAPPING fails here instead of being masked silently — or,
    // worse, being missed because the rule and the list were the same expression.
    const {
      MASKED_ENDPOINT_FIELDS,
    } = require("../../utils/helpers/publicSettings");
    const { SystemSettings } = require("../../models/systemSettings");
    const settings = await SystemSettings.currentSettings();
    const suffixed = Object.keys(settings)
      .filter((key) =>
        /BasePath$|Endpoint$|Url$|BaseUrl$|ConnectionString$|Address$|ApiUrl$/.test(
          key
        )
      )
      .sort();

    expect(suffixed).toEqual(
      [...MASKED_ENDPOINT_FIELDS].filter((key) => key !== "StorageDir").sort()
    );
  });

  it("StorageDir is masked although its name carries no endpoint suffix", async () => {
    // A filesystem path rather than a URL, so the suffix rule does not reach it, and
    // it is a real disclosure on a self-hosted box.
    const {
      MASKED_ENDPOINT_FIELDS,
    } = require("../../utils/helpers/publicSettings");

    expect(MASKED_ENDPOINT_FIELDS).toContain("StorageDir");

    await preUser();
    expect((await get()).body.results.StorageDir).toBe("");
  });
});

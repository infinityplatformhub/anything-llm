// T-5 (#30) slice 3 — S-25 over real HTTP: the three empty states must be one state.
//
// The helper suite proves `buildVectorSearchResponse` and the scoped counters in isolation.
// It cannot prove the ROUTES use them — and the routes are where the oracle lived. QA-2
// compares status, body and content-type across three cases, so that is what this drives:
//
//   1. unreadable — the workspace holds embeddings the actor may not read
//   2. empty      — the workspace genuinely holds none
//   3. absent     — no such workspace
//
// (1) and (2) must be byte-identical. A caller able to tell them apart learns that a
// workspace holds content it cannot see, which is the question the ACL exists to refuse —
// the same class as #32's mint oracle and P0-4A's login/invite oracle.
//
// RED before the fix: the `namespaceCount === 0` early return answered case (2) with
// `{results: [], message: "No embeddings found for this workspace."}` while case (1)
// answered `{results: []}`.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t5s3-card-"));
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.API_KEY_PEPPER = "t5s3-card-test-pepper-32-bytes-long";
process.env.STORAGE_DIR = path.join(tempDir, "storage");

const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
  throw new Error("DATABASE_URL must point to PostgreSQL for this suite");
}
const schema = `t5s3card_${crypto.randomBytes(3).toString("hex")}`;
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set("schema", schema);
process.env.DATABASE_URL = databaseUrl.toString();

fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });
fs.mkdirSync(path.resolve(__dirname, "../../../../collector/hotdir"), {
  recursive: true,
});

execFileSync(
  path.resolve(__dirname, "../../../node_modules/.bin/prisma"),
  ["migrate", "deploy", "--schema", path.resolve(__dirname, "../../../prisma/schema.prisma")],
  { cwd: path.resolve(__dirname, "../../.."), env: process.env, stdio: "ignore" }
);

jest.mock("../../../utils/logger", () => () => {});
jest.mock("../../../utils/boot", () => ({ bootHTTP: jest.fn(), bootSSL: jest.fn() }));
jest.mock("../../../utils/boot/patchSdkTimeouts", () => jest.fn());
jest.mock("../../../utils/boot/MetaGenerator", () => ({
  MetaGenerator: jest.fn().mockImplementation(() => ({
    generate: jest.fn(),
    generateManifest: jest.fn(),
  })),
}));
jest.mock("../../../utils/AiProviders/modelMap", () => ({
  MODEL_MAP: { get: jest.fn(() => null) },
}));
jest.mock("../../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn(), flush: jest.fn() },
}));
jest.mock("../../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn().mockResolvedValue(true) },
}));

// `hasVectorizedSpace` reports content for the "unreadable" workspace and none for the
// "empty" one — the two cases whose responses must be identical anyway.
const NAMESPACE_COUNTS = { "card-unreadable": 12, "card-empty": 0 };
const mockVectorDb = {
  hasNamespace: jest.fn(async (ns) => (NAMESPACE_COUNTS[ns] ?? 0) > 0),
  namespaceCount: jest.fn(async (ns) => NAMESPACE_COUNTS[ns] ?? 0),
  totalVectors: jest.fn(async () => 999),
  // The ACL removes everything, which is what makes case (1) "unreadable" rather than
  // "empty": the store HAS rows, the actor may read none of them.
  queryAuthorized: jest.fn(async ({ aclFilter }) => {
    if (!aclFilter) throw new Error("queryAuthorized called without an aclFilter");
    return { contextTexts: [], sourceDocuments: [], scores: [] };
  }),
  curateSources: jest.fn(() => []),
};
jest.mock("../../../utils/helpers", () => ({
  ...jest.requireActual("../../../utils/helpers"),
  getVectorDbClass: jest.fn(() => mockVectorDb),
  resolveProviderConnector: jest.fn(async () => ({
    connector: { embedTextInput: async () => [0.1], promptWindowLimit: () => 4096 },
    routingMetadata: null,
    prefetchedContext: null,
  })),
}));

const request = require("supertest");
const bcrypt = require("bcryptjs");
const prisma = require("../../../utils/prisma");
const { app } = require("../../../index");
const { CommunicationKey } = require("../../../utils/comKey");
new CommunicationKey(true);

const API_KEY = "apw-key-t5s3-card-secret";
let unreadable;
let empty;

beforeAll(async () => {
  const { syncLegacyRoleGrant } = require("../../../utils/authorization/legacyRoleGrants");
  const { WorkspaceUser } = require("../../../models/workspaceUsers");
  const { digestSecret, keyPrefix } = require("../../../utils/apiKeySecurity");
  const { ROUTE_SCOPES } = require("../../../utils/apiKeySecurity/scopes");

  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });

  const owner = await prisma.users.create({
    data: {
      username: "card-owner",
      password: bcrypt.hashSync("StrongPassword1!", 4),
      role: "admin",
      seen_recovery_codes: true,
    },
  });
  await syncLegacyRoleGrant(owner, { db: prisma });

  unreadable = await prisma.workspaces.create({
    data: { name: "Unreadable", slug: "card-unreadable" },
  });
  empty = await prisma.workspaces.create({
    data: { name: "Empty", slug: "card-empty" },
  });
  await WorkspaceUser.create(owner.id, unreadable.id);
  await WorkspaceUser.create(owner.id, empty.id);

  await prisma.api_keys.create({
    data: {
      name: "card",
      secretDigest: digestSecret(API_KEY),
      keyPrefix: keyPrefix(API_KEY),
      scopes: JSON.stringify([...new Set(Object.values(ROUTE_SCOPES))]),
      createdBy: owner.id,
    },
  });
}, 300_000);

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const search = (slug) =>
  request(app)
    .post(`/api/v1/workspace/${slug}/vector-search`)
    .set("Authorization", `Bearer ${API_KEY}`)
    .send({ query: "anything" });

describe("T-5 slice 3 (S-25): vector-search cannot say WHY it is empty", () => {
  test("unreadable and empty are byte-identical", async () => {
    const a = await search("card-unreadable");
    const b = await search("card-empty");

    // Status, raw body and content-type — QA-2's comparison. Comparing parsed objects
    // would let a stray key through, and the stray key WAS the bug.
    expect(a.status).toBe(b.status);
    expect(a.text).toEqual(b.text);
    expect(a.headers["content-type"]).toEqual(b.headers["content-type"]);
  });

  test("neither mentions embeddings at all", async () => {
    // The specific string that leaked: "No embeddings found for this workspace."
    for (const slug of ["card-unreadable", "card-empty"]) {
      const response = await search(slug);
      expect(response.text).not.toMatch(/no embeddings/i);
      expect(JSON.parse(response.text)).not.toHaveProperty("message");
    }
  });

  test("an ABSENT workspace is refused the same way a foreign one is", async () => {
    // The third state. A workspace the actor cannot reach must answer identically to one
    // that does not exist, or the refusal itself becomes the oracle it was meant to close.
    //
    // This needs its OWN key. The suite's main key was created by an admin holding an
    // org-wide grant, for which NO workspace is out of scope — asserting with it compared
    // "absent" against a workspace the caller could legitimately read, and the 403/200
    // split it produced was the fixture being wrong rather than the route. A scoped key is
    // the only way to have a genuinely foreign workspace to point at.
    const bcryptLocal = require("bcryptjs");
    const {
      syncLegacyRoleGrant,
    } = require("../../../utils/authorization/legacyRoleGrants");
    const { WorkspaceUser } = require("../../../models/workspaceUsers");
    const { digestSecret, keyPrefix } = require("../../../utils/apiKeySecurity");
    const { ROUTE_SCOPES } = require("../../../utils/apiKeySecurity/scopes");

    const member = await prisma.users.create({
      data: {
        username: "card-member",
        password: bcryptLocal.hashSync("StrongPassword1!", 4),
        role: "default",
        seen_recovery_codes: true,
      },
    });
    await syncLegacyRoleGrant(member, { db: prisma });
    const mine = await prisma.workspaces.create({
      data: { name: "Mine", slug: "card-mine" },
    });
    await WorkspaceUser.create(member.id, mine.id);
    // Created, but the member is NOT a WorkspaceUser of it.
    await prisma.workspaces.create({
      data: { name: "Foreign", slug: "card-foreign" },
    });

    const MEMBER_KEY = "apw-key-t5s3-card-member";
    await prisma.api_keys.create({
      data: {
        name: "card-member",
        secretDigest: digestSecret(MEMBER_KEY),
        keyPrefix: keyPrefix(MEMBER_KEY),
        scopes: JSON.stringify([...new Set(Object.values(ROUTE_SCOPES))]),
        createdBy: member.id,
      },
    });

    const asMember = (slug) =>
      request(app)
        .post(`/api/v1/workspace/${slug}/vector-search`)
        .set("Authorization", `Bearer ${MEMBER_KEY}`)
        .send({ query: "anything" });

    const absent = await asMember("card-nope");
    const outOfScope = await asMember("card-foreign");

    expect(absent.status).toBe(outOfScope.status);
    expect(absent.text).toEqual(outOfScope.text);
    expect(absent.headers["content-type"]).toEqual(
      outOfScope.headers["content-type"]
    );
    // And it must not be 200-with-empty-results, which would confirm existence by shape.
    expect(absent.status).not.toBe(200);

    // Positive control: the member's OWN workspace is reachable, so the matching refusals
    // above are a scope decision rather than a key that cannot reach anything at all.
    const ownWorkspace = await asMember("card-mine");
    expect(ownWorkspace.status).toBe(200);
  });

  test("the empty body is the ordinary result shape", async () => {
    // Positive control on the shape itself: a route that 500'd on both would satisfy the
    // equality test above and be entirely broken.
    const response = await search("card-empty");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({ results: [] });
  });
});

describe("T-5 slice 3 (S-25): /v1/system/vector-count is bounded by scope", () => {
  const count = () =>
    request(app)
      .get("/api/v1/system/vector-count")
      .set("Authorization", `Bearer ${API_KEY}`);

  test("the response shape is a single vectorCount key", async () => {
    // The shape must not vary with who is asking — a `partial` key appearing for some
    // callers would itself be a signal about the caller.
    const response = await count();
    expect(response.status).toBe(200);
    expect(Object.keys(JSON.parse(response.text))).toEqual(["vectorCount"]);
  });

  test("it does not return the instance total to a scoped key", async () => {
    // `totalVectors()` is mocked at 999. The key's creator belongs to two workspaces
    // holding 12 and 0, so anything other than 12 means the scope was ignored.
    const response = await count();
    expect(JSON.parse(response.text).vectorCount).not.toBe(999);
    expect(JSON.parse(response.text).vectorCount).toBe(12);
  });

  test("a scope past the cap answers 500 rather than a truncated number", async () => {
    // QA-2: 51 workspaces. A silently-capped sum is a wrong number that looks exactly like
    // a right one — worse than an error, because nobody investigates a plausible answer.
    const { WorkspaceUser } = require("../../../models/workspaceUsers");
    const {
      WORKSPACE_COUNT_CAP,
    } = require("../../../utils/authorization/cardinality");
    const owner = await prisma.users.findFirstOrThrow({
      where: { username: "card-owner" },
    });

    const before = mockVectorDb.namespaceCount.mock.calls.length;
    for (let i = 0; i < WORKSPACE_COUNT_CAP; i += 1) {
      const workspace = await prisma.workspaces.create({
        data: { name: `Bulk ${i}`, slug: `card-bulk-${i}` },
      });
      await WorkspaceUser.create(owner.id, workspace.id);
    }

    const response = await count();
    expect(response.status).toBe(500);
    expect(JSON.parse(response.text)).toEqual({
      error: "workspace scope too large to count",
    });
    // And it refused BEFORE fanning out — a cap that queries 51 namespaces and then throws
    // has prevented nothing, which is the amplification it exists to stop.
    expect(mockVectorDb.namespaceCount.mock.calls.length).toBe(before);
  });
});

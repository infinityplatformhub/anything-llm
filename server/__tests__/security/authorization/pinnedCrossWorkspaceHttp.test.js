// T-5 (#30) slice 2 round 3 — pinned documents, over real HTTP, across workspaces.
//
// Techlead-2 BLOCKER, proven against real PostgreSQL. `DocumentManager.pinnedDocs` read
// only the filter's deny and allow lists. The workspace it fetched from came from
// `this.workspace` — the workspace the REQUEST addressed — so scope was taken from the URL
// rather than from the authorization decision:
//
//   viewer of workspace A  ->  POST /workspace/<B's slug>/stream-chat
//
// This reaches the handler by design, not by accident. `chat.send` is held org-wide, and
// T-4a deliberately made `validWorkspaceSlug` a LOADER rather than a gate, because it used
// to 404 people that `requirePermission` had already authorized. So the request is allowed
// through — and B's pinned documents came back whole, in the prompt AND in the citations,
// while the vector path running beside them filtered correctly.
//
// Why the unit test is not enough on its own: the unit test proves `pinnedDocs` refuses a
// filter whose scope excludes the workspace. It cannot prove that the filter arriving on a
// real cross-workspace request actually HAS that scope. The leak needed both halves, and
// only the route shows them composed — §7.9's "drive the real entry point".
//
// RED on 78cdbecb: "PINNED SECRET OF B" appears in the streamed response.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t5s2-http-"));
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.API_KEY_PEPPER = "t5s2-http-test-pepper-32-bytes-long";
process.env.STORAGE_DIR = path.join(tempDir, "storage");

const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
  throw new Error("DATABASE_URL must point to PostgreSQL for this suite");
}
// A dedicated SCHEMA rather than a dedicated database: the app's prisma singleton reads
// DATABASE_URL once at import, and this suite drives the real app, so the process-wide
// value has to be the test one before any application module loads.
const schema = `t5s2http_${crypto.randomBytes(3).toString("hex")}`;
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set("schema", schema);
process.env.DATABASE_URL = databaseUrl.toString();

fs.mkdirSync(path.join(process.env.STORAGE_DIR, "documents", "custom-documents"), {
  recursive: true,
});
fs.mkdirSync(path.resolve(__dirname, "../../../../collector/hotdir"), {
  recursive: true,
});

execFileSync(
  path.resolve(__dirname, "../../../node_modules/.bin/prisma"),
  // §7.1a: `migrate deploy`, never `db push` — the engine needs the seeded roles and the
  // per-user grant backfill the migrations carry.
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
jest.mock("../../../utils/helpers/modelPricing", () => ({
  addChatCostToMetrics: jest.fn((metrics) => metrics),
}));
jest.mock("../../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn(), flush: jest.fn() },
}));
jest.mock("../../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn().mockResolvedValue(true) },
}));

// The vector store is stubbed EMPTY on purpose. The pinned path never touches it, so an
// empty store isolates this suite to the boundary under test: anything that appears in the
// response got there through pinned-document injection and nothing else.
const mockVectorDb = {
  hasNamespace: jest.fn(async () => true),
  namespaceCount: jest.fn(async () => 1),
  queryAuthorized: jest.fn(async ({ aclFilter }) => {
    if (!aclFilter) throw new Error("queryAuthorized called without an aclFilter");
    return { contextTexts: [], sourceDocuments: [], scores: [] };
  }),
  curateSources: jest.fn(() => []),
};
// The "LLM" echoes the context it was given, so the assertion can be made on what actually
// reached the prompt rather than on what a model chose to say about it.
const mockLlm = {
  defaultTemp: 0,
  embedTextInput: jest.fn(async () => [0.1]),
  // Without this the handler aborts with "streamingEnabled is not a function" BEFORE it
  // reaches retrieval — and both "must not contain" assertions would then pass on a
  // response that never contained anything at all. The positive control below is what
  // exposed that; a suite of absence-assertions alone cannot tell a fix from a crash.
  streamingEnabled: jest.fn(() => true),
  promptWindowLimit: jest.fn(() => 4096),
  compressMessages: jest.fn(async ({ contextTexts }) => contextTexts ?? []),
  constructPrompt: jest.fn(async () => ""),
  streamGetChatCompletion: jest.fn(async (messages) => ({
    type: "test-echo",
    messages,
    metrics: {},
  })),
  // The real connectors WRITE to the response here as tokens arrive and return the
  // assembled text. Returning without writing leaves nothing on the wire to assert
  // against, so the stub does both — the echoed prompt is how the context that actually
  // reached the LLM becomes visible to the test.
  handleStream: jest.fn(async (response, stream, { sources }) => {
    const textResponse = JSON.stringify(stream.messages);
    const { writeResponseChunk } = require("../../../utils/helpers/chat/responses");
    writeResponseChunk(response, {
      uuid: "test",
      type: "textResponseChunk",
      textResponse,
      sources,
      close: false,
      error: false,
    });
    return textResponse;
  }),
};
jest.mock("../../../utils/helpers", () => ({
  ...jest.requireActual("../../../utils/helpers"),
  getVectorDbClass: jest.fn(() => mockVectorDb),
  resolveProviderConnector: jest.fn(async () => ({
    connector: mockLlm,
    routingMetadata: null,
    prefetchedContext: null,
  })),
}));

const request = require("supertest");
const bcrypt = require("bcryptjs");
const prisma = require("../../../utils/prisma");
const { app } = require("../../../index");
const { makeJWT } = require("../../../utils/http");
const { CommunicationKey } = require("../../../utils/comKey");
new CommunicationKey(true);

const PASSWORD = "StrongPassword1!";
let carol;
let workspaceA;
let workspaceB;

/** Write the on-disk JSON a pinned document is read from, and return its docpath. */
function writeDocFile(name, pageContent) {
  const docpath = path.join("custom-documents", `${name}.json`);
  fs.writeFileSync(
    path.join(process.env.STORAGE_DIR, "documents", docpath),
    JSON.stringify({ pageContent, token_count_estimate: 10, title: name })
  );
  return docpath;
}

/** A pinned document in `workspace`, readable by that workspace, denied to nobody. */
async function pinDocument(workspace, name, content) {
  const document = await prisma.documents.create({
    data: { orgId: 1, filename: `${name}.txt`, dedupe_key: `/t5s2http/${name}.txt` },
  });
  await prisma.document_acl.create({
    data: {
      orgId: 1,
      document_id: document.id,
      principal_type: "workspace",
      principal_id: String(workspace.id),
      action: "document.read",
      source: "inherited_workspace",
    },
  });
  await prisma.workspace_documents.create({
    data: {
      docId: crypto.randomUUID(),
      filename: `${name}.txt`,
      docpath: writeDocFile(name, content),
      workspaceId: workspace.id,
      documentId: document.id,
      pinned: true,
    },
  });
}

beforeAll(async () => {
  const { syncLegacyRoleGrant } = require("../../../utils/authorization/legacyRoleGrants");
  const { WorkspaceUser } = require("../../../models/workspaceUsers");

  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });

  carol = await prisma.users.create({
    data: {
      username: "carol-viewer",
      password: bcrypt.hashSync(PASSWORD, 4),
      role: "default",
      seen_recovery_codes: true,
    },
  });
  // T-4a: the grant is written by the model, not by a raw insert — a raw row would leave
  // the user without the grant the engine reads, which is drift this suite should catch
  // rather than reproduce.
  await syncLegacyRoleGrant(carol, { db: prisma });

  workspaceA = await prisma.workspaces.create({ data: { name: "A", slug: "t5s2-ws-a" } });
  workspaceB = await prisma.workspaces.create({ data: { name: "B", slug: "t5s2-ws-b" } });

  // Carol belongs to A ONLY. Membership is what grants workspace access (T-4a).
  await WorkspaceUser.create(carol.id, workspaceA.id);

  await pinDocument(workspaceA, "a-doc", "PINNED DOC OF A");
  await pinDocument(workspaceB, "b-secret", "PINNED SECRET OF B");
}, 300_000);

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const asCarol = () => `Bearer ${makeJWT({ id: carol.id, username: carol.username })}`;

const chat = (slug) =>
  request(app)
    .post(`/api/workspace/${slug}/stream-chat`)
    .set("Authorization", asCarol())
    .send({ message: "what do you know?" });

describe("T-5 slice 2: a cross-workspace chat cannot pull the other workspace's pinned documents", () => {
  test("RED: carol chats to workspace B and B's pinned document does not reach her", async () => {
    const response = await chat(workspaceB.slug);

    // The request is NOT refused, and that matters: `chat.send` is org-wide and
    // validWorkspaceSlug is a loader. If this ever starts 403ing, the assertion below
    // would pass for a reason that has nothing to do with the ACL, so it is pinned here.
    expect(response.status).toBe(200);
    expect(response.text).not.toContain("PINNED SECRET OF B");
  });

  test("carol's OWN workspace still gives her its pinned document", async () => {
    // The positive control. Returning nothing everywhere would satisfy the test above and
    // break every chat in the product — the leak and the outage look identical from the
    // refusal side, and only this separates them.
    const response = await chat(workspaceA.slug);
    expect(response.status).toBe(200);
    expect(response.text).toContain("PINNED DOC OF A");
  });

  test("the citations are checked too, not only the prompt text", async () => {
    // `sources` is a separate array from `contextTexts` and is what the UI renders. A fix
    // that filtered one and not the other would still show the user B's document title and
    // its first thousand characters.
    const response = await chat(workspaceB.slug);
    const sourceChunks = response.text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .flatMap((payload) => {
        try {
          return JSON.parse(payload).sources ?? [];
        } catch {
          return [];
        }
      });
    expect(JSON.stringify(sourceChunks)).not.toContain("PINNED SECRET OF B");
    expect(JSON.stringify(sourceChunks)).not.toContain("b-secret");
  });
});

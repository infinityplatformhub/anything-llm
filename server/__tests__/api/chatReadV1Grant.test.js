// issue 63, Techlead-1 NIT-2: the /v1 twins of the two chat-history routes.
//
// scopes.js maps both to `chat.read` (:29, :40), and validApiKey checks the
// scope AND the creator's grant — a key cannot exceed the person who minted it.
// So the missing grant broke these routes too, and fixing it must not have
// widened them: a key whose creator holds no chat.read in the workspace still
// gets 403.
//
// Real Postgres, real migrations, the real app. The internal-route half lives in
// security/authorization/chatReadGrant.test.js.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "g63-v1-"));
const schema = `g63_v1_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.API_KEY_PEPPER = "g63-v1-test-pepper-32-bytes-long!";
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
  // §7.1a: migrate deploy, not db push — the grant this suite is about is a
  // migration INSERT.
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
const { digestSecret, keyPrefix } = require("../../utils/apiKeySecurity");
const repository = require("../../utils/authorization/policyRepository");
const {
  syncWorkspaceMembershipGrant,
} = require("../../utils/authorization/legacyRoleGrants");
const { SERVICE_PRINCIPALS } = require("../../utils/authorization/actorResolver");

const SYS = SERVICE_PRINCIPALS.singleUser;
// Both keys carry the SAME scope. The only difference is whether their creator
// holds chat.read in the workspace, so a difference in outcome can only come
// from the grant half.
const MEMBER_SECRET = "apw-key-g63-member-AAAAAAAAAAAAAAAAAAAA";
const OUTSIDER_SECRET = "apw-key-g63-outsdr-AAAAAAAAAAAAAAAAAAAA";
// #64: a creator who DOES hold chat.read_others. Without this the suite would assert
// only refusals, and a route that refused everyone would pass it.
const READER_SECRET = "apw-key-g63-reader-AAAAAAAAAAAAAAAAAAAA";

const withMemberKey = (req) =>
  req.set("Authorization", `Bearer ${MEMBER_SECRET}`);
const withOutsiderKey = (req) =>
  req.set("Authorization", `Bearer ${OUTSIDER_SECRET}`);
const withReaderKey = (req) =>
  req.set("Authorization", `Bearer ${READER_SECRET}`);

let workspace;
let thread;

beforeAll(async () => {
  const memberUser = await prisma.users.create({
    data: {
      username: "g63-v1-member",
      password: bcrypt.hashSync("Pw123456!", 10),
      role: "default",
    },
  });
  const outsiderUser = await prisma.users.create({
    data: {
      username: "g63-v1-outsider",
      password: bcrypt.hashSync("Pw123456!", 10),
      role: "default",
    },
  });

  workspace = await prisma.workspaces.create({
    data: { name: "g63-v1-ws", slug: "g63-v1-ws" },
  });
  thread = await prisma.workspace_threads.create({
    data: {
      name: "g63 v1 thread",
      slug: "g63-v1-thread",
      workspace_id: workspace.id,
      user_id: memberUser.id,
    },
  });

  // Only the member joins, and through the production path (§7.7) so the grant
  // actually lands. The outsider holds nothing in this workspace.
  const editorRole = await prisma.roles.findFirstOrThrow({
    where: { name: "editor", scope: "workspace" },
  });
  await prisma.workspace_users.create({
    data: {
      user_id: memberUser.id,
      workspace_id: workspace.id,
      role_id: editorRole.id,
    },
  });
  await syncWorkspaceMembershipGrant({
    userId: memberUser.id,
    workspaceId: workspace.id,
    actor: SYS,
    db: prisma,
  });
  // The outsider gets the org role a real signup produces — enough to exist as a
  // principal, not enough to read this workspace. Without it the 403 below would
  // be "no grants at all" rather than "no chat.read here".
  const orgMemberRole = await prisma.roles.findFirstOrThrow({
    where: { name: "member", scope: "org" },
  });
  await repository.grantRole({
    actor: SYS,
    principalType: "user",
    principalId: String(outsiderUser.id),
    roleId: orgMemberRole.id,
    db: prisma,
  });

  await prisma.workspace_chats.create({
    data: {
      workspaceId: workspace.id,
      prompt: "v1 default-thread question",
      response: JSON.stringify({ text: "v1 default-thread answer" }),
      user_id: memberUser.id,
    },
  });
  await prisma.workspace_chats.create({
    data: {
      workspaceId: workspace.id,
      prompt: "v1 threaded question",
      response: JSON.stringify({ text: "v1 threaded answer" }),
      user_id: memberUser.id,
      thread_id: thread.id,
    },
  });

  // #64: these routes declare chat.read_others, so every key here carries both — the
  // scope half must not be what separates them, or the grant half is never reached.
  const scopes = JSON.stringify(["chat.read", "chat.read_others"]);

  // A creator holding chat.read_others org-wide, and a member of this workspace.
  const readerUser = await prisma.users.create({
    data: {
      username: "g63-reader",
      password: bcrypt.hashSync("Pw123456!", 10),
      role: "default",
    },
  });
  const moderatorRole = await prisma.roles.findFirstOrThrow({
    where: { name: "content_moderator", scope: "org" },
  });
  await repository.grantRole({
    actor: SYS,
    principalType: "user",
    principalId: String(readerUser.id),
    roleId: moderatorRole.id,
    db: prisma,
  });
  await prisma.workspace_users.create({
    data: { user_id: readerUser.id, workspace_id: workspace.id },
  });
  await prisma.api_keys.createMany({
    data: [
      {
        name: "g63-member-key",
        secretDigest: digestSecret(MEMBER_SECRET),
        keyPrefix: keyPrefix(MEMBER_SECRET),
        scopes,
        createdBy: memberUser.id,
      },
      {
        name: "g63-outsider-key",
        secretDigest: digestSecret(OUTSIDER_SECRET),
        keyPrefix: keyPrefix(OUTSIDER_SECRET),
        scopes,
        createdBy: outsiderUser.id,
      },
      {
        name: "g63-reader-key",
        secretDigest: digestSecret(READER_SECRET),
        keyPrefix: keyPrefix(READER_SECRET),
        scopes,
        createdBy: readerUser.id,
      },
    ],
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

describe("issue 63: GET /v1/workspace/:slug/chats", () => {
  // #64 changed what this route asks for. It returns EVERY user's chats — there is no
  // per-user filter, and an API key has no "self" to filter by — so it declares
  // `chat.read_others`, not `chat.read`. A member creator holds `chat.read` and not
  // `chat.read_others`, so the answer this pair asserts is now 403.
  //
  // The test is kept rather than deleted: #63's question was whether the GRANT half is
  // consulted on this route at all, and it still is. Only the grant it requires moved.
  it("a key whose creator is only a workspace member is refused (issue 64)", async () => {
    const response = await withMemberKey(
      request(app).get(`/api/v1/workspace/${workspace.slug}/chats`)
    );
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Insufficient scope." });
  });

  it("a key whose creator holds no chat.read in the workspace is refused", async () => {
    const response = await withOutsiderKey(
      request(app).get(`/api/v1/workspace/${workspace.slug}/chats`)
    );
    expect(response.status).toBe(403);
  });

  it("a key whose creator holds chat.read_others is allowed (positive control)", async () => {
    // Every key in this suite carries the same scope list, so this 200 against the two
    // 403s above is the grant half being consulted — which is what #63 asserted, and
    // what would otherwise have been lost when both cases became refusals.
    const response = await withReaderKey(
      request(app).get(`/api/v1/workspace/${workspace.slug}/chats`)
    );
    expect(response.status).toBe(200);
    expect(response.body.history.length).toBeGreaterThan(0);
  });
});

describe("issue 63: GET /v1/workspace/:slug/thread/:threadSlug/chats", () => {
  // Same reason as the workspace listing above: #64 made this route `chat.read_others`.
  it("a key whose creator is only a workspace member is refused (issue 64)", async () => {
    const response = await withMemberKey(
      request(app).get(
        `/api/v1/workspace/${workspace.slug}/thread/${thread.slug}/chats`
      )
    );
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Insufficient scope." });
  });

  it("a key whose creator holds no chat.read in the workspace is refused", async () => {
    const response = await withOutsiderKey(
      request(app).get(
        `/api/v1/workspace/${workspace.slug}/thread/${thread.slug}/chats`
      )
    );
    expect(response.status).toBe(403);
  });

  it("a key whose creator holds chat.read_others is allowed (positive control)", async () => {
    const response = await withReaderKey(
      request(app).get(
        `/api/v1/workspace/${workspace.slug}/thread/${thread.slug}/chats`
      )
    );
    expect(response.status).toBe(200);
    expect(response.body.history.length).toBeGreaterThan(0);
  });
});

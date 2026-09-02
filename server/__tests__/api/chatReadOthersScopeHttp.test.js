/**
 * #64: `/v1` chat listings return every user's chats, so the action they declare must be
 * `chat.read_others`, not `chat.read`.
 *
 * The session routes narrow to the caller (`forWorkspaceByUser`). The `/v1` twins have no
 * per-user filter at all, and there is no equivalent "self" to filter by: an API key is a
 * bearer credential for its creator, not an identity, so filtering to the creator would
 * return an empty list for the ordinary case (the admin who minted the key is not the
 * person chatting) — a silent wrong answer rather than a refusal. Naming the wider action
 * makes the ingress check refuse a key whose creator holds only `chat.read`.
 *
 * QA-1 found this on #63; it is pre-existing, and #63 did not widen it.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-others-"));
const schema = `chat_others_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.API_KEY_PEPPER = "chat-others-test-pepper-32-bytes";
process.env.SIG_KEY = "chat-others-sig-key-long-enough-for-scrypt";
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
  // 7.1a: migrate deploy — the seeded roles the grant half reads are migration INSERTs.
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
const { SERVICE_PRINCIPALS } = require("../../utils/authorization/actorResolver");

const SYS = SERVICE_PRINCIPALS.singleUser;
const SLUG = "chat-others-ws";
const THREAD_SLUG = "chat-others-thread";
const OWNER_SECRET_TEXT = "OWNER-SECRET-PROMPT-do-not-leak";

// Every key below carries the SAME scope list. The only thing that differs is whose
// grants stand behind it, so a difference in outcome can only come from the grant half.
const KEY_SCOPES = JSON.stringify([
  "chat.read",
  "chat.read_others",
  "workspace.read",
]);
const SECRETS = {
  editor: "apw-key-editor-AAAAAAAAAAAAAAAAAAAAAAAAAA",
  moderator: "apw-key-moderator-AAAAAAAAAAAAAAAAAAAAAA",
  superAdmin: "apw-key-superadmin-AAAAAAAAAAAAAAAAAAAAA",
};

const withKey = (req, who) => req.set("Authorization", `Bearer ${SECRETS[who]}`);

let workspace;
let thread;

async function mkUser(username) {
  return prisma.users.create({
    data: { username, password: bcrypt.hashSync("Pw123456!", 10), role: "default" },
  });
}

beforeAll(async () => {
  const roleRows = await prisma.roles.findMany({ select: { id: true, name: true, scope: true } });
  const roles = Object.fromEntries(roleRows.map((r) => [`${r.name}:${r.scope}`, r.id]));

  workspace = await prisma.workspaces.create({ data: { name: SLUG, slug: SLUG } });
  thread = await prisma.workspace_threads.create({
    data: { name: THREAD_SLUG, slug: THREAD_SLUG, workspace_id: workspace.id },
  });

  // The owner's chats are what must not leak.
  const owner = await mkUser("chat-owner");
  await prisma.workspace_chats.create({
    data: {
      workspaceId: workspace.id,
      prompt: OWNER_SECRET_TEXT,
      response: JSON.stringify({ text: "owner answer" }),
      user_id: owner.id,
      include: true,
    },
  });
  await prisma.workspace_chats.create({
    data: {
      workspaceId: workspace.id,
      thread_id: thread.id,
      prompt: OWNER_SECRET_TEXT,
      response: JSON.stringify({ text: "owner thread answer" }),
      user_id: owner.id,
      include: true,
    },
  });

  // Three creators, three grants. `editor` is a WORKSPACE role, so it is granted with
  // that workspace's id — an org-wide grant would be a different question.
  const creators = {
    editor: { user: await mkUser("chat-editor"), roleId: roles["editor:workspace"], workspaceId: workspace.id },
    moderator: { user: await mkUser("chat-moderator"), roleId: roles["content_moderator:org"], workspaceId: null },
    superAdmin: { user: await mkUser("chat-superadmin"), roleId: roles["super_admin:org"], workspaceId: null },
  };
  for (const [name, { user, roleId, workspaceId }] of Object.entries(creators)) {
    await repository.grantRole({
      actor: SYS, principalType: "user", principalId: String(user.id),
      roleId, workspaceId, db: prisma,
    });
    await prisma.workspace_users.create({
      data: { user_id: user.id, workspace_id: workspace.id },
    });
    await prisma.api_keys.create({
      data: {
        name, secretDigest: digestSecret(SECRETS[name]),
        keyPrefix: keyPrefix(SECRETS[name]), scopes: KEY_SCOPES,
        createdBy: user.id,
      },
    });
  }

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

const ROUTES = [
  ["get", `/api/v1/workspace/${SLUG}/chats`],
  ["get", `/api/v1/workspace/${SLUG}/thread/${THREAD_SLUG}/chats`],
  ["post", "/api/v1/admin/workspace-chats"],
];

describe("a key whose creator holds only chat.read is refused", () => {
  // The `editor` role holds chat.send and the document actions, not chat.read_others.
  // Its key asks for the scope, which is exactly the case the grant half exists for:
  // effective permission is grants(creator) INTERSECT scopes(key).
  it.each(ROUTES)("%s %s is 403", async (method, route) => {
    const response = await withKey(request(app)[method](route), "editor").send({});

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Insufficient scope." });
  });

  it("and the owner's chat text appears in no refused response", async () => {
    // The status says refused; this says nothing leaked in the body on the way out.
    for (const [method, route] of ROUTES) {
      const response = await withKey(request(app)[method](route), "editor").send({});
      expect(response.text).not.toContain(OWNER_SECRET_TEXT);
    }
  });
});

describe("a key whose creator holds chat.read_others reads every user's chats", () => {
  it.each([["moderator"], ["superAdmin"]])(
    "%s reaches the workspace listing and sees the owner's chat",
    async (who) => {
      const response = await withKey(
        request(app).get(`/api/v1/workspace/${SLUG}/chats`),
        who
      );

      expect(response.status).toBe(200);
      expect(response.text).toContain(OWNER_SECRET_TEXT);
    }
  );

  it.each([["moderator"], ["superAdmin"]])(
    "%s reaches the thread listing too",
    async (who) => {
      const response = await withKey(
        request(app).get(`/api/v1/workspace/${SLUG}/thread/${THREAD_SLUG}/chats`),
        who
      );

      expect(response.status).toBe(200);
      expect(response.text).toContain(OWNER_SECRET_TEXT);
    }
  );

  it("super_admin reaches the admin chat export", async () => {
    // Positive control for the third route: without it, the 403 above is equally
    // consistent with a route that refuses everyone.
    const response = await withKey(
      request(app).post("/api/v1/admin/workspace-chats"),
      "superAdmin"
    ).send({ offset: 0 });

    expect(response.status).toBe(200);
  });
});

describe("the scope list alone is not enough", () => {
  it("a key carrying chat.read_others whose creator lacks it is still refused", async () => {
    // All three keys carry identical scopes. The editor's is refused, the moderator's is
    // not — so the refusal comes from the creator's grants, not from the key's list.
    // This is the property that makes changing ROUTE_SCOPES sufficient: the ingress
    // check evaluates the intersection, and there is no second authorization path.
    const editorScopes = await prisma.api_keys.findFirst({
      where: { name: "editor" },
      select: { scopes: true },
    });
    const moderatorScopes = await prisma.api_keys.findFirst({
      where: { name: "moderator" },
      select: { scopes: true },
    });
    expect(editorScopes.scopes).toBe(moderatorScopes.scopes);
    expect(JSON.parse(editorScopes.scopes)).toContain("chat.read_others");

    const refused = await withKey(
      request(app).get(`/api/v1/workspace/${SLUG}/chats`),
      "editor"
    );
    const allowed = await withKey(
      request(app).get(`/api/v1/workspace/${SLUG}/chats`),
      "moderator"
    );

    expect(refused.status).toBe(403);
    expect(allowed.status).toBe(200);
  });
});

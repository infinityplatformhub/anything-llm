const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "approof-api-"));
const schema = `regression_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.API_KEY_PEPPER = "regression-test-pepper-32-bytes-long";
process.env.STORAGE_DIR = path.join(tempDir, "storage");
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith("postgresql://")) {
  throw new Error("DATABASE_URL must point to PostgreSQL for regression tests");
}
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set("schema", schema);
process.env.DATABASE_URL = databaseUrl.toString();
fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });
fs.mkdirSync(path.resolve(process.env.STORAGE_DIR, "../../collector/hotdir"), {
  recursive: true,
});
fs.mkdirSync(path.resolve(__dirname, "../../../collector/hotdir"), {
  recursive: true,
});
const testSchema = path.resolve(__dirname, "../../prisma/schema.prisma");
execFileSync(
  path.resolve(__dirname, "../../node_modules/.bin/prisma"),
  // §7.1a: `migrate deploy` rather than `db push`. T-4a reached the same conclusion from
  // the other direction — that the engine needs seeded roles or every request 403s — and
  // fixed it by running prisma/seed.js after a `db push`. Running the migrations gives the
  // same rows plus the ones seed.js does not mirror (T-1's per-user grant backfill), and
  // it is what the db-push gate requires, so the seed call is redundant here.
  ["migrate", "deploy", "--schema", testSchema],
  {
    cwd: path.resolve(__dirname, "../.."),
    env: process.env,
    stdio: "ignore",
  }
);

jest.mock("../../utils/logger", () => () => {});
jest.mock("../../utils/boot", () => ({
  bootHTTP: jest.fn(),
  bootSSL: jest.fn(),
}));
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
jest.mock("../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn().mockResolvedValue(true) },
}));
const mockVectorRecords = [];
const mockVectorDb = {
  addDocumentToNamespace: jest.fn(async (namespace, document) => {
    mockVectorRecords.push({ namespace, document });
    return { vectorized: true, error: null };
  }),
  hasNamespace: jest.fn(async (namespace) =>
    mockVectorRecords.some((record) => record.namespace === namespace)
  ),
  namespaceCount: jest.fn(
    async (namespace) =>
      mockVectorRecords.filter((record) => record.namespace === namespace)
        .length
  ),
  performSimilaritySearch: jest.fn(async ({ namespace }) => {
    const records = mockVectorRecords.filter(
      (record) => record.namespace === namespace
    );
    return {
      contextTexts: records.map(({ document }) => document.pageContent),
      sources: records.map(({ document }) => ({
        title: document.title,
        chunk: document.pageContent,
        text: document.pageContent,
      })),
      message: null,
    };
  }),
};
const mockLlm = {
  defaultTemp: 0,
  promptWindowLimit: jest.fn(() => 4096),
  compressMessages: jest.fn(async ({ contextTexts }) => contextTexts),
  getChatCompletion: jest.fn(async (messages) => ({
    textResponse: `proof answer: ${messages.join(" ")}`,
    metrics: {},
  })),
};
jest.mock("../../utils/helpers", () => ({
  ...jest.requireActual("../../utils/helpers"),
  getVectorDbClass: jest.fn(() => mockVectorDb),
  resolveProviderConnector: jest.fn(async () => ({
    connector: mockLlm,
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
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const prisma = require("../../utils/prisma");
const { app } = require("../../index");
const { resetRequestControls } = require("../../utils/middleware/requestControls");
const { makeJWT } = require("../../utils/http");
const { bootHTTP } = require("../../utils/boot");

const password = "StrongPassword1!";
let apiKey;
let admin;
let member;
let assignedWorkspace;
let hiddenWorkspace;

async function auth(user) {
  return `Bearer ${makeJWT({ id: user.id, username: user.username })}`;
}

// T-4a (#25): raw `prisma.users.create` bypasses `User.create`, which is where
// the legacy-role -> grant sync lives. The engine reads grants, so a fixture
// user must be granted the same way production grants.
async function grantLegacyRole(prisma, user) {
  const {
    syncLegacyRoleGrant,
  } = require("../../utils/authorization/legacyRoleGrants");
  await syncLegacyRoleGrant(user, { db: prisma });
}

async function setMultiUserMode(enabled) {
  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: String(enabled) },
    create: { label: "multi_user_mode", value: String(enabled) },
  });
}

beforeAll(async () => {
  await resetRequestControls();
  const hash = bcrypt.hashSync(password, 4);
  admin = await prisma.users.create({
    data: {
      username: "admin-user",
      password: hash,
      role: "admin",
      seen_recovery_codes: true,
    },
  });
  await grantLegacyRole(prisma, admin);
  member = await prisma.users.create({
    data: {
      username: "member-user",
      password: hash,
      role: "default",
      seen_recovery_codes: true,
    },
  });
  await grantLegacyRole(prisma, member);
  assignedWorkspace = await prisma.workspaces.create({
    data: { name: "Assigned", slug: "assigned" },
  });
  hiddenWorkspace = await prisma.workspaces.create({
    data: { name: "Hidden", slug: "hidden" },
  });
  // T-4a (#25): membership IS workspace access now, and the grant is written by
  // WorkspaceUser.create. A raw prisma insert leaves the row without its grant,
  // which is exactly the drift this suite should catch, not reproduce.
  const { WorkspaceUser } = require("../../models/workspaceUsers");
  await WorkspaceUser.create(member.id, assignedWorkspace.id);
  apiKey = "apw-key-test-api-key-secret";
  const { digestSecret, keyPrefix } = require("../../utils/apiKeySecurity");
  // T-4b: /v1 checks the grant half too, so the key needs a creator holding grants for the
  // routes below. T-1's migration backfills super_admin for every `role: "admin"` user,
  // but it runs before this suite creates its users, so the same grant is written here.
  await prisma.principal_role_grants.create({
    data: {
      orgId: 1,
      principal_type: "user",
      principal_id: String(admin.id),
      role_id: (
        await prisma.roles.findFirstOrThrow({ where: { name: "super_admin", scope: "org" } })
      ).id,
    },
  });
  await prisma.api_keys.create({ data: { name: "test", secretDigest: digestSecret(apiKey), keyPrefix: keyPrefix(apiKey), scopes: JSON.stringify(["*"]), createdBy: admin.id } });
  await setMultiUserMode(true);
  global.fetch = jest.fn(async (url, options) => {
    if (!options) return { ok: true };
    if (!String(url).endsWith("/process"))
      throw new Error(`Unexpected collector URL: ${url}`);

    const { filename } = JSON.parse(options.body);
    const location = `custom-documents/${filename}.json`;
    const documentPath = path.join(
      process.env.STORAGE_DIR,
      "documents",
      location
    );
    fs.mkdirSync(path.dirname(documentPath), { recursive: true });
    fs.writeFileSync(
      documentPath,
      JSON.stringify({
        pageContent: fs.readFileSync(
          path.resolve(
            process.env.STORAGE_DIR,
            "../../collector/hotdir",
            filename
          ),
          "utf8"
        ),
        title: filename,
        chunkSource: filename,
      })
    );
    return {
      ok: true,
      json: async () => ({
        success: true,
        reason: null,
        documents: [{ location }],
      }),
    };
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("test harness guards", () => {
  test("importing server app does not open a listener", () => {
    expect(bootHTTP).not.toHaveBeenCalled();
  });
});

describe("login and JWT", () => {
  test("accepts valid admin credentials", async () => {
    const res = await request(app)
      .post("/api/request-token")
      .send({ username: admin.username, password });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  test("accepts valid member credentials", async () => {
    const res = await request(app)
      .post("/api/request-token")
      .send({ username: member.username, password });
    expect(res.body.valid).toBe(true);
  });

  test("rejects unknown username", async () => {
    const res = await request(app)
      .post("/api/request-token")
      .send({ username: "missing", password });
    expect(res.body).toMatchObject({ valid: false, token: null });
  });

  test("rejects wrong password", async () => {
    const res = await request(app)
      .post("/api/request-token")
      .send({ username: member.username, password: "wrong" });
    expect(res.body.valid).toBe(false);
  });

  test("does not reveal suspended account existence", async () => {
    await prisma.users.update({
      where: { id: member.id },
      data: { suspended: 1 },
    });
    const suspended = await request(app)
      .post("/api/request-token")
      .send({ username: member.username, password });
    const missing = await request(app)
      .post("/api/request-token")
      .send({ username: "missing-suspended-check", password });
    expect({ status: suspended.status, body: suspended.body }).toEqual({
      status: missing.status,
      body: missing.body,
    });
    await prisma.users.update({
      where: { id: member.id },
      data: { suspended: 0 },
    });
  });

  test("does not expose password in login response", async () => {
    const res = await request(app)
      .post("/api/request-token")
      .send({ username: member.username, password });
    expect(res.body.user.password).toBeUndefined();
  });

  test("issues verifiable JWT with user identity", async () => {
    const res = await request(app)
      .post("/api/request-token")
      .send({ username: member.username, password });
    expect(jwt.verify(res.body.token, process.env.JWT_SECRET)).toMatchObject({
      id: member.id,
      username: member.username,
    });
  });

  test("rejects malformed JWT", async () => {
    const res = await request(app)
      .get("/api/workspaces")
      .set("Authorization", "Bearer malformed");
    expect(res.status).toBe(401);
  });

  test("rejects JWT signed with another secret", async () => {
    const token = jwt.sign({ id: member.id }, "different-secret");
    const res = await request(app)
      .get("/api/workspaces")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  test("rejects expired JWT", async () => {
    const token = jwt.sign({ id: member.id }, process.env.JWT_SECRET, {
      expiresIn: -1,
    });
    const res = await request(app)
      .get("/api/workspaces")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  test("locks repeated login attempts before valid credentials", async () => {
    for (let attempt = 0; attempt < 5; attempt++)
      await request(app)
        .post("/api/request-token")
        .send({ username: "lock-target", password: "wrong" });
    const res = await request(app)
      .post("/api/request-token")
      .send({ username: "LOCK-TARGET", password });
    expect(res.status).toBe(429);
  });
});

describe("role gates", () => {
  const routes = [
    ["get", "/api/admin/users"],
    ["post", "/api/admin/users/new"],
    ["post", `/api/admin/user/${member?.id || 0}`],
    ["get", "/api/admin/invites"],
    ["get", "/api/admin/workspaces"],
  ];

  // T-4a (#25) API contract: unauthenticated 401, authenticated-but-unauthorized
  // 403, secret-existence 404. The old middleware answered 401 for everything,
  // which said "who are you?" to someone it had already identified.
  test.each(routes)("default user gets 403 on %s %s", async (method, route) => {
    const resolvedRoute = route.replace("/0", `/${member.id}`);
    const res = await request(app)
      [method](resolvedRoute)
      .set("Authorization", await auth(member))
      .send({});
    expect(res.status).toBe(403);
  });

  test("admin can list users", async () => {
    const res = await request(app)
      .get("/api/admin/users")
      .set("Authorization", await auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
  });
});

describe("workspace isolation", () => {
  test("member list contains assigned workspace", async () => {
    const res = await request(app)
      .get("/api/workspaces")
      .set("Authorization", await auth(member));
    expect(res.body.workspaces.map(({ slug }) => slug)).toContain("assigned");
  });

  test("member list omits unassigned workspace", async () => {
    const res = await request(app)
      .get("/api/workspaces")
      .set("Authorization", await auth(member));
    expect(res.body.workspaces.map(({ slug }) => slug)).not.toContain("hidden");
  });

  test("member can fetch assigned workspace", async () => {
    const res = await request(app)
      .get("/api/workspace/assigned")
      .set("Authorization", await auth(member));
    expect(res.body.workspace.slug).toBe("assigned");
  });

  test("member cannot fetch unassigned workspace", async () => {
    // T-4a (#25) strengthened this: the route used to answer 200 with
    // `workspace: null`, which confirms the slug exists to anyone who asks.
    // requirePermission now refuses before the handler runs, and a workspace the
    // caller may not read is indistinguishable from one that does not exist.
    const res = await request(app)
      .get("/api/workspace/hidden")
      .set("Authorization", await auth(member));
    expect(res.status).toBe(404);
    expect(res.body.workspace).toBeUndefined();
  });

  test("missing member token is rejected", async () => {
    expect((await request(app).get("/api/workspaces")).status).toBe(401);
  });
});

describe("API key auth", () => {
  test("accepts valid API key", async () => {
    const res = await request(app)
      .get("/api/v1/auth")
      .set("Authorization", `Bearer ${apiKey}`);
    expect(res.body).toEqual({ authenticated: true });
  });

  test("rejects invalid API key", async () => {
    expect(
      (
        await request(app)
          .get("/api/v1/auth")
          .set("Authorization", "Bearer wrong")
      ).status
    ).toBe(403);
  });

  test("rejects missing API key", async () => {
    expect((await request(app).get("/api/v1/auth")).status).toBe(403);
  });

  test("valid key lists workspaces", async () => {
    const res = await request(app)
      .get("/api/v1/workspaces")
      .set("Authorization", `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.workspaces).toHaveLength(2);
  });

  test("invalid key cannot list workspaces", async () => {
    expect(
      (
        await request(app)
          .get("/api/v1/workspaces")
          .set("Authorization", "Bearer wrong")
      ).status
    ).toBe(403);
  });
});

describe("document upload to query", () => {
  test("upload persists document through collector and embedding path", async () => {
    const res = await request(app)
      .post("/api/v1/document/upload")
      .set("Authorization", `Bearer ${apiKey}`)
      .field("addToWorkspaces", "assigned")
      .attach(
        "file",
        Buffer.from("proof content from uploaded artifact"),
        "proof.txt"
      );

    expect(res.status).toBe(200);
    expect(res.body.documents[0].location).toBe(
      "custom-documents/proof.txt.json"
    );
    expect(
      await prisma.workspace_documents.findFirst({
        where: { workspaceId: assignedWorkspace.id },
      })
    ).toMatchObject({ docpath: "custom-documents/proof.txt.json" });
  });

  test("query consumes artifact persisted by upload", async () => {
    const res = await request(app)
      .post("/api/v1/workspace/assigned/chat")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ message: "What is proof?", mode: "query" });

    expect(res.status).toBe(200);
    expect(res.body.textResponse).toContain(
      "proof content from uploaded artifact"
    );
    expect(res.body.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "proof.txt",
          chunk: "proof content from uploaded artifact",
        }),
      ])
    );
  });

  test("rejects upload without API key", async () => {
    expect((await request(app).post("/api/v1/document/upload")).status).toBe(
      403
    );
  });
});

describe("multi-user mode", () => {
  test("reports enabled mode publicly", async () => {
    expect(
      (await request(app).get("/api/system/multi-user-mode")).body.multiUserMode
    ).toBe(true);
  });

  test("API admin endpoint reports enabled mode", async () => {
    const res = await request(app)
      .get("/api/v1/admin/is-multi-user-mode")
      .set("Authorization", `Bearer ${apiKey}`);
    expect(res.body.isMultiUser).toBe(true);
  });

  test("toggle to single-user mode changes public report", async () => {
    await setMultiUserMode(false);
    expect(
      (await request(app).get("/api/system/multi-user-mode")).body.multiUserMode
    ).toBe(false);
    await setMultiUserMode(true);
  });
});

describe("API key failure oracle", () => {
  test.each([
    ["missing", null],
    ["wrong prefix", "Bearer wrong"],
    ["wrong digest", "Bearer apw-key-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
  ])("returns identical response for %s", async (_name, authorization) => {
    const call = request(app).get("/api/v1/auth");
    if (authorization) call.set("Authorization", authorization);
    const response = await call;
    expect({ status: response.status, body: response.body }).toEqual({
      status: 403,
      body: { error: "No valid api key found." },
    });
  });
});

describe("API key lifecycle denial", () => {
  test.each(["revokedAt", "expiresAt"])("rejects %s with generic response", async (field) => {
    const secret = `apw-key-${field}-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    const { digestSecret, keyPrefix } = require("../../utils/apiKeySecurity");
    const record = await prisma.api_keys.create({ data: {
      secretDigest: digestSecret(secret), keyPrefix: keyPrefix(secret), scopes: JSON.stringify(["*"]),
      [field]: new Date(field === "expiresAt" ? Date.now() - 1000 : Date.now()),
    } });
    const response = await request(app).get("/api/v1/auth").set("Authorization", `Bearer ${secret}`);
    expect({ status: response.status, body: response.body }).toEqual({ status: 403, body: { error: "No valid api key found." } });
    await prisma.api_keys.delete({ where: { id: record.id } });
  });
});

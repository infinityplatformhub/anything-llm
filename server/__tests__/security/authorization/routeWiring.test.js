const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `t4a_it_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

const MANAGER = { id: 4101, role: "manager", username: "t4a-manager" };
let prisma;
let Workspace;
let engine;
let repository;
let roles;
let workspaceA;
let workspaceB;
let threadA;
let chatA;
let chatInB;
let server;
let baseUrl;

jest.mock("../../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_request, response, next) => {
    response.locals.multiUserMode = true;
    response.locals.user = MANAGER;
    next();
  },
}));
jest.mock("../../../utils/middleware/multiUserProtected", () => {
  const actual = jest.requireActual(
    "../../../utils/middleware/multiUserProtected"
  );
  return {
    ...actual,
    flexUserRoleValid: () => (_request, _response, next) => next(),
  };
});
jest.mock("../../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
jest.mock("../../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn() },
}));
jest.mock("../../../utils/files/multer", () => ({
  handleFileUpload: (_request, _response, next) => next(),
}));

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith("postgresql://")) {
    throw new Error(
      "T-4a integration tests require DATABASE_URL pointing at PostgreSQL"
    );
  }
  const admin = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${testDb}"`);
  await admin.$disconnect();
  execSync(`npx prisma migrate deploy --schema ${SCHEMA}`, {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  execSync("node prisma/seed.js", {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });

  process.env.DATABASE_URL = testUrl;
  prisma = require("../../../utils/prisma");
  ({ Workspace } = require("../../../models/workspace"));
  const {
    DatabaseAuthorizationEngine,
  } = require("../../../utils/authorization/engine");
  repository = require("../../../utils/authorization/policyRepository");
  engine = new DatabaseAuthorizationEngine({ db: prisma });

  await prisma.users.create({
    data: {
      id: MANAGER.id,
      username: MANAGER.username,
      password: "unused",
      role: MANAGER.role,
    },
  });
  workspaceA = await prisma.workspaces.create({
    data: { name: "A", slug: `t4a-a-${dbSuffix}`, created_by: MANAGER.id },
  });
  workspaceB = await prisma.workspaces.create({
    data: { name: "B", slug: `t4a-b-${dbSuffix}` },
  });
  const ownerRole = await prisma.roles.findFirstOrThrow({
    where: { name: "owner", scope: "workspace" },
  });
  await prisma.workspace_users.create({
    data: {
      user_id: MANAGER.id,
      workspace_id: workspaceA.id,
      role_id: ownerRole.id,
    },
  });
  threadA = await prisma.workspace_threads.create({
    data: {
      name: "A thread",
      slug: `thread-a-${dbSuffix}`,
      workspace_id: workspaceA.id,
      user_id: MANAGER.id,
    },
  });
  chatA = await prisma.workspace_chats.create({
    data: {
      workspaceId: workspaceA.id,
      prompt: "secret",
      response: JSON.stringify({ text: "secret" }),
      user_id: MANAGER.id,
      thread_id: threadA.id,
    },
  });
  // Owned by MANAGER, but living in workspace B where MANAGER holds no
  // workspace_users row. The chat routes look up by (id, user_id) only, so
  // membership is never consulted — that is the S-3 gap T-4a must close.
  chatInB = await prisma.workspace_chats.create({
    data: {
      workspaceId: workspaceB.id,
      prompt: "b-secret",
      response: JSON.stringify({ text: "b-secret" }),
      user_id: MANAGER.id,
    },
  });
  roles = {
    owner: await prisma.roles.findFirstOrThrow({
      where: { name: "owner", scope: "workspace" },
    }),
    viewer: await prisma.roles.findFirstOrThrow({
      where: { name: "viewer", scope: "workspace" },
    }),
  };

  const express = require("express");
  const app = express();
  app.use(express.json());
  require("../../../endpoints/workspaces").workspaceEndpoints(app);
  require("../../../endpoints/workspaceThreads").workspaceThreadEndpoints(app);
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}, 300_000);

afterAll(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  if (prisma) await prisma.$disconnect();
  process.env.DATABASE_URL = baseDatabaseUrl;
  if (baseDatabaseUrl?.startsWith("postgresql://")) {
    const admin = new PrismaClient({
      datasources: { db: { url: baseDatabaseUrl } },
    });
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`
    );
    await admin.$disconnect();
  }
}, 60_000);

test("S-1: non-member manager requesting workspace by slug gets 404", async () => {
  const response = await fetch(`${baseUrl}/workspace/${workspaceB.slug}`);
  expect(response.status).toBe(404);
});

test("S-2: manager sees only workspaces where principal is a member", async () => {
  const workspaces = await Workspace.whereWithUser(MANAGER);
  expect(workspaces.map(({ id }) => id)).toEqual([workspaceA.id]);
});

test("S-3 regression (green today): workspace A thread ids stay denied against workspace B routes", async () => {
  // These already bind threadSlug to the workspace and must STAY 404 after the
  // rewrite. Not a RED — a guard so the route sweep does not loosen them.
  const cases = [
    ["GET", `/workspace/${workspaceB.slug}/thread/${threadA.slug}/chats`, undefined],
    ["POST", `/workspace/${workspaceB.slug}/thread/${threadA.slug}/update`, { name: "stolen" }],
    ["DELETE", `/workspace/${workspaceB.slug}/thread/${threadA.slug}`, undefined],
  ];
  const statuses = [];
  for (const [method, route, body] of cases) {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    statuses.push(response.status);
  }
  expect(statuses).toEqual([404, 404, 404]);
});

test("S-3: a chat in a workspace the actor is not a member of cannot be mutated", async () => {
  // PUT /workspace/workspace-chats/:id resolves by (id, user_id) and never
  // consults workspace membership (endpoints/workspaces.js:761-783), so a user
  // who owns a chat keeps write access to it after losing access to the
  // workspace that contains it.
  const response = await fetch(`${baseUrl}/workspace/workspace-chats/${chatInB.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(response.status).toBe(404);
});

test("G11 gate: purging a document addressed in another workspace is refused over HTTP", async () => {
  // Real prisma, real engine, real route stack — the mock-prisma guard suites
  // cannot prove this because they stub the gate away (PMO condition on the
  // pass-through mock).
  const docInB = await prisma.workspace_documents.create({
    data: {
      docId: `g11-${dbSuffix}`,
      filename: "b.json",
      docpath: `custom-documents/g11-${dbSuffix}.json`,
      workspaceId: workspaceB.id,
    },
  });
  // MANAGER is a member of A only, and holds no org-wide grant.
  const response = await fetch(
    `${baseUrl}/workspace/${workspaceA.slug}/remove-and-unembed`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentLocation: docInB.docpath }),
    }
  );
  expect(response.status).toBe(404);
  const survivor = await prisma.workspace_documents.findUnique({
    where: { id: docInB.id },
  });
  expect(survivor).not.toBeNull();
});

test("S-9 ingress: API-key scope cannot exceed creator permission", async () => {
  const creator = { type: "user", id: "4201", orgId: 1 };
  await prisma.users.create({
    data: { id: 4201, username: `limited-${dbSuffix}`, password: "unused" },
  });
  await repository.grantRole({
    actor: require("../../../utils/authorization/actorResolver")
      .SERVICE_PRINCIPALS.singleUser,
    principalType: "user",
    principalId: creator.id,
    roleId: roles.viewer.id,
    workspaceId: workspaceA.id,
    db: prisma,
  });
  const key = await prisma.api_keys.create({
    data: {
      name: "over-scoped",
      secretDigest: Buffer.from(crypto.randomBytes(32)),
      keyPrefix: `t4a${dbSuffix}`,
      scopes: JSON.stringify(["workspace.write"]),
      workspaceId: workspaceA.id,
      createdBy: Number(creator.id),
    },
  });
  await repository.grantRole({
    actor: require("../../../utils/authorization/actorResolver")
      .SERVICE_PRINCIPALS.singleUser,
    principalType: "service",
    principalId: `api-key:${key.id}`,
    roleId: roles.owner.id,
    workspaceId: workspaceA.id,
    db: prisma,
  });
  const decision = await engine.authorize({
    actor: {
      type: "service",
      id: `api-key:${key.id}`,
      orgId: 1,
      attributes: { scopes: ["workspace.write"] },
    },
    action: "workspace.write",
    resource: {
      type: "workspace",
      id: String(workspaceA.id),
      orgId: 1,
      workspaceId: workspaceA.id,
    },
  });
  expect(decision.allowed).toBe(false);
});

test("B-1: API key is allowed when creator holds grant and scope permits action", async () => {
  const creatorId = 4202;
  await prisma.users.create({
    data: {
      id: creatorId,
      username: `allowed-${dbSuffix}`,
      password: "unused",
    },
  });
  await repository.grantRole({
    actor: require("../../../utils/authorization/actorResolver")
      .SERVICE_PRINCIPALS.singleUser,
    principalType: "user",
    principalId: String(creatorId),
    roleId: roles.viewer.id,
    workspaceId: workspaceA.id,
    db: prisma,
  });
  const key = await prisma.api_keys.create({
    data: {
      name: "valid",
      secretDigest: Buffer.from(crypto.randomBytes(32)),
      keyPrefix: `ok${dbSuffix}`,
      scopes: JSON.stringify(["document.read"]),
      workspaceId: workspaceA.id,
      createdBy: creatorId,
    },
  });
  const decision = await engine.authorize({
    actor: {
      type: "service",
      id: `api-key:${key.id}`,
      orgId: 1,
      attributes: { scopes: ["document.read"] },
    },
    action: "document.read",
    resource: {
      type: "document",
      id: "1",
      orgId: 1,
      workspaceId: workspaceA.id,
    },
  });
  expect(decision.allowed).toBe(true);
});

test("W-6: authorizeMany accepts 500 resources and rejects 501", async () => {
  const actor = { type: "user", id: "4301", orgId: 1 };
  const resource = {
    type: "workspace",
    id: String(workspaceA.id),
    orgId: 1,
    workspaceId: workspaceA.id,
  };
  const decisions = await engine.authorizeMany({
    actor,
    action: "workspace.read",
    resources: Array(500).fill(resource),
  });
  expect(decisions.size).toBe(500);
  const {
    AuthorizationContractError,
  } = require("../../../utils/authorization/errors");
  await expect(
    engine.authorizeMany({
      actor,
      action: "workspace.read",
      resources: Array(501).fill(resource),
    })
  ).rejects.toBeInstanceOf(AuthorizationContractError);
});

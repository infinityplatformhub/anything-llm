const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

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
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
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
  // T-4b (#29), Techlead §7.7: a raw membership insert leaves the row without its grant,
  // so MANAGER is a member by the table and invisible to the engine — every assertion
  // below that expects a DENY would then pass for the wrong reason, and the ones that
  // expect an ALLOW would be the only thing catching it. Grant it the way production
  // does (WorkspaceUser.create → syncWorkspaceMembershipGrant), with this suite's own
  // client injected since the model binds the global one.
  const {
    syncWorkspaceMembershipGrant,
  } = require("../../../utils/authorization/legacyRoleGrants");
  const {
    SERVICE_PRINCIPALS,
  } = require("../../../utils/authorization/actorResolver");
  await syncWorkspaceMembershipGrant({
    userId: MANAGER.id,
    workspaceId: workspaceA.id,
    actor: SERVICE_PRINCIPALS.singleUser,
    db: prisma,
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
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
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

// S-9 ingress and B-1 (grants(creator) INTERSECT scopes(key)) moved to T-4b by
// PMO ruling 2026-09-02: both branches implemented B-1 and t4b's design won
// (resolver attaches grantPrincipal; the engine only reads it). The two tests
// are preserved verbatim at /tmp/t4a-b1-tests.js and handed to Dev4 — they are
// the acceptance bar for that design and must be re-armed there, not dropped.

test("membership grants workspace access; org membership alone does not", async () => {
  // ROOT CAUSE regression (T-1 migration 20260902020000:407-410): the org-wide
  // `member` role carried workspace.read, and the engine treats a NULL-workspace
  // grant as every workspace, so every ordinary user could read every workspace.
  const { User } = require("../../../models/user");
  const { WorkspaceUser } = require("../../../models/workspaceUsers");
  const { user: outsider } = await User.create({
    username: `outsider-${dbSuffix}`,
    password: "Aa!123456789",
    role: "default",
  });
  expect(outsider).not.toBeNull();

  // A user created AFTER the migration must still get their org grant, and that
  // grant must NOT reach into a workspace they do not belong to.
  const denied = await engine.authorize({
    actor: { type: "user", id: String(outsider.id), orgId: 1 },
    action: "workspace.read",
    resource: {
      type: "workspace",
      id: String(workspaceB.id),
      orgId: 1,
      workspaceId: workspaceB.id,
    },
  });
  expect(denied.allowed).toBe(false);

  // Joining the workspace grants access immediately.
  await WorkspaceUser.create(outsider.id, workspaceB.id);
  const allowed = await engine.authorize({
    actor: { type: "user", id: String(outsider.id), orgId: 1 },
    action: "workspace.read",
    resource: {
      type: "workspace",
      id: String(workspaceB.id),
      orgId: 1,
      workspaceId: workspaceB.id,
    },
  });
  expect(allowed.allowed).toBe(true);

  // Leaving takes it away again, with no cache to wait on.
  await WorkspaceUser.delete({ user_id: outsider.id, workspace_id: workspaceB.id });
  const revoked = await engine.authorize({
    actor: { type: "user", id: String(outsider.id), orgId: 1 },
    action: "workspace.read",
    resource: {
      type: "workspace",
      id: String(workspaceB.id),
      orgId: 1,
      workspaceId: workspaceB.id,
    },
  });
  expect(revoked.allowed).toBe(false);
});

test("a demoted admin loses the org role the same moment", async () => {
  const { User } = require("../../../models/user");
  const { user: promoted } = await User.create({
    username: `demote-${dbSuffix}`,
    password: "Aa!123456789",
    role: "admin",
  });
  const asAdmin = await engine.authorize({
    actor: { type: "user", id: String(promoted.id), orgId: 1 },
    action: "user.manage",
    resource: { type: "org", id: "1", orgId: 1, workspaceId: null },
  });
  expect(asAdmin.allowed).toBe(true);

  await User.update(promoted.id, { role: "manager" });
  const afterDemotion = await engine.authorize({
    actor: { type: "user", id: String(promoted.id), orgId: 1 },
    action: "user.manage",
    resource: { type: "org", id: "1", orgId: 1, workspaceId: null },
  });
  expect(afterDemotion.allowed).toBe(false);
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

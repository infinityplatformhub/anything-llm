/**
 * #40 task 3: the UI gates affordances, the server gates access.
 *
 * Task 3 replaces role-string checks with `can(action)`, and task 4 rewires 21
 * sites onto it. That is only safe because a wrong answer from `can()` costs
 * nothing — a hidden button that should be shown is an inconvenience, a shown
 * button that should be hidden is a refused request, not an escalation.
 *
 * This suite is the proof of that sentence. It drives the real routes behind
 * every capability task 4 maps, with a principal that holds no grant at all,
 * and asserts refusal. If any of these ever answers 2xx, the whole premise of
 * moving the UI onto capabilities is void — and the failure would otherwise
 * only ever be visible to someone who thought to bypass the UI.
 *
 * Deliberately server-side: "the server still refuses" is a claim about the
 * server. It needs no DOM and therefore does not wait on the frontend test
 * harness (#111).
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "t3-bypass-")
  );
process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER || "ui-bypass-api-key-pepper-32-bytes-minimum";

const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const express = require("express");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `t3_bypass_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

// A real user row holding the org `member` role and nothing else: exactly the
// principal whose UI would, before task 4, be gated by `role === "default"`.
const ACTOR = { id: 9000 + (process.pid % 900) };

let mockLocals = null;
jest.mock("../../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_request, response, next) => {
    Object.assign(response.locals, mockLocals);
    next();
  },
}));

let prisma;
let server;
let baseUrl;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    throw new Error("#40 task 3 bypass tests require DATABASE_URL on PostgreSQL");
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
  execSync(`node prisma/seed.js`, {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  process.env.DATABASE_URL = testUrl;

  jest.resetModules();
  prisma = require("../../../utils/prisma");
  const repository = require("../../../utils/authorization/policyRepository");
  const {
    SERVICE_PRINCIPALS,
  } = require("../../../utils/authorization/actorResolver");

  await prisma.users.create({
    data: { id: ACTOR.id, username: `bypass-${dbSuffix}`, password: "unused" },
  });
  const memberRole = await prisma.roles.findFirstOrThrow({
    where: { name: "member", scope: "org" },
  });
  await repository.grantRole({
    actor: SERVICE_PRINCIPALS.singleUser,
    principalType: "user",
    principalId: String(ACTOR.id),
    roleId: memberRole.id,
    db: prisma,
  });

  const { systemEndpoints } = require("../../../endpoints/system");
  const { adminEndpoints } = require("../../../endpoints/admin");
  const { workspaceEndpoints } = require("../../../endpoints/workspaces");
  const app = express();
  app.use(express.json());
  systemEndpoints(app);
  adminEndpoints(app);
  workspaceEndpoints(app);
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

beforeEach(() => {
  mockLocals = { multiUserMode: true, user: { id: ACTOR.id, suspended: 0 } };
});

// Every route behind a capability task 4 maps onto `can()`. The line numbers are
// where the gate sits today; the assertion is on behaviour, so moving a route
// does not silently drop it from this list -- a removed gate answers 2xx.
const GATED_ROUTES = [
  // settings.write -- AdminRoute, SettingsButton, SettingsSidebar,
  // keyboardShortcuts, LLMSelector, WorkspaceModelPicker, ToolsMenu, Memories
  ["settings.write", "GET", "/env-dump", null],
  ["settings.write", "POST", "/onboarding", {}],
  ["settings.write", "POST", "/system/default-system-prompt", { prompt: "x" }],
  // user.manage -- ManagerRoute, NewUserModal, EditUserModal
  ["user.manage", "POST", "/admin/users/new", { username: "x", password: "y" }],
  ["user.manage", "POST", `/admin/user/${9999}`, { username: "x" }],
  ["user.manage", "DELETE", `/admin/user/${9999}`, null],
  ["user.manage", "POST", `/admin/view-as-user/${9999}`, {}],
  // workspace.create -- Sidebar:161, NewWorkspaceButton:193, SearchBox, Home
  ["workspace.create", "POST", "/workspace/new", { name: "nope" }],
  ["workspace.create", "POST", "/admin/workspaces/new", { name: "nope" }],
];

describe("#40 task 3: a principal the UI would have hidden is refused by the server", () => {
  test.each(GATED_ROUTES)(
    "%s: %s %s is refused",
    async (_capability, method, route, body) => {
      const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      // 403 (forbidden) or 404 (refused without confirming existence) both mean
      // refused. What must never appear is 2xx: that is the request going
      // through, which is what a UI-only gate would allow.
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect([403, 404]).toContain(response.status);
    }
  );

  test("the fixture principal is real and authenticated, not merely unknown", async () => {
    // Without this, every assertion above could be passing because the actor
    // failed to resolve at all -- a suite that proves the routes refuse
    // NOBODY, which they would do even with the gates deleted.
    const response = await fetch(`${baseUrl}/system/my-capabilities`);
    expect(response.status).toBe(200);
    const body = await response.json();
    const { ORG_CAPABILITIES } = require("../../../endpoints/system");
    expect(Object.keys(body.capabilities).sort()).toEqual(
      [...ORG_CAPABILITIES].sort()
    );
    // Answered, and answered false: a resolved principal holding no org grant.
    expect(body.capabilities["settings.write"]).toBe(false);
    expect(body.capabilities["user.manage"]).toBe(false);
    expect(body.capabilities["workspace.create"]).toBe(false);
  });

  test("granting the capability flips both the map and the route", async () => {
    // The other direction: these routes are not simply always-403. If they
    // were, the suite above would pass against a server that refuses
    // everything, and would say nothing about the gates.
    const repository = require("../../../utils/authorization/policyRepository");
    const {
      SERVICE_PRINCIPALS,
    } = require("../../../utils/authorization/actorResolver");
    const adminRole = await prisma.roles.findFirstOrThrow({
      where: { name: "super_admin", scope: "org" },
    });
    await repository.grantRole({
      actor: SERVICE_PRINCIPALS.singleUser,
      principalType: "user",
      principalId: String(ACTOR.id),
      roleId: adminRole.id,
      db: prisma,
    });

    const caps = await fetch(`${baseUrl}/system/my-capabilities`).then((r) =>
      r.json()
    );
    expect(caps.capabilities["workspace.create"]).toBe(true);

    const created = await fetch(`${baseUrl}/workspace/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `bypass-ok-${dbSuffix}` }),
    });
    expect(created.status).toBeLessThan(400);
  });
});

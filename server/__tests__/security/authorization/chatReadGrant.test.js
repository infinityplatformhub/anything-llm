// #63: `chat.read` reaches the roles that need it.
//
// The permission was seeded (20260902020000:238) and granted to nobody but
// super_admin, so the four routes gated on it answered 404 to every ordinary
// user asking for their own chat history. This suite pins the grant at both
// levels the bug lived at: the engine decision, and the HTTP route that turns a
// denial into a concealed 404.
//
// Real Postgres, real migrations, real route stack — a mocked engine would
// prove nothing here, since the defect was in the seeded policy rows.
process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "g63-chat-read-")
  );
const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `g63_chatread_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

const MEMBER = { id: 6301, role: "default", username: `g63-member-${dbSuffix}` };
const ADMIN = { id: 6302, role: "admin", username: `g63-admin-${dbSuffix}` };

let prisma;
let engine;
let workspace;
let thread;
let server;
let baseUrl;

jest.mock("../../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_request, response, next) => {
    response.locals.multiUserMode = true;
    response.locals.user = global.__G63_CURRENT_USER__;
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

const asUser = (user) => {
  global.__G63_CURRENT_USER__ = user;
};

const decide = (user, action, resource) =>
  engine.authorize({
    actor: { type: "user", id: String(user.id), orgId: 1 },
    action,
    resource,
  });

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    throw new Error("#63 tests require DATABASE_URL pointing at PostgreSQL");
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
  jest.resetModules();
  prisma = require("../../../utils/prisma");
  const {
    DatabaseAuthorizationEngine,
  } = require("../../../utils/authorization/engine");
  engine = new DatabaseAuthorizationEngine({ db: prisma });

  const {
    syncWorkspaceMembershipGrant,
  } = require("../../../utils/authorization/legacyRoleGrants");
  const {
    SERVICE_PRINCIPALS,
  } = require("../../../utils/authorization/actorResolver");

  for (const user of [MEMBER, ADMIN]) {
    await prisma.users.create({
      data: {
        id: user.id,
        username: user.username,
        password: "unused",
        role: user.role,
      },
    });
  }
  // The org grant is what a real signup produces; without it MEMBER would hold
  // nothing at all and every denial below would pass for the wrong reason.
  const {
    syncLegacyRoleGrant,
  } = require("../../../utils/authorization/legacyRoleGrants");
  for (const user of [MEMBER, ADMIN]) {
    await syncLegacyRoleGrant(user, { db: prisma });
  }

  workspace = await prisma.workspaces.create({
    data: { name: "G63", slug: `g63-ws-${dbSuffix}`, created_by: MEMBER.id },
  });
  thread = await prisma.workspace_threads.create({
    data: {
      name: "G63 thread",
      slug: `g63-thread-${dbSuffix}`,
      workspace_id: workspace.id,
      user_id: MEMBER.id,
    },
  });

  // Membership through the production path (§7.7): a raw workspace_users insert
  // leaves the row without its grant.
  const editorRole = await prisma.roles.findFirstOrThrow({
    where: { name: "editor", scope: "workspace" },
  });
  await prisma.workspace_users.create({
    data: {
      user_id: MEMBER.id,
      workspace_id: workspace.id,
      role_id: editorRole.id,
    },
  });
  await syncWorkspaceMembershipGrant({
    userId: MEMBER.id,
    workspaceId: workspace.id,
    actor: SERVICE_PRINCIPALS.singleUser,
    db: prisma,
  });

  await prisma.workspace_chats.create({
    data: {
      workspaceId: workspace.id,
      prompt: "my own question",
      response: JSON.stringify({ text: "my own answer" }),
      user_id: MEMBER.id,
    },
  });
  await prisma.workspace_chats.create({
    data: {
      workspaceId: workspace.id,
      prompt: "my threaded question",
      response: JSON.stringify({ text: "my threaded answer" }),
      user_id: MEMBER.id,
      thread_id: thread.id,
    },
  });

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
  asUser(MEMBER);
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

const workspaceResource = () => ({
  type: "workspace",
  id: String(workspace.id),
  orgId: 1,
  workspaceId: workspace.id,
});

describe("issue 63: chat.read reaches the roles that need it", () => {
  // THE RED. Before migration 101000 this returns
  // {allowed: false, reason: "no_permission_in_roles"}.
  test("a workspace editor is allowed chat.read", async () => {
    const decision = await decide(MEMBER, "chat.read", workspaceResource());
    expect(decision).toMatchObject({ allowed: true });
  });

  test("every seeded workspace role holds chat.read", async () => {
    const holders = await prisma.$queryRaw`
      SELECT r."name", r."scope"
        FROM "role_permissions" rp
        JOIN "roles" r ON r."id" = rp."role_id"
        JOIN "permissions" p ON p."id" = rp."permission_id"
       WHERE p."action" = 'chat.read'
       ORDER BY r."scope", r."name"
    `;
    // Exact, not arrayContaining: the point of this test is that org `member`
    // is NOT here. A containment assertion would stay green if it came back.
    expect(holders).toEqual([
      { name: "super_admin", scope: "org" },
      { name: "editor", scope: "workspace" },
      { name: "owner", scope: "workspace" },
      { name: "viewer", scope: "workspace" },
    ]);
  });

  // The routes are where the bug was visible: a denial here conceals as 404, so
  // the user is told their own history does not exist.
  test("a member gets 200 on their own workspace chat history", async () => {
    asUser(MEMBER);
    const response = await fetch(`${baseUrl}/workspace/${workspace.slug}/chats`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.history.length).toBeGreaterThan(0);
  });

  // A 404 on this route has TWO causes: the chat.read gate, and
  // validWorkspaceAndThreadSlug filtering the thread by user_id (a thread
  // belongs to whoever made it). MEMBER owns this thread, so the only thing
  // that can 404 here is the gate — which is what makes this green mean
  // something. The next test proves the two causes really are separable rather
  // than one of them masking the other (§7.9).
  test("a member gets 200 on their own thread chat history", async () => {
    asUser(MEMBER);
    const response = await fetch(
      `${baseUrl}/workspace/${workspace.slug}/thread/${thread.slug}/chats`
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.history.length).toBeGreaterThan(0);
  });

  // The ownership filter is not the gate, and this migration must not have
  // loosened it: a workspace member holding chat.read still cannot read a thread
  // that belongs to someone else. If this ever goes green as 200, the grant has
  // reached further than it should; if the test above ever passes while this one
  // does too, one of the two 404 causes has stopped working.
  test("chat.read does not open another user's thread", async () => {
    const otherOwner = await prisma.users.create({
      data: {
        username: `g63-threadowner-${dbSuffix}`,
        password: "unused",
        role: "default",
      },
    });
    const foreignThread = await prisma.workspace_threads.create({
      data: {
        name: "not yours",
        slug: `g63-foreign-${dbSuffix}`,
        workspace_id: workspace.id,
        user_id: otherOwner.id,
      },
    });

    asUser(MEMBER);
    // Premise guard: MEMBER passes the gate for this workspace, so a 404 below
    // is the ownership filter and nothing else.
    const gate = await decide(MEMBER, "chat.read", workspaceResource());
    expect(gate.allowed).toBe(true);

    const response = await fetch(
      `${baseUrl}/workspace/${workspace.slug}/thread/${foreignThread.slug}/chats`
    );
    expect(response.status).toBe(404);
  });
});

describe("issue 63: the grant is scoped, not a widening", () => {
  // chat.read is "my own history". Reading everyone's is chat.read_others, and
  // this migration must not have handed that out by accident.
  test("no workspace role gains chat.read_others", async () => {
    const holders = await prisma.$queryRaw`
      SELECT r."name", r."scope"
        FROM "role_permissions" rp
        JOIN "roles" r ON r."id" = rp."role_id"
        JOIN "permissions" p ON p."id" = rp."permission_id"
       WHERE p."action" = 'chat.read_others'
       ORDER BY r."name"
    `;
    expect(holders).toEqual([
      { name: "content_moderator", scope: "org" },
      { name: "super_admin", scope: "org" },
    ]);
  });

  test("an editor is still denied chat.read_others", async () => {
    const decision = await decide(
      MEMBER,
      "chat.read_others",
      workspaceResource()
    );
    expect(decision.allowed).toBe(false);
  });

  // content_moderator holds chat.read_others and not chat.read, and the engine
  // has no implication between them — so it reaches its own history exactly the
  // way everyone else does, through workspace membership. Granting chat.read at
  // org scope to fix that would reintroduce the leak above.
  test("a content_moderator outside the workspace is still refused its chat history", async () => {
    const moderator = await prisma.users.create({
      data: {
        username: `g63-moderator-${dbSuffix}`,
        password: "unused",
        role: "default",
      },
    });
    const moderatorRole = await prisma.roles.findFirstOrThrow({
      where: { name: "content_moderator", scope: "org" },
    });
    await prisma.principal_role_grants.create({
      data: {
        orgId: 1,
        principal_type: "user",
        principal_id: String(moderator.id),
        role_id: moderatorRole.id,
        workspace_id: null,
      },
    });

    // Premise guard: the role really is in effect, so the 404 below is the
    // absence of chat.read and not a grant that failed to land.
    const others = await decide(
      moderator,
      "chat.read_others",
      { type: "org", id: "1", orgId: 1, workspaceId: null }
    );
    expect(others.allowed).toBe(true);

    asUser({ id: moderator.id, role: "default", username: moderator.username });
    const response = await fetch(`${baseUrl}/workspace/${workspace.slug}/chats`);
    expect(response.status).toBe(404);
  });

  // chat.read is a gate, not a row filter: holding it must not turn the history
  // routes into a view of everyone's chats in the workspace. The row filter is
  // the route's own (forWorkspaceByUser / the thread where-clause), and this
  // pins that the grant did not quietly widen what those return.
  test("holding chat.read returns only the caller's own chats", async () => {
    const neighbour = await prisma.users.create({
      data: {
        username: `g63-neighbour-${dbSuffix}`,
        password: "unused",
        role: "default",
      },
    });
    const {
      syncWorkspaceMembershipGrant,
    } = require("../../../utils/authorization/legacyRoleGrants");
    const {
      SERVICE_PRINCIPALS,
    } = require("../../../utils/authorization/actorResolver");
    const editorRole = await prisma.roles.findFirstOrThrow({
      where: { name: "editor", scope: "workspace" },
    });
    await prisma.workspace_users.create({
      data: {
        user_id: neighbour.id,
        workspace_id: workspace.id,
        role_id: editorRole.id,
      },
    });
    await syncWorkspaceMembershipGrant({
      userId: neighbour.id,
      workspaceId: workspace.id,
      actor: SERVICE_PRINCIPALS.singleUser,
      db: prisma,
    });

    const NEIGHBOUR_SECRET = "neighbour-private-line";
    await prisma.workspace_chats.create({
      data: {
        workspaceId: workspace.id,
        prompt: NEIGHBOUR_SECRET,
        response: JSON.stringify({ text: NEIGHBOUR_SECRET }),
        user_id: neighbour.id,
      },
    });
    const neighbourThread = await prisma.workspace_threads.create({
      data: {
        name: "neighbour thread",
        slug: `g63-nthread-${dbSuffix}`,
        workspace_id: workspace.id,
        user_id: neighbour.id,
      },
    });
    await prisma.workspace_chats.create({
      data: {
        workspaceId: workspace.id,
        prompt: NEIGHBOUR_SECRET,
        response: JSON.stringify({ text: NEIGHBOUR_SECRET }),
        user_id: neighbour.id,
        thread_id: neighbourThread.id,
      },
    });

    asUser(MEMBER);
    const workspaceHistory = await (
      await fetch(`${baseUrl}/workspace/${workspace.slug}/chats`)
    ).json();
    const threadHistory = await (
      await fetch(
        `${baseUrl}/workspace/${workspace.slug}/thread/${thread.slug}/chats`
      )
    ).json();

    const rendered = JSON.stringify([workspaceHistory, threadHistory]);
    expect(rendered).not.toContain(NEIGHBOUR_SECRET);
    // Guard the premise: an empty response would also "not contain" it.
    expect(workspaceHistory.history.length).toBeGreaterThan(0);
    expect(threadHistory.history.length).toBeGreaterThan(0);
  });

  test("super_admin is unchanged", async () => {
    const decision = await decide(ADMIN, "chat.read", workspaceResource());
    expect(decision.allowed).toBe(true);
  });

  // This is the test that overturned the first ruling. Granting chat.read to org
  // `member` made it 200: org grants carry workspace_id NULL, and the engine
  // reads that as every workspace — the same shape as the T-1 regression
  // routeWiring.test.js pins for workspace.read. It stays as the guard against
  // that grant coming back.
  test("an org member who is not in the workspace is still refused its chat history", async () => {
    const { User } = require("../../../models/user");
    const { user: outsider } = await User.create({
      username: `g63-outsider-${dbSuffix}`,
      password: "Aa!123456789",
      role: "default",
    });
    expect(outsider).not.toBeNull();

    // Premise guard (Techlead-1 NIT-1): the outsider must actually hold the org
    // `member` grant. With no grant at all the 404 below would prove nothing —
    // it would just be a user with no permissions anywhere.
    const grants = await prisma.principal_role_grants.findMany({
      where: { principal_type: "user", principal_id: String(outsider.id) },
      select: { workspace_id: true, role_id: true },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0].workspace_id).toBeNull();
    const memberRole = await prisma.roles.findFirstOrThrow({
      where: { name: "member", scope: "org" },
    });
    expect(grants[0].role_id).toBe(memberRole.id);

    asUser({ id: outsider.id, role: "default", username: outsider.username });
    const response = await fetch(`${baseUrl}/workspace/${workspace.slug}/chats`);
    expect(response.status).toBe(404);
  });
});

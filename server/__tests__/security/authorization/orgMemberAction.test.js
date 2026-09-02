/**
 * issue 53: `org.member` — an action that means "is a real principal of this org",
 * and the permission-scope guard that keeps it from meaning anything more.
 *
 * Seven routes gated on `chat.send` while asking that question; the handler then
 * filtered by membership. `chat.send` became the proxy in T-4a because it was the
 * only permission the org `member` role still held. Since T-7's R5 blanket deny
 * that is also a live bug: `chat.send` is not a read, so a view-as-user session
 * could not list its own workspaces.
 *
 * The obvious fix — seeding `workspace.read` onto org `member` — was measured on
 * a fresh database during #52 and is the migration-044000 vulnerability again:
 * every user holds an org-wide (`workspace_id NULL`) member grant, and evaluate()
 * reads that as matching EVERY resource workspace without consulting
 * workspace_users. So the new action must be unanswerable about a workspace, and
 * the engine — not a convention — is what refuses.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "s53-")
  );
process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER || "s53-api-key-pepper-32-bytes-minimum-ok";
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "test-jwt-secret-at-least-12-chars";

const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `s53_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;
let engine;
let AuthorizationContractError;
let member;
let workspace;

const orgResource = () => ({
  type: "org",
  id: "1",
  orgId: 1,
  workspaceId: null,
});
const workspaceResource = () => ({
  type: "workspace",
  id: String(workspace.id),
  orgId: 1,
  workspaceId: workspace.id,
});
const actorFor = (user, extra = {}) => ({
  type: "user",
  id: String(user.id),
  orgId: 1,
  ...extra,
});

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
    throw new Error("issue 53 integration tests require PostgreSQL");
  const root = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await root.$executeRawUnsafe(`CREATE DATABASE "${testDb}"`);
  await root.$disconnect();
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

  // §7.10: utils/prisma binds DATABASE_URL at first require, and --runInBand
  // shares one process.
  jest.resetModules();
  prisma = require("../../../utils/prisma");
  const {
    DatabaseAuthorizationEngine,
  } = require("../../../utils/authorization/engine");
  ({
    AuthorizationContractError,
  } = require("../../../utils/authorization/errors"));
  engine = new DatabaseAuthorizationEngine();

  const repository = require("../../../utils/authorization/policyRepository");
  const {
    SERVICE_PRINCIPALS,
  } = require("../../../utils/authorization/actorResolver");

  member = await prisma.users.create({
    data: {
      username: `s53-member-${dbSuffix}`,
      password: "unused",
      role: "default",
    },
  });
  // A workspace the member has NO membership row for. That is the whole point of
  // DoD 3: the org-wide grant must not reach it.
  workspace = await prisma.workspaces.create({
    data: { name: "s53-ws", slug: `s53-ws-${dbSuffix}` },
  });

  const memberRole = await prisma.roles.findFirstOrThrow({
    where: { name: "member", scope: "org" },
  });
  await repository.grantRole({
    actor: SERVICE_PRINCIPALS.singleUser,
    principalType: "user",
    principalId: String(member.id),
    roleId: memberRole.id,
    db: prisma,
  });
}, 300_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  process.env.DATABASE_URL = baseDatabaseUrl;
  const root = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await root.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
  await root.$disconnect();
}, 60_000);

describe("issue 53: the fixture is the shape the vulnerability needs", () => {
  test("the member holds an ORG-WIDE grant and zero workspace memberships", async () => {
    // If either half were false, every assertion below would be vacuous: an
    // org-wide grant is what makes workspace.read dangerous, and a membership
    // row would make the denial come from the wrong place.
    const grants = await prisma.principal_role_grants.findMany({
      where: { principal_type: "user", principal_id: String(member.id) },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0].workspace_id).toBeNull();
    expect(
      await prisma.workspace_users.count({ where: { user_id: member.id } })
    ).toBe(0);
  });
});

describe("issue 53: org.member answers membership, and nothing else", () => {
  test("DoD 4: allowed at org scope", async () => {
    const decision = await engine.authorize({
      actor: actorFor(member),
      action: "org.member",
      resource: orgResource(),
    });
    expect(decision.allowed).toBe(true);
  });

  test("DoD 3: the same user is DENIED workspace.read on a workspace they do not belong to", async () => {
    // The 044000 regression, asserted directly rather than trusted. This is the
    // test that would have caught the refused addendum.
    const decision = await engine.authorize({
      actor: actorFor(member),
      action: "workspace.read",
      resource: workspaceResource(),
    });
    expect(decision.allowed).toBe(false);
  });

  test("asked about a workspace, org.member THROWS rather than answering", async () => {
    // A contract error, not a deny: the route asked a question this action
    // cannot answer, which is a wiring bug. A silent deny would let a miswired
    // gate read as an ordinary refusal and survive review.
    await expect(
      engine.authorize({
        actor: actorFor(member),
        action: "org.member",
        resource: workspaceResource(),
      })
    ).rejects.toThrow(AuthorizationContractError);
    await expect(
      engine.authorize({
        actor: actorFor(member),
        action: "org.member",
        resource: workspaceResource(),
      })
    ).rejects.toThrow(/org_scoped_action_on_workspace_resource/);
  });

  test("the throw does not depend on the actor holding the action", async () => {
    // A stranger with no grants at all still gets the contract error, because
    // the shape is wrong before anyone's permissions are consulted. If this
    // returned no_grants, the check had been moved after the grant read.
    const stranger = await prisma.users.create({
      data: {
        username: `s53-stranger-${dbSuffix}`,
        password: "unused",
        role: "default",
      },
    });
    await expect(
      engine.authorize({
        actor: actorFor(stranger),
        action: "org.member",
        resource: workspaceResource(),
      })
    ).rejects.toThrow(AuthorizationContractError);
  });
});

describe("issue 53: impersonation", () => {
  test("DoD 1: an impersonated actor is ALLOWED org.member", async () => {
    // The #52 residual. R5 denies every non-read action for an impersonated
    // actor, and chat.send is not a read — so view-as-user could not list
    // workspaces. org.member is authority-free, so it belongs in READ_ACTIONS.
    const decision = await engine.authorize({
      actor: actorFor(member, { impersonatedBy: 999 }),
      action: "org.member",
      resource: orgResource(),
    });
    expect(decision.allowed).toBe(true);
  });

  test("DoD 2: an impersonated actor is still DENIED chat.send", async () => {
    // Without this, #53 reads as "impersonation restrictions relaxed".
    const decision = await engine.authorize({
      actor: actorFor(member, { impersonatedBy: 999 }),
      action: "chat.send",
      resource: orgResource(),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("impersonated_mutation_denied");
  });

  test("R5 is not overtaken by the scope check", async () => {
    // Ordering, asserted. An impersonated actor asking a wrongly-scoped
    // MUTATION must still hit the blanket deny: R5 runs in authorize() and
    // touches no database, so a denied actor cannot make the policy store work.
    const decision = await engine.authorize({
      actor: actorFor(member, { impersonatedBy: 999 }),
      action: "chat.send",
      resource: workspaceResource(),
    });
    expect(decision.reason).toBe("impersonated_mutation_denied");
  });
});

describe("issue 53: the seeded vocabulary", () => {
  test("org.member is scoped 'org' in the permissions table", async () => {
    const row = await prisma.permissions.findUnique({
      where: { action: "org.member" },
    });
    expect(row).not.toBeNull();
    expect(row.scope).toBe("org");
  });

  test("every other action still defaults to 'any'", async () => {
    // The column must be inert for everything that did not opt in, or a
    // migration silently changes how unrelated actions answer.
    //
    // The list is derived from ACTION_SCOPES rather than written out, so adding
    // a scoped action is ONE edit (the map) instead of two that can disagree.
    // #138 added `directory.sync` here; before that the literal was a single
    // entry and this test is what caught the addition, which is the intent.
    const {
      ACTION_SCOPES,
    } = require("../../../prisma/seeds/permissions");
    const scoped = await prisma.permissions.findMany({
      where: { scope: { not: "any" } },
      select: { action: true, scope: true },
      orderBy: { action: "asc" },
    });
    const expected = Object.entries(ACTION_SCOPES)
      .map(([action, scope]) => ({ action, scope }))
      .sort((a, b) => a.action.localeCompare(b.action));
    expect(scoped).toEqual(expected);
    // Non-vacuous: an empty ACTION_SCOPES would make the equality above trivially
    // true while every scoped action had silently reverted to 'any'.
    expect(expected.length).toBeGreaterThan(0);
  });

  test("NIT: the JS scope map and the database agree", async () => {
    // Two sources of the same fact — ACTION_SCOPES drives the seed file, the
    // column drives the engine. If they drift, the engine enforces a scope no
    // author declared, or ignores one they did.
    const {
      ACTION_SCOPES,
    } = require("../../../prisma/seeds/permissions");
    const rows = await prisma.permissions.findMany({
      where: { scope: { not: "any" } },
      select: { action: true, scope: true },
      orderBy: { action: "asc" },
    });
    const fromDb = Object.fromEntries(rows.map((r) => [r.action, r.scope]));
    expect(fromDb).toEqual(ACTION_SCOPES);
    // Non-vacuous: an empty map on both sides would satisfy the equality above.
    expect(Object.keys(fromDb).length).toBeGreaterThan(0);
  });

  test("ORG_CAPABILITIES holds no org-scoped action", async () => {
    // authorizeMany re-throws a contract error for the WHOLE batch, so one
    // org-scoped action in this list would take every capability down with it —
    // /system/capabilities would 500 instead of answering. Asserted rather than
    // left to the comment in system.js.
    const {
      ACTION_SCOPES,
    } = require("../../../prisma/seeds/permissions");
    const source = require("fs").readFileSync(
      require("path").join(SERVER_DIR, "endpoints/system.js"),
      "utf8"
    );
    const block = source
      .split("const ORG_CAPABILITIES = [")[1]
      .split("];")[0];
    const listed = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(0);
    const orgScoped = listed.filter((a) => ACTION_SCOPES[a] === "org");
    expect(orgScoped).toEqual([]);
  });

  test("a contract error from a route gate is a 500, not a 503", async () => {
    // requirePermission maps AuthorizationContractError to 500 and
    // AuthorizationUnavailableError to 503. The distinction matters: 503 says
    // "retry, the store is down", and a miswired gate would retry forever.
    const source = require("fs").readFileSync(
      require("path").join(SERVER_DIR, "utils/middleware/requirePermission.js"),
      "utf8"
    );
    const contractBranch = source
      .split("error instanceof AuthorizationContractError")[1]
      .split("}")[0];
    expect(contractBranch).toContain("sendStatus(500)");
    expect(contractBranch).not.toContain("503");
  });

  test("the org member role carries NOTHING but chat.send and org.member", async () => {
    // §3: the migration must prove it did not seed authority onto the org-wide
    // role, not merely avoid doing so. An org-wide grant matches every
    // workspace, so anything else here is 044000 again.
    const role = await prisma.roles.findFirstOrThrow({
      where: { name: "member", scope: "org" },
    });
    const rows = await prisma.role_permissions.findMany({
      where: { role_id: role.id },
      include: { permissions: true },
    });
    expect(rows.map((r) => r.permissions.action).sort()).toEqual([
      "chat.send",
      "org.member",
    ]);
  });

  test("all four org roles hold it; workspace roles do not", async () => {
    const rows = await prisma.role_permissions.findMany({
      where: { permissions: { action: "org.member" } },
      include: { roles: true },
    });
    expect(rows.map((r) => r.roles.name).sort()).toEqual([
      "content_moderator",
      "member",
      "setup_admin",
      "super_admin",
    ]);
    // Workspace-scoped roles are granted per workspace, so an org-only action
    // reached through them would be unaskable by construction.
    expect(rows.every((r) => r.roles.scope === "org")).toBe(true);
  });
});

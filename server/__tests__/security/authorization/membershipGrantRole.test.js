// T-4b (#29), Techlead §7.7 item 2 — the grant must follow workspace_users.role_id.
//
// `syncWorkspaceMembershipGrant` defaults to the workspace `editor` role when no roleId is
// passed, and `WorkspaceUser.create` never passes one. So the grant the engine reads says
// "editor" no matter what `workspace_users.role_id` says.
//
// That is not cosmetic. T-1's migration (20260902020000 step 6) backfills `role_id` to
// `owner` for the user who created a workspace, and T-4a made membership the thing that
// carries workspace access. A workspace owner added or re-added through the model
// therefore loses every owner-only action — workspace.delete, members.manage — while the
// membership row still claims owner. The two sources disagree and the engine believes the
// weaker one, so the failure is silent: nothing errors, the owner simply cannot act.
//
// RED on main: the grant is editor even when the row says owner.

const { execSync } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");

const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `t4b_mg_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;

beforeAll(async () => {
  const hasPostgresUrl = baseDatabaseUrl?.startsWith(PG_SCHEME);
  if (!hasPostgresUrl) {
    throw new Error("membership grant tests require DATABASE_URL pointing at PostgreSQL");
  }
  const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${testDb}"`);
  await admin.$disconnect();

  execSync(`npx prisma migrate deploy --schema ${SCHEMA}`, {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
}, 300_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60_000);

const {
  syncWorkspaceMembershipGrant,
} = require("../../../utils/authorization/legacyRoleGrants");
const { SERVICE_PRINCIPALS } = require("../../../utils/authorization/actorResolver");

const SYS = SERVICE_PRINCIPALS.singleUser;

const roleNamed = (name) =>
  prisma.roles.findFirstOrThrow({ where: { name, scope: "workspace" } });

async function membership({ username, roleName }) {
  const user = await prisma.users.create({
    data: { username: `${username}-${dbSuffix}`, password: "x", role: "default" },
  });
  const workspace = await prisma.workspaces.create({
    data: { name: username, slug: `${username}-${dbSuffix}` },
  });
  const role = roleName ? await roleNamed(roleName) : null;
  await prisma.workspace_users.create({
    data: {
      user_id: user.id,
      workspace_id: workspace.id,
      ...(role ? { role_id: role.id } : {}),
    },
  });
  return { user, workspace, role };
}

const grantedRoleIds = async (user, workspace) =>
  (
    await prisma.principal_role_grants.findMany({
      where: {
        principal_type: "user",
        principal_id: String(user.id),
        workspace_id: workspace.id,
      },
      select: { role_id: true },
    })
  ).map((row) => row.role_id);

describe("T-4b: a membership grant carries the role the membership row names", () => {
  test("a member row that says OWNER is granted owner, not editor", async () => {
    const { user, workspace, role } = await membership({
      username: "owner-member",
      roleName: "owner",
    });
    await syncWorkspaceMembershipGrant({
      userId: user.id,
      workspaceId: workspace.id,
      actor: SYS,
      db: prisma,
    });
    expect(await grantedRoleIds(user, workspace)).toEqual([role.id]);
  });

  test("a member row that says VIEWER is granted viewer, not editor", async () => {
    // The other direction, and the one that is a privilege ESCALATION rather than a
    // downgrade: a viewer silently granted editor gains document write on a workspace
    // where the membership row says read-only.
    const { user, workspace, role } = await membership({
      username: "viewer-member",
      roleName: "viewer",
    });
    await syncWorkspaceMembershipGrant({
      userId: user.id,
      workspaceId: workspace.id,
      actor: SYS,
      db: prisma,
    });
    expect(await grantedRoleIds(user, workspace)).toEqual([role.id]);
  });

  test("a row with no role_id still defaults to editor — the legacy behavioural match", async () => {
    // T-1 chose editor over viewer deliberately: legacy default users could upload and
    // delete in their workspaces, and viewer would have revoked that on migration day.
    // Only the DEFAULT is being kept here; an explicit role_id must still win.
    const { user, workspace } = await membership({
      username: "roleless-member",
      roleName: null,
    });
    await syncWorkspaceMembershipGrant({
      userId: user.id,
      workspaceId: workspace.id,
      actor: SYS,
      db: prisma,
    });
    const editor = await roleNamed("editor");
    expect(await grantedRoleIds(user, workspace)).toEqual([editor.id]);
  });

  test("an explicitly passed roleId still wins over the row", async () => {
    // callers that already know the role (invite acceptance, admin assignment) must not
    // pay for an extra read, and must not be overridden by it.
    const { user, workspace } = await membership({
      username: "explicit-member",
      roleName: "viewer",
    });
    const owner = await roleNamed("owner");
    await syncWorkspaceMembershipGrant({
      userId: user.id,
      workspaceId: workspace.id,
      roleId: owner.id,
      actor: SYS,
      db: prisma,
    });
    expect(await grantedRoleIds(user, workspace)).toEqual([owner.id]);
  });
});

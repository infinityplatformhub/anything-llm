/**
 * T-7 (#31, D-1): DISABLE_VIEW_CHAT_HISTORY retires into `chat.read_others`.
 *
 * The read CANNOT happen in migration SQL — the variable lives in the Node
 * process and Postgres cannot see it, so `current_setting()` returns NULL
 * whatever the operator set and a SQL branch would silently take the "not set"
 * path forever. These tests pin the Node-side one-shot instead.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "t7-chathistory-")
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
const testDb = `t7_chat_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    throw new Error("T-7 integration tests require DATABASE_URL on PostgreSQL");
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
  prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
}, 300_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const admin = new PrismaClient({
      datasources: { db: { url: baseDatabaseUrl } },
    });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60_000);

const {
  migrateChatHistoryPermission,
  MARKER,
} = require("../../../utils/authorization/chatHistoryMigration");

const rolesWithReadOthers = async () => {
  const permission = await prisma.permissions.findUnique({
    where: { action: "chat.read_others" },
    select: { id: true },
  });
  const rows = await prisma.role_permissions.findMany({
    where: { permission_id: permission.id },
    select: { role_id: true },
  });
  const roles = await prisma.roles.findMany({
    where: { id: { in: rows.map((r) => r.role_id) } },
    select: { name: true },
  });
  return roles.map((r) => r.name).sort();
};

describe("D-1: the env kill switch becomes a permission", () => {
  afterEach(() => {
    delete process.env.DISABLE_VIEW_CHAT_HISTORY;
  });

  test("postgres cannot see the env var — proving why this is not in the migration", async () => {
    process.env.DISABLE_VIEW_CHAT_HISTORY = "1";
    const [row] = await prisma.$queryRawUnsafe(
      "SELECT current_setting('app.disable_view_chat_history', true) AS v"
    );
    expect(row.v).toBeNull();
  });

  test("with the var set, only super_admin keeps chat.read_others", async () => {
    process.env.DISABLE_VIEW_CHAT_HISTORY = "1";
    expect(await rolesWithReadOthers()).toEqual(
      expect.arrayContaining(["content_moderator", "super_admin"])
    );

    const result = await migrateChatHistoryPermission(prisma);
    expect(result).toEqual({ applied: true, disabled: true });
    expect(await rolesWithReadOthers()).toEqual(["super_admin"]);
  });

  test("it is one-shot: a re-run cannot undo a grant made afterwards", async () => {
    // An admin deliberately grants it back to content_moderator...
    const permission = await prisma.permissions.findUniqueOrThrow({
      where: { action: "chat.read_others" },
      select: { id: true },
    });
    const moderator = await prisma.roles.findFirstOrThrow({
      where: { name: "content_moderator", scope: "org" },
      select: { id: true },
    });
    await prisma.role_permissions.create({
      data: {
        role_id: moderator.id,
        permission_id: permission.id,
        effect: "allow",
      },
    });

    // ...and a restart with the variable still set must not take it away again.
    process.env.DISABLE_VIEW_CHAT_HISTORY = "1";
    const result = await migrateChatHistoryPermission(prisma);
    expect(result).toEqual({ applied: false, disabled: null });
    expect(await rolesWithReadOthers()).toContain("content_moderator");

    const markers = await prisma.policy_versions.count({
      where: { change_type: MARKER },
    });
    expect(markers).toBe(1);
  });
});

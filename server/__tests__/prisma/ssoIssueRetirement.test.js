/**
 * #50 migration 20260902090000: retiring `sso.issue` must not damage existing keys.
 *
 * The scope was written into the `scopes` column of every key that migration
 * 20260902045000 backfilled. Removing a permission usually breaks rows that
 * reference it; here it must not. Two properties, and the second is the one with
 * teeth: a key stripped down to NOTHING is left alive and refused, not revoked —
 * whether a credential should exist is the operator's call, and revocation is
 * both quieter and irreversible.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "s50-retire-")
  );
process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER || "s50-retire-api-key-pepper-32-bytes-ok";

const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `s50_retire_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
    throw new Error("issue 50 integration tests require PostgreSQL");
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
  process.env.DATABASE_URL = testUrl;
  jest.resetModules();
  prisma = require("../../utils/prisma");
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

describe("#50: sso.issue is retired from the vocabulary", () => {
  test("the permission row is gone", async () => {
    const row = await prisma.permissions.findFirst({
      where: { action: "sso.issue" },
    });
    expect(row).toBeNull();
  });

  test("no role still references it", async () => {
    // role_permissions has no ON DELETE CASCADE, so an out-of-order delete
    // would leave rows pointing at a permission id that no longer exists.
    const orphans = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS count FROM "role_permissions" rp
         LEFT JOIN "permissions" p ON p."id" = rp."permission_id"
        WHERE p."id" IS NULL`
    );
    expect(orphans[0].count).toBe(0);
  });

  test("the seed vocabulary and the database agree", async () => {
    const { ALL_ACTIONS } = require("../../prisma/seeds/permissions");
    expect(ALL_ACTIONS).not.toContain("sso.issue");
  });
});

describe("#50: existing keys survive the retirement", () => {
  const seedKey = async (name, scopes) =>
    prisma.api_keys.create({
      data: {
        secretDigest: crypto.randomBytes(32),
        keyPrefix: `apw-${name}-${dbSuffix}`,
        scopes: JSON.stringify(scopes),
      },
    });

  // The migration already ran in beforeAll, so rows are seeded post-migration
  // and the strip is re-applied here exactly as the migration statement does.
  const applyStrip = () =>
    prisma.$executeRawUnsafe(
      `UPDATE "api_keys" SET "scopes" = (("scopes"::jsonb) - 'sso.issue')::text
        WHERE "scopes"::jsonb @> '["sso.issue"]'::jsonb`
    );

  test("a mixed key loses sso.issue and keeps everything else", async () => {
    const key = await seedKey("mixed", ["sso.issue", "user.read"]);
    await applyStrip();
    const after = await prisma.api_keys.findUnique({ where: { id: key.id } });
    expect(JSON.parse(after.scopes)).toEqual(["user.read"]);
  });

  test("a key holding only sso.issue is emptied, NOT revoked", async () => {
    const key = await seedKey("only", ["sso.issue"]);
    await applyStrip();
    const after = await prisma.api_keys.findUnique({ where: { id: key.id } });
    // Still resolvable: the row exists and carries no revocation.
    expect(after).not.toBeNull();
    expect(after.revokedAt).toBeNull();
    // And holds nothing, so every route refuses it.
    expect(JSON.parse(after.scopes)).toEqual([]);
  });

  test("the strip is idempotent — a second run changes nothing", async () => {
    const key = await seedKey("idem", ["sso.issue", "chat.read"]);
    await applyStrip();
    const once = await prisma.api_keys.findUnique({ where: { id: key.id } });
    await applyStrip();
    const twice = await prisma.api_keys.findUnique({ where: { id: key.id } });
    expect(twice.scopes).toBe(once.scopes);
    expect(JSON.parse(twice.scopes)).toEqual(["chat.read"]);
  });

  test("a key that never held it is untouched", async () => {
    const key = await seedKey("clean", ["user.read", "chat.read"]);
    const before = await prisma.api_keys.findUnique({ where: { id: key.id } });
    await applyStrip();
    const after = await prisma.api_keys.findUnique({ where: { id: key.id } });
    expect(after.scopes).toBe(before.scopes);
  });
});

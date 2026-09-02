/**
 * PR-4c on real Postgres: a database that already holds wildcard keys must come out of
 * the migration with none, and with those keys still usable.
 *
 * The point is the database, not the model: a fake db reports whatever the model sent
 * and would prove nothing about the column default or the backfill.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const schemaName = `pr4c_wildcard_${process.pid}`;
const baseUrl = new URL(process.env.DATABASE_URL ?? "");
if (baseUrl.protocol !== "postgresql:")
  throw new Error("PR-4c migration tests require DATABASE_URL pointing at PostgreSQL");
baseUrl.searchParams.set("schema", schemaName);
process.env.DATABASE_URL = baseUrl.toString();
process.env.API_KEY_PEPPER = process.env.API_KEY_PEPPER || "pr4c-migration-pepper-32-bytes-x";

const serverRoot = path.resolve(__dirname, "../..");
const migrations = path.resolve(serverRoot, "prisma/migrations");
const prismaBin = path.resolve(serverRoot, "node_modules/.bin/prisma");
const WILDCARD_MIGRATION = "20260902045000_api_key_scope_no_wildcard";

jest.setTimeout(300000);

const { Client } = require("pg");
let client;

/** Applies every migration up to but not including the wildcard one. */
function migrationsBefore() {
  return fs
    .readdirSync(migrations)
    .filter((dir) => dir !== "migration_lock.toml")
    .sort()
    .filter((dir) => dir < WILDCARD_MIGRATION);
}

beforeAll(async () => {
  client = new Client({ connectionString: baseUrl.toString() });
  await client.connect();
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  await client.query(`SET search_path TO "${schemaName}"`);

  for (const dir of migrationsBefore()) {
    const sql = fs.readFileSync(path.join(migrations, dir, "migration.sql"), "utf8");
    await client.query(sql);
  }
});

afterAll(async () => {
  await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await client.end();
});

test("a database carrying legacy wildcard keys has none after the migration", async () => {
  // Two keys minted the old way: the column default did the work, nobody named a scope.
  await client.query(`
    INSERT INTO "api_keys" ("secretDigest", "keyPrefix", "scopes")
    VALUES ('\\x01'::bytea, 'apw-key-legacy1', '["*"]'),
           ('\\x02'::bytea, 'apw-key-legacy2', '["*"]')
  `);
  // And one that was already scoped, to prove the migration does not touch it.
  await client.query(`
    INSERT INTO "api_keys" ("secretDigest", "keyPrefix", "scopes")
    VALUES ('\\x03'::bytea, 'apw-key-scoped1', '["workspace.read"]')
  `);

  const before = await client.query(
    `SELECT count(*)::int AS n FROM "api_keys" WHERE "scopes"::jsonb @> '["*"]'::jsonb`
  );
  expect(before.rows[0].n).toBe(2);

  const sql = fs.readFileSync(
    path.join(migrations, WILDCARD_MIGRATION, "migration.sql"),
    "utf8"
  );
  await client.query(sql);

  const after = await client.query(
    `SELECT count(*)::int AS n FROM "api_keys" WHERE "scopes"::jsonb @> '["*"]'::jsonb`
  );
  expect(after.rows[0].n).toBe(0);

  // The rewritten keys still carry a usable grant — an emptied list would be an outage.
  const rewritten = await client.query(
    `SELECT "scopes"::jsonb AS scopes FROM "api_keys" WHERE "keyPrefix" = 'apw-key-legacy1'`
  );
  expect(rewritten.rows[0].scopes.length).toBeGreaterThan(10);
  expect(rewritten.rows[0].scopes).toContain("workspace.read");
  // ...but not the credentials. A legacy key was never deliberately granted those.
  expect(rewritten.rows[0].scopes).not.toContain("system.env.read");

  // The already-scoped key is untouched.
  const untouched = await client.query(
    `SELECT "scopes"::jsonb AS scopes FROM "api_keys" WHERE "keyPrefix" = 'apw-key-scoped1'`
  );
  expect(untouched.rows[0].scopes).toEqual(["workspace.read"]);
});

test("every rewritten key is recorded so the boot report can name it", async () => {
  const rows = await client.query(
    `SELECT "keyPrefix" FROM "api_key_legacy_wildcard_grants" ORDER BY "keyPrefix"`
  );
  expect(rows.rows.map((row) => row.keyPrefix)).toEqual([
    "apw-key-legacy1",
    "apw-key-legacy2",
  ]);
});

test("the column no longer supplies a default, so an unscoped insert fails", async () => {
  await expect(
    client.query(
      `INSERT INTO "api_keys" ("secretDigest", "keyPrefix") VALUES ('\\x09'::bytea, 'apw-key-nodefault')`
    )
  ).rejects.toThrow();
});

test("re-running the migration changes nothing", async () => {
  const sql = fs.readFileSync(
    path.join(migrations, WILDCARD_MIGRATION, "migration.sql"),
    "utf8"
  );
  const before = await client.query(`SELECT "keyPrefix", "scopes" FROM "api_keys" ORDER BY id`);
  await client.query(sql);
  const after = await client.query(`SELECT "keyPrefix", "scopes" FROM "api_keys" ORDER BY id`);
  expect(after.rows).toEqual(before.rows);

  const grants = await client.query(`SELECT count(*)::int AS n FROM "api_key_legacy_wildcard_grants"`);
  expect(grants.rows[0].n).toBe(2);
});

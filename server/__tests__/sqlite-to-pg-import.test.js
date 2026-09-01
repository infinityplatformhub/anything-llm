const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { Client } = require("pg");

const script = path.resolve(__dirname, "../../scripts/sqlite-to-pg-import.js");
const databaseUrl = process.env.DATABASE_URL;
const schema = `sqlite_import_${process.pid}`;
let client;
let fixture;

beforeAll(async () => {
  if (!databaseUrl?.startsWith("postgresql://")) {
    throw new Error("DATABASE_URL must point to PostgreSQL for import tests");
  }
  fixture = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-import-")),
    "fixture.db"
  );
  execFileSync("sqlite3", [
    fixture,
    `CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password TEXT, role TEXT, suspended INTEGER, createdAt DATETIME, lastUpdatedAt DATETIME);
     CREATE TABLE workspaces (id INTEGER PRIMARY KEY, name TEXT, slug TEXT, openAiHistory INTEGER, createdAt DATETIME, lastUpdatedAt DATETIME);
     CREATE TABLE workspace_chats (id INTEGER PRIMARY KEY, workspaceId INTEGER, prompt TEXT, response TEXT, include INTEGER, createdAt DATETIME, lastUpdatedAt DATETIME);
     CREATE TABLE event_logs (id INTEGER PRIMARY KEY, event TEXT, metadata TEXT, userId INTEGER, occurredAt DATETIME);
     INSERT INTO users VALUES (7, 'fixture-user', 'hash', 'default', 0, '2026-01-02T03:04:05Z', '2026-01-02T03:04:05Z');
     INSERT INTO workspaces VALUES (9, 'Fixture', 'fixture', 20, '2026-01-02T03:04:05Z', '2026-01-02T03:04:05Z');
     INSERT INTO workspace_chats VALUES (11, 9, 'fixture prompt', '{"textResponse":"fixture answer"}', 1, '2026-01-02T03:04:05Z', '2026-01-02T03:04:05Z');
     INSERT INTO event_logs VALUES (12, 'fixture_event', '{"source":"fixture"}', 7, '2026-01-02T03:04:05Z');`,
  ]);

  const setup = new Client({ connectionString: databaseUrl });
  await setup.connect();
  await setup.query(`CREATE SCHEMA "${schema}"`);
  await setup.end();

  const target = new URL(databaseUrl);
  target.searchParams.set("schema", schema);
  execFileSync(
    path.resolve(__dirname, "../node_modules/.bin/prisma"),
    [
      "db",
      "push",
      "--skip-generate",
      "--schema",
      path.resolve(__dirname, "../prisma/schema.prisma"),
    ],
    { env: { ...process.env, DATABASE_URL: target.toString() } }
  );
  execFileSync(process.execPath, [script, fixture, target.toString()]);
  client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query(`SET search_path TO "${schema}"`);
});

afterAll(async () => {
  await client?.end();
  const cleanup = new Client({ connectionString: databaseUrl });
  await cleanup.connect();
  await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await cleanup.end();
});

test("imports fixture rows and preserves IDs", async () => {
  expect((await client.query("SELECT id, username FROM users")).rows).toEqual([
    { id: 7, username: "fixture-user" },
  ]);
  expect((await client.query("SELECT id, slug FROM workspaces")).rows).toEqual([
    { id: 9, slug: "fixture" },
  ]);
  expect(
    (
      await client.query(
        "SELECT id, prompt, response, include FROM workspace_chats"
      )
    ).rows
  ).toEqual([
    {
      id: 11,
      prompt: "fixture prompt",
      response: '{"textResponse":"fixture answer"}',
      include: true,
    },
  ]);
  expect(
    (await client.query("SELECT id, metadata FROM event_logs")).rows
  ).toEqual([{ id: 12, metadata: '{"source":"fixture"}' }]);
});

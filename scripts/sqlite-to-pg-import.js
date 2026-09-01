#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import pg from "../server/node_modules/pg/lib/index.js";

const { Client } = pg;

const TABLES = [
  "users",
  "workspaces",
  "workspace_users",
  "workspace_threads",
  "workspace_chats",
  "workspace_documents",
  "workspace_agent_invocations",
  "workspace_suggested_messages",
  "document_sync_queues",
  "document_sync_executions",
  "slash_command_presets",
  "prompt_history",
  "api_keys",
  "event_logs",
  "system_settings",
];

function quote(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sqliteRows(database, table) {
  try {
    return JSON.parse(
      execFileSync(
        "sqlite3",
        ["-json", database, `SELECT * FROM ${quote(table)}`],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }
      ) || "[]"
    );
  } catch (error) {
    if (String(error.stderr).includes("no such table")) return [];
    throw error;
  }
}

async function destinationColumns(client, table) {
  const { rows } = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return new Map(
    rows.map(({ column_name, data_type }) => [column_name, data_type])
  );
}

function postgresValue(value, dataType) {
  if (value === null) return null;
  if (dataType === "boolean") return Boolean(value);
  if (dataType === "json" || dataType === "jsonb") {
    return typeof value === "string" ? JSON.parse(value) : value;
  }
  return value;
}

async function importTable(client, database, table) {
  const rows = sqliteRows(database, table);
  if (!rows.length) return 0;

  const allowed = await destinationColumns(client, table);
  for (const row of rows) {
    const columns = Object.keys(row).filter((column) => allowed.has(column));
    const values = columns.map((column) =>
      postgresValue(row[column], allowed.get(column))
    );
    const updates = columns
      .filter((column) => column !== "id")
      .map((column) => `${quote(column)} = EXCLUDED.${quote(column)}`)
      .join(", ");
    await client.query(
      `INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES (${columns
        .map((_, index) => `$${index + 1}`)
        .join(
          ", "
        )}) ON CONFLICT ("id") DO ${updates ? `UPDATE SET ${updates}` : "NOTHING"}`,
      values
    );
  }

  if (allowed.has("id")) {
    await client.query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), value, is_called) FROM (SELECT COALESCE(MAX("id"), 1) AS value, MAX("id") IS NOT NULL AS is_called FROM ${quote(table)}) AS sequence_state`,
      [table]
    );
  }
  return rows.length;
}

async function main() {
  const [database, databaseUrl = process.env.DATABASE_URL] =
    process.argv.slice(2);
  if (!database || !databaseUrl) {
    throw new Error("Usage: sqlite-to-pg-import.js <sqlite-db> [postgres-url]");
  }

  const target = new URL(databaseUrl);
  const schema = target.searchParams.get("schema");
  target.searchParams.delete("schema");
  const client = new Client({ connectionString: target.toString() });
  await client.connect();
  try {
    if (schema) await client.query(`SET search_path TO ${quote(schema)}`);
    await client.query("BEGIN");
    for (const table of TABLES) {
      const count = await importTable(client, database, table);
      process.stdout.write(`${table}: ${count}\n`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

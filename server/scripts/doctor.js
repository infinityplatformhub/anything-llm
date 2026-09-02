#!/usr/bin/env node
/**
 * O2a (#74) — `docker compose run --rm --no-deps anything-llm doctor`.
 *
 * Prints one line per check and exits non-zero when anything blocking failed,
 * so the same run works as a boot gate and as a diagnostic an operator invokes
 * on a boot that already failed.
 *
 * --no-deps matters for an external PostgreSQL: without it, compose honours
 * `depends_on: postgres condition: service_healthy` and waits on the bundled
 * database's healthcheck instead of reporting that the configured one is
 * unreachable.
 */
const { runChecks, exitCodeFor } = require("../utils/doctor");

const MARK = { ok: "PASS", block: "FAIL", warn: "WARN" };

/**
 * O5b (#94): `--bundle` emits the diagnostic bundle as JSON on STDOUT and
 * NOTHING ELSE, so `doctor --bundle > bundle.json` produces a file that parses.
 * The checklist an operator normally reads, and any complaint about assembling
 * the bundle, go to stderr — where the operator still sees them on a terminal
 * and the redirect does not capture them.
 */
async function emitBundle(results) {
  const { Client } = require("pg");
  const { buildBundle } = require("../utils/diagnostics");

  // A SECOND connection, opened here rather than borrowed from runChecks:
  // runChecks owns and closes its own client, and a doctor whose checks
  // depend on the bundle's connection would report a different database state
  // than the one it just described. If this connection fails, the bundle still
  // ships — collectDatabase records that the database was unreachable, which
  // is itself the answer to most of the questions that produce a bundle.
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  let connected = false;
  try {
    await client.connect();
    connected = true;
  } catch (error) {
    console.error(`[doctor] Database unreachable while bundling: ${error.message}`);
  }

  try {
    const { bundle, redactions } = await buildBundle({
      client: connected ? client : null,
      checks: results,
    });
    // The ONLY write to stdout on this path.
    process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
    console.error(
      redactions.length
        ? `[doctor] Bundle written. Redacted: ${redactions.join(", ")}. Read it before you share it.`
        : "[doctor] Bundle written. Read it before you share it."
    );
  } finally {
    if (connected) await client.end().catch(() => {});
  }
}

async function main(argv = process.argv.slice(2)) {
  const bundleMode = argv.includes("--bundle");
  const unknown = argv.filter((arg) => arg !== "--bundle");
  if (unknown.length) {
    console.error(`unknown option: ${unknown[0]} (expected '--bundle')`);
    return 64;
  }

  const results = await runChecks();

  // In bundle mode the checklist goes to stderr: it is still worth reading, but
  // it is not JSON and must not reach the redirected file.
  const say = bundleMode ? console.error : console.log;
  for (const check of results) {
    const mark = check.ok ? MARK.ok : MARK[check.level];
    say(`[${mark}] ${check.id} — ${check.detail}`);
    if (!check.ok) say(`        fix: ${check.remedy}`);
  }

  if (bundleMode) {
    await emitBundle(results);
    // The exit code still reports the checks. A bundle assembled from a broken
    // install is a successful bundling of a failing install, and the operator
    // needs the failure, not the bundling, in `$?`.
    return exitCodeFor(results);
  }

  const code = exitCodeFor(results);
  const warnings = results.filter((c) => !c.ok && c.level === "warn").length;
  const blockers = results.filter((c) => !c.ok && c.level === "block").length;

  if (code !== 0) {
    console.log(
      `\n${blockers} blocking problem(s) must be fixed before the server can start.${warnings ? ` ${warnings} warning(s) can be left as they are.` : ""}`
    );
  } else if (warnings) {
    console.log(
      `\nReady to start. ${warnings} warning(s) — the install works as it is.`
    );
  } else {
    console.log("\nReady to start.");
  }

  return code;
}

if (require.main === module) {
  // exitCode, not an immediate exit: the checklist is the whole output of this
  // command, and exiting before the stream drains truncates it whenever stdout
  // is a pipe. The process ends on its own once the database client is closed.
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`[doctor] Could not complete the checks: ${error.message}`);
      process.exitCode = 1;
    }
  );
}

module.exports = { main };

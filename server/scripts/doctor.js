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

async function main() {
  const results = await runChecks();

  for (const check of results) {
    const mark = check.ok ? MARK.ok : MARK[check.level];
    console.log(`[${mark}] ${check.id} — ${check.detail}`);
    if (!check.ok) console.log(`        fix: ${check.remedy}`);
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
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[doctor] Could not complete the checks: ${error.message}`);
      process.exit(1);
    }
  );
}

module.exports = { main };

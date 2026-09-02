// #73 — fail the CI run when a real-store suite did not actually RUN.
//
// The first version of this guard asserted that the env vars were SET. TL-2 rejected that,
// correctly: "the variable is set" and "the suite ran" are different claims, and only the
// second one is what anybody cares about. A container that starts and then dies, an image
// whose entrypoint changed, a `describeIf` rewritten to gate on something else — every one
// of those leaves the variable set and the suite skipped, which is precisely the state this
// issue exists to end.
//
// It is a REPORTER rather than a test because a test can be skipped, filtered out by a
// `-t` pattern, or fail to match its own path — and each of those failure modes is silent.
// A reporter runs once per jest invocation, sees the whole result set, and can set the
// process exit code regardless of what any individual suite decided about itself. It is
// the only place that can observe an absence.
//
// Scope: CI only. A developer without Docker must still be able to run `yarn test` and get
// a useful answer — blocking them would get the reporter deleted, and a guard nobody can
// live with protects nothing.

const path = require("path");

/**
 * Suites that must execute in CI, by basename.
 *
 * These are the only tests that have ever caught a broken ACL predicate, and they caught
 * five: LanceDB identifier quoting, pgvector placeholder numbering, Milvus operator
 * precedence, Qdrant `is_null` semantics, Weaviate tokenization. Every one read correctly
 * and passed human review; only executing it against the engine found the fault.
 */
const REQUIRED_IN_CI = Object.freeze([
  "milvusRealStoreAcl.test.js",
  "qdrantRealStoreAcl.test.js",
  "weaviateRealStoreAcl.test.js",
  "chromaRealStoreAcl.test.js",
]);

/**
 * Suites exempted from the requirement, with the reason, e.g.
 *   "milvusRealStoreAcl.test.js": "needs etcd+MinIO; run via compose, see ci.yml"
 *
 * An entry here is a DECLARED exemption. It still prints on every CI run, because an
 * exemption nobody sees becomes a silent skip again after one rotation of who is reading.
 */
const EXEMPT_IN_CI = Object.freeze({});

const isCi = () => process.env.CI === "true" || process.env.CI === "1";

class RealStoreReporter {
  constructor(globalConfig) {
    this._globalConfig = globalConfig;
  }

  onRunComplete(_contexts, results) {
    if (!isCi()) return;

    // A filtered run (`jest -t`, or a path pattern) legitimately executes a subset, and
    // failing it would make the reporter fire on every targeted local-style CI run. Only
    // a full run can be held to "everything must have run".
    const filtered =
      (this._globalConfig?.testPathPattern ?? "") !== "" ||
      Boolean(this._globalConfig?.testNamePattern);
    if (filtered) {
      console.log(
        "[#73] filtered run — skipping the real-store presence check (a subset run cannot prove absence)"
      );
      return;
    }

    const byName = new Map();
    for (const suite of results.testResults ?? []) {
      byName.set(path.basename(suite.testFilePath ?? ""), suite);
    }

    const problems = [];
    for (const name of REQUIRED_IN_CI) {
      if (EXEMPT_IN_CI[name]) {
        console.log(`[#73] ${name} is EXEMPT in CI: ${EXEMPT_IN_CI[name]}`);
        continue;
      }

      const suite = byName.get(name);
      if (!suite) {
        problems.push(`${name} did not run at all (no result for it in this jest run)`);
        continue;
      }

      // The real signal. A suite whose `describeIf` resolved to `describe.skip` still
      // produces a result object — with every test pending and nothing passing. That is
      // indistinguishable from success in the summary line, which is how this went
      // unnoticed: jest prints "Tests: 4 skipped, N passed" and exits 0.
      const passing = suite.numPassingTests ?? 0;
      const pending = suite.numPendingTests ?? 0;
      if (passing === 0) {
        problems.push(
          `${name} ran 0 passing tests (${pending} skipped) — its engine was unreachable, ` +
            `so the ACL predicate was never executed against a real store`
        );
      }
    }

    if (problems.length === 0) {
      console.log(
        `[#73] all ${REQUIRED_IN_CI.length} real-store suites executed against a live engine`
      );
      return;
    }

    for (const problem of problems) {
      console.error(`::error::[#73] ${problem}`);
    }
    console.error(
      "::error::[#73] CI must not pass while a real-store suite is skipped. Either fix the " +
        "service in .github/workflows/ci.yml, or declare the exemption in EXEMPT_IN_CI " +
        "(and in residual-risks.md) so the skip is visible rather than silent."
    );
    // Set rather than throw: throwing from a reporter is swallowed in some jest versions,
    // and the whole point is that this cannot fail quietly.
    process.exitCode = 1;
  }
}

module.exports = RealStoreReporter;
module.exports.REQUIRED_IN_CI = REQUIRED_IN_CI;
module.exports.EXEMPT_IN_CI = EXEMPT_IN_CI;

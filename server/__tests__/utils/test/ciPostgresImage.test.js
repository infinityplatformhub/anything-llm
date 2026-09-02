/**
 * #146 — CI's postgres service must be an image that ships pgvector.
 *
 * The workflow is not covered by any suite: it is YAML that only GitHub executes, so
 * a change to it is invisible to every test in this repo and a revert to
 * `postgres:16` would be caught by nobody. That is exactly the shape #142 closed for
 * hook timeouts — a property nothing witnesses gets deleted by a later reader as an
 * unnecessary detail.
 *
 * Asserted as "the image is one that ships pgvector", not as an exact string: the tag
 * will move (pg16 → pg17) and pinning the literal would fail on a correct upgrade,
 * which is how a guard earns its removal.
 */

const fs = require("fs");
const path = require("path");

const WORKFLOW = path.resolve(__dirname, "../../../../.github/workflows/ci.yml");

/** The postgres service block's `image:` line, or null. */
function postgresImage(source) {
  const match = source.match(/postgres:\s*\n\s*image:\s*(\S+)/);
  return match ? match[1] : null;
}

describe("#146: the CI postgres service ships pgvector", () => {
  test("the image is a pgvector-bearing one, not stock postgres", () => {
    const source = fs.readFileSync(WORKFLOW, "utf8");
    // The postgres SERVICE's image line specifically — the file also names chroma,
    // qdrant, weaviate and milvus images, and matching any `image:` would pass on
    // one of those.
    const image = postgresImage(source);
    expect(image).not.toBeNull();
    // `pgvector/pgvector:pg16` today. A stock `postgres:16` does not carry the
    // extension, and the failure it produces is remote-only: green locally for every
    // developer whose container has it, red in CI alone.
    expect(image).toMatch(/pgvector/);
  });

  test("#149: the test job declares DATABASE_URL and API_KEY_PEPPER at JOB level", () => {
    // Measured on PR #148: `run-tests.yaml` reaches `yarn prisma:setup` with no
    // DATABASE_URL and dies with P1012 before a single test runs. `ci.yml` does not
    // have that defect — its job-level `env:` already carries these — and this
    // asserts it STAYS that way.
    //
    // Job level, not step level, is the property. An env var declared under one
    // step is invisible to every other step in the job, so a var that migrates
    // downward keeps the workflow green until some later step needs it, and then
    // fails at a place with no obvious connection to the move.
    const source = fs.readFileSync(WORKFLOW, "utf8");
    // The `test` job's own env block: everything between `    env:` at job
    // indentation and the `    steps:` that follows it. Deliberately anchored to
    // that indentation — the service containers have `env:` blocks of their own at
    // deeper indentation, and matching those would pass while the job had none.
    const block = source.match(/\n {4}env:\n([\s\S]*?)\n {4}steps:/);
    expect(block).not.toBeNull();
    // STORAGE_DIR is deliberately NOT asserted: it is absent from ci.yml today and
    // the suite passes without it, because every test that needs one creates its own
    // temp directory. Demanding it here would be a guard for a variable nothing
    // reads — the kind that gets deleted along with the ones that matter.
    for (const key of ["DATABASE_URL", "API_KEY_PEPPER"])
      expect(block[1]).toMatch(new RegExp(`^\\s{6}${key}:`, "m"));
  });

  test("CONTROL: the env matcher does not accept a SERVICE-level env block", () => {
    // Without this, a matcher that happens to find the postgres service's own
    // `env:` (which contains POSTGRES_DB and friends, at deeper indentation) reports
    // the job as configured while the job block is empty — green for the wrong
    // reason, which is the failure this whole file exists to prevent.
    const sample = [
      "jobs:",
      "  test:",
      "    services:",
      "      postgres:",
      "        image: pgvector/pgvector:pg16",
      "        env:",
      "          DATABASE_URL: nope-this-is-the-service",
      "    steps:",
      "      - run: yarn test",
      "",
    ].join("\n");
    const block = sample.match(/\n {4}env:\n([\s\S]*?)\n {4}steps:/);
    expect(block).toBeNull();
  });
});

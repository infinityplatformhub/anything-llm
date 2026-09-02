// #73 — the real-store suites must actually RUN in CI, not silently skip.
//
// Every `*RealStoreAcl` / `RealTable` suite gates itself on an address:
//
//     const ADDRESS = process.env.MILVUS_TEST_ADDRESS;
//     const describeIfMilvus = ADDRESS ? describe : describe.skip;
//
// That is the right shape for a developer without Docker running — a skipped suite beats a
// failing one nobody can fix locally. But `.github/workflows/ci.yml` set only DATABASE_URL
// and API_KEY_PEPPER, so in CI every one of those variables was unset and all four suites
// resolved to `describe.skip`. CI reported green without ever executing them.
//
// That matters more here than it would elsewhere. These suites are the only thing that has
// ever caught this class of bug, and they caught it five times — LanceDB identifier
// quoting, pgvector placeholder numbering, Milvus operator precedence, Qdrant `is_null`
// semantics, Weaviate tokenization. Every one of those predicates read correctly and passed
// review; only running it against the engine found the fault.
//
// So the missing services were the symptom. The root cause is that NOTHING NOTICED the
// skip — which is why adding services without this test would regress silently the first
// time a container is renamed or a health check starts failing. This is that notice.
//
// WHAT THIS FILE DOES NOT DO (TL-2 ruling): it does not claim the suites RAN. An earlier
// version asserted only that the env vars were set, which is a weaker claim wearing the
// same words — a container that starts and dies, or a `describeIf` rewritten to gate on
// something else, leaves the variable set and the suite skipped. Proving execution needs
// the whole result set, which no test can see, so that job belongs to
// `__tests__/support/realStoreReporter.js` and this file covers what a test genuinely can:
// that the workflow and the suites still agree about which variable is which.

const fs = require("fs");
const path = require("path");

/**
 * The env var each real-store suite gates on, keyed by the file that reads it.
 *
 * Listed explicitly rather than parsed out of the sources: a regex over test files would
 * quietly cover nothing the day someone writes the guard differently, and a guard that
 * silently protects nothing is the exact failure this file exists to prevent. The
 * completeness of the list is asserted separately below.
 */
const REAL_STORE_SUITES = Object.freeze({
  "milvusRealStoreAcl.test.js": "MILVUS_TEST_ADDRESS",
  "qdrantRealStoreAcl.test.js": "QDRANT_TEST_URL",
  "weaviateRealStoreAcl.test.js": "WEAVIATE_TEST_URL",
  "chromaRealStoreAcl.test.js": "CHROMA_TEST_ADDRESS",
});

/**
 * Suites whose engine cannot run in CI, with the reason.
 *
 * An entry here is a DECLARED exemption, not a silent one: it must also be stated in the
 * workflow and in residual-risks.md, which the tests below check. "Skipped and written
 * down" is a decision; "skipped and green" is the bug.
 */
const CI_EXEMPT = Object.freeze({});


const SUITE_DIR = __dirname;
const WORKFLOW = path.resolve(__dirname, "../../../../.github/workflows/ci.yml");

describe("issue 73: real-store suites are not silently skipped in CI", () => {
  test("every real-store suite in this directory is listed here", () => {
    // Guards the guard. A sixth provider suite added later must either appear in
    // REAL_STORE_SUITES or be exempted on purpose — otherwise it would skip in CI with
    // nothing to say so, which is the state this issue exists to end.
    const onDisk = fs
      .readdirSync(SUITE_DIR)
      .filter((name) => /RealStore.*\.test\.js$/.test(name));

    const known = new Set([
      ...Object.keys(REAL_STORE_SUITES),
      ...Object.keys(CI_EXEMPT),
    ]);
    const unlisted = onDisk.filter((name) => !known.has(name));
    expect(unlisted).toEqual([]);
    // And the list must not be empty — an empty list satisfies every assertion below
    // while checking nothing at all.
    expect(onDisk.length).toBeGreaterThan(0);
  });

  test("each listed suite still reads the env var this file claims it does", () => {
    // The mapping above is a claim about other files. If a suite is renamed or switched to
    // a different variable, setting the old one in CI would keep CI green while the suite
    // skipped — the original bug wearing a new hat.
    for (const [file, variable] of Object.entries(REAL_STORE_SUITES)) {
      const source = fs.readFileSync(path.join(SUITE_DIR, file), "utf-8");
      expect(source).toContain(`process.env.${variable}`);
      // And it must actually gate on it, not merely mention it.
      expect(source).toMatch(/describe\.skip/);
    }
  });

  test("the reporter that proves execution guards exactly these suites", () => {
    // The two lists must not drift apart. If a suite is added here but not to the
    // reporter, this file would report all-clear while nothing checked that the suite
    // actually ran — the same illusion of coverage, one layer up.
    const {
      REQUIRED_IN_CI,
      EXEMPT_IN_CI,
    } = require("../../support/realStoreReporter");

    const guarded = new Set([...REQUIRED_IN_CI, ...Object.keys(EXEMPT_IN_CI)]);
    for (const file of Object.keys(REAL_STORE_SUITES)) {
      expect(guarded.has(file)).toBe(true);
    }
    // And the reporter must be wired in, or it never runs at all.
    const jestConfig = require("../../../jest.config");
    expect(JSON.stringify(jestConfig.reporters)).toContain("realStoreReporter");
  });

  // An exemption that lives only in a source file is invisible to anyone reading CI. If
  // Milvus (which needs etcd and MinIO) ever proves impractical in Actions, the honest
  // outcome is three engines in CI plus a written statement — never four silent skips.
  //
  // TL-2 NOTE, accepted: `CI_EXEMPT` is empty today, so a test that loops over it and
  // early-returns asserts NOTHING — it passes identically whether the rule works or not,
  // and would keep passing the day someone adds the first exemption. The rule is therefore
  // extracted and driven with fixtures, so the branch that matters is actually executed.
  //
  // Same defect class as QA-1's M7 on slice 2: an assertion made against data that cannot
  // exercise it is an assertion that the fixture is empty.
  const undeclaredExemptions = (exempt, workflowText, residualsText) =>
    Object.keys(exempt).filter((file) => {
      const engine = file.replace(/RealStore.*$/, "").toLowerCase();
      return (
        !workflowText.toLowerCase().includes(engine) ||
        !residualsText.toLowerCase().includes(engine)
      );
    });

  test("an exemption missing from the workflow or residual-risks is caught", () => {
    const fake = { milvusRealStoreAcl: "needs etcd+MinIO" };
    // Declared in neither.
    expect(undeclaredExemptions(fake, "name: CI", "# residuals")).toEqual([
      "milvusRealStoreAcl",
    ]);
    // Declared in the workflow only — still not enough; an operator reading the risk
    // register would never learn the engine is unguarded.
    expect(
      undeclaredExemptions(fake, "milvus: image: x", "# residuals")
    ).toEqual(["milvusRealStoreAcl"]);
    // Declared in both.
    expect(
      undeclaredExemptions(fake, "milvus: image: x", "- milvus is dev-run")
    ).toEqual([]);
  });

  test("today's exemptions (if any) are declared in the workflow and residual-risks", () => {
    const workflow = fs.readFileSync(WORKFLOW, "utf-8");
    const residuals = fs.readFileSync(
      path.resolve(__dirname, "../../../../docs/superpowers/residual-risks.md"),
      "utf-8"
    );
    expect(undeclaredExemptions(CI_EXEMPT, workflow, residuals)).toEqual([]);
  });

  test("the workflow sets every variable the listed suites need", () => {
    // Read from the workflow rather than from the environment, so this fails on the pull
    // request that breaks it rather than only inside a CI run that has already gone green
    // for the wrong reason. This is the assertion that would have caught the original bug.
    const workflow = fs.readFileSync(WORKFLOW, "utf-8");
    for (const [file, variable] of Object.entries(REAL_STORE_SUITES)) {
      if (CI_EXEMPT[file]) continue;
      expect(workflow).toContain(variable);
    }
  });
});

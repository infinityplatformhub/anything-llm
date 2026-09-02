// #111 — the frontend test job must actually run in CI, and must be able to fail it.
//
// This lives on the SERVER side deliberately. A guard that the frontend job exists cannot be
// asserted from inside that job: if the job stops running, its own test stops running with it,
// and the check disappears exactly when it is needed. The server suite runs on every PR, so
// putting the assertion here means removing the frontend job turns the SERVER job red.
//
// Same reasoning as `realStoreSuitesRunInCi.test.js` (#73), and the same failure it closed:
// a workflow that looks green because a step quietly stopped executing.

const fs = require("fs");
const path = require("path");

const WORKFLOW = path.resolve(__dirname, "../../../.github/workflows/ci.yml");

describe("issue 111: the frontend test job runs, and can fail the build", () => {
  const workflow = fs.readFileSync(WORKFLOW, "utf8");

  test("ci.yml declares a frontend job", () => {
    expect(workflow).toMatch(/^ {2}frontend:$/m);
  });

  test("that job runs the frontend test script", () => {
    // `yarn test` with `working-directory: frontend`, in that job. Asserted as the pair
    // rather than as the string "yarn test" alone, which already appears for the server.
    const frontendJob = workflow.slice(workflow.search(/^ {2}frontend:$/m));

    expect(frontendJob).toMatch(/- run: yarn test\n\s+working-directory: frontend/);
  });

  test("the job is not marked continue-on-error", () => {
    // A job with `continue-on-error: true` reports failure and lets the build pass anyway —
    // the exact shape of a gate that is present, visibly running, and enforcing nothing.
    // Checked across the whole workflow, not just this job: it is wrong on any of them.
    expect(workflow).not.toMatch(/continue-on-error/);
  });

  test("the frontend job does not wait on the server job's services", () => {
    // The frontend suite renders components under jsdom. It needs no postgres and no vector
    // store, and coupling it to them would mean a chroma outage failing a button test — a
    // red build for a reason unrelated to the change, which is how a suite earns a reputation
    // for flaking and then gets ignored.
    const frontendJob = workflow.slice(workflow.search(/^ {2}frontend:$/m));

    expect(frontendJob).not.toMatch(/needs:/);
    expect(frontendJob).not.toMatch(/services:/);
  });

  test("the frontend runner cannot pass with no test files", () => {
    // vitest exits 0 on an empty run unless this is off. With `passWithNoTests: false`,
    // deleting every frontend test turns the build red instead of green — without it, the
    // job above would still run, still report success, and assert nothing.
    const config = fs.readFileSync(
      path.resolve(__dirname, "../../../frontend/vitest.config.js"),
      "utf8"
    );

    expect(config).toMatch(/passWithNoTests:\s*false/);
  });

  test("at least one frontend test file exists", () => {
    // The other half of the line above: `passWithNoTests: false` makes an empty run fail, and
    // this proves the run is not empty today. Together they mean the job is executing real
    // assertions rather than merely being configured to.
    const frontendSrc = path.resolve(__dirname, "../../../frontend/src");
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.test\.(js|jsx)$/.test(entry.name)) found.push(full);
      }
    };
    walk(frontendSrc);

    expect(found.length).toBeGreaterThan(0);
  });
});

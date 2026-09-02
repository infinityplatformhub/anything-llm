// #111 — the guard on the guard.
//
// The smoke test beside `Toggle` proves the harness RUNS. This proves it cannot be quietly
// turned off. Both failure modes below were verified by hand before this file was written —
// a broken assertion exits 1, and a run with zero test files exits 1 — but a hand check
// protects the day it was run and nothing after it.
//
// The specific way a test gate dies in this repo is not deletion, which is visible in a diff.
// It is a config flag that makes the runner exit 0 without asserting anything: #73's CI job
// went green while a real-store suite never executed, and `claude plugin validate` reported
// clean with no SKILL.md in the tree. `passWithNoTests: true` is exactly that flag — it turns
// "someone removed every frontend test" from a red build into a green one.

import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, test } from "vitest";

// Resolved from the vitest root (the `frontend/` directory) rather than from `import.meta.url`:
// under vitest's transform that is not a file: URL, so `fileURLToPath` throws before any
// assertion runs — which fails the suite for a reason unrelated to what it is testing.
const configPath = resolve(process.cwd(), "vitest.config.js");
const packagePath = resolve(process.cwd(), "package.json");

describe("#111: the frontend test gate cannot be disabled without failing", () => {
  test("passWithNoTests is off, so an empty run is a red build", () => {
    // Asserted against the config SOURCE rather than by shelling out to a second vitest run:
    // a nested run would inherit this process's environment and CLI flags, so it could pass
    // for reasons that have nothing to do with the committed configuration.
    const config = readFileSync(configPath, "utf8");

    expect(config).toMatch(/passWithNoTests:\s*false/);
  });

  test("the test script actually runs vitest, and runs it once", () => {
    // `vitest` with no `--run` starts a WATCHER: in CI it would hang until the job timed out,
    // or — worse on some runners — detect a non-TTY, exit 0, and report success having watched
    // nothing. The `--run` is what makes this a gate rather than a dev convenience.
    const { scripts } = JSON.parse(readFileSync(packagePath, "utf8"));

    expect(scripts.test).toBe("vitest --run");
  });

  test("the DOM matchers are loaded, so a DOM assertion fails rather than throws", () => {
    // Without `@testing-library/jest-dom`, `toBeInTheDocument` is not a function — which
    // surfaces as a thrown TypeError. That still fails a test, so it is not silent, but it
    // fails with a message about a missing method rather than about the DOM, and the next
    // person spends the afternoon on the wrong problem.
    expect(typeof expect(document.body).toBeInTheDocument).toBe("function");
  });
});

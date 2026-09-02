// #111 — global test setup.
//
// `@testing-library/jest-dom` registers the DOM matchers (toBeInTheDocument, toBeChecked,
// toBeDisabled, ...). Without it those read as `expect(...).toBeInTheDocument is not a
// function` rather than as a failing assertion, so it is loaded once here instead of per file.
import "@testing-library/jest-dom/vitest";

// #139 (QA-2): the same version guard `pretest` runs, from the one place that
// covers EVERY route into the suite.
//
// `pretest` is a yarn lifecycle script, so it fires for `yarn test` and for
// nothing else. `npx vitest --run`, an editor's test runner and any CI step that
// invokes the binary all skip it — measured: 52 TypeErrors on Node 26 with the
// pretest guard in place and no warning at all. Since vitest.config.js already
// loads this file, the check here fires for every one of those routes.
//
// Imported, never copied: two spellings of "which Node is required" is the drift
// this file's own neighbours (four .nvmrc files) demonstrate.
import { nodeVersionComplaint } from "../../scripts/check-node-version.mjs";

const complaint = nodeVersionComplaint();
if (complaint) {
  // Thrown, not `process.exit`: this runs inside a worker, and throwing lets
  // vitest report it as the setup failure it is rather than killing the process
  // with no output.
  throw new Error(complaint);
}

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount between tests. Testing Library renders into a container appended to document.body,
// and without this every render accumulates: a later `getByRole` would find the previous
// test's element and pass for the wrong reason — the exact shape of a test that is green while
// asserting nothing.
afterEach(() => cleanup());

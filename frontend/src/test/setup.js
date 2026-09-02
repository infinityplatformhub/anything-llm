// #111 — global test setup.
//
// `@testing-library/jest-dom` registers the DOM matchers (toBeInTheDocument, toBeChecked,
// toBeDisabled, ...). Without it those read as `expect(...).toBeInTheDocument is not a
// function` rather than as a failing assertion, so it is loaded once here instead of per file.
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount between tests. Testing Library renders into a container appended to document.body,
// and without this every render accumulates: a later `getByRole` would find the previous
// test's element and pass for the wrong reason — the exact shape of a test that is green while
// asserting nothing.
afterEach(() => cleanup());

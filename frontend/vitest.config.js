import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "url";
import react from "@vitejs/plugin-react";

/**
 * #111 — the frontend's first test configuration.
 *
 * Deliberately SEPARATE from vite.config.js rather than a `test:` block inside it. That file
 * carries the dev server, the wasm assetsInclude, the worker format, a `define` that injects
 * the whole of process.env into the bundle, and the browser polyfill aliases
 * (process/browser, stream-browserify, ...). Those exist to make the app run in a browser;
 * loading them under jsdom pulls polyfills the tests do not want and makes a failure there
 * indistinguishable from a failure here. This file declares only what a test run needs.
 *
 * The `@` alias is repeated rather than imported from vite.config.js because it is the one
 * thing both files must agree on, and every source file uses it — if it drifts, the failure
 * is a module-not-found at test time, which is loud rather than subtle.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: "@",
        replacement: fileURLToPath(new URL("./src", import.meta.url)),
      },
    ],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.js"],
    include: ["src/**/*.test.{js,jsx}"],
    // NOT passWithNoTests. A runner that exits 0 when it matched nothing is the failure this
    // repo has already paid for twice — #73's CI job going green while a real-store suite
    // never executed, and `claude plugin validate` reporting clean with no SKILL.md in the
    // tree. With this off, deleting every test file turns the gate RED instead of green,
    // which is the only behaviour that makes "tests passed" mean anything.
    passWithNoTests: false,
  },
});

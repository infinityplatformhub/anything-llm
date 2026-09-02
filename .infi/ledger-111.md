# ledger — #111 frontend test harness

Branch `approof/111-frontend-harness`, base `ea5f81e46`, SHA `41109efd9`.
Contract: `cd frontend && yarn test` → `Tests  8 passed (8)`; server guard 6/6.

Opened because S11b (#108) could not write the tests its own contract requires: the frontend
had no test runner, no `test` script, no DOM library, and no CI job. Ruling was harness first,
merge, then S11b lands with its tests on day one — rather than folding "introduce frontend
testing to this repo" inside a settings page review.

---

## Rulings

Ruling: `passWithNoTests` is **false**. A runner that exits 0 having matched no files is the
failure this repo has already paid for twice — #73's CI job green while a real-store suite
never executed, and `claude plugin validate` reporting clean with no `SKILL.md` in the tree.
With it off, deleting every frontend test turns the build RED. Verified by execution, not by
reading: `No test files found, exiting with code 1`. If wrong: nothing — the only behaviour
lost is "an empty test run counts as success", which is the behaviour being refused.

Ruling: the frontend gets its **own CI job**, not a step on `test`. That job carries postgres,
chroma, qdrant, weaviate and milvus for the real-store suites, and none of it is needed to
render a component under jsdom. Appending there would make every frontend test wait on five
containers and — worse — let a vector-store outage fail a button test, which is how a suite
earns a reputation for flaking and then gets ignored. If wrong: two jobs instead of one, and a
few seconds of duplicated `yarn install`.

Ruling: the assertion that the frontend job exists lives on the **server side**
(`server/__tests__/security/frontendTestsRunInCi.test.js`). A guard inside the frontend job
disappears exactly when that job stops running — it cannot report its own absence. The server
suite runs on every PR, so removing the frontend job now turns the SERVER job red. Same
reasoning as `realStoreSuitesRunInCi.test.js` (#73). Mutation-verified: deleting the job fails
2 tests, adding `continue-on-error` fails 2.

Ruling: the smoke test is written against `Toggle`, a component that **already existed** and
that this issue does not touch. A harness proven only against a component authored alongside it
proves the component, not the harness — the two would have been shaped to fit each other, and
the first real test written later is the one that discovers jsdom, the `@` alias, or the JSX
transform was never actually exercised. `Toggle` was chosen because it exercises the parts most
likely to be misconfigured: JSX through `@vitejs/plugin-react`, a third-party ESM import
(`@phosphor-icons/react`) resolving under jsdom, the `@` alias every source file uses, and real
DOM state so the assertions are about behaviour rather than about a string appearing.

Ruling: `vitest.config.js` is a **separate file** from `vite.config.js`, not a `test:` block
inside it. That file carries the dev server, wasm `assetsInclude`, worker format, a `define`
injecting all of `process.env` into the bundle, and browser polyfill aliases
(`process/browser`, `stream-browserify`). Those exist to make the app run in a browser; loading
them under jsdom pulls polyfills the tests do not want and makes a failure there
indistinguishable from a failure in the harness. The `@` alias is duplicated deliberately —
it is the one thing both files must agree on, and if it drifts the failure is a
module-not-found at test time, which is loud rather than subtle.

Ruling: Node globals are enabled for **test paths only** in `eslint.config.js`, not relaxed
globally. `process.cwd()` in a test was reported `no-undef` under `globals.browser` — a real
rule catching a false positive. Scoped to `src/**/*.test.{js,jsx}` and `src/test/**`, so
`process` in a COMPONENT is still an error, which is what that rule exists to prevent.

## Verification — the failure modes were executed, not argued

A harness is the one thing that cannot be trusted on a green run alone, because "passed" and
"did nothing" look identical. Both were driven by hand before the CI job was written:

| forced state | result |
|---|---|
| assertion broken (`toHaveBeenCalledWith(true)` → `(false)`) | exit 1, 1 failed |
| every test file removed | exit 1, `No test files found` |
| `passWithNoTests` flipped to true | exit 1 — the guard test catches it |
| `--run` dropped from the test script | exit 1 — a watcher in CI hangs or exits 0 having watched nothing |
| frontend job deleted from ci.yml | 2 server tests red |
| `continue-on-error` added | 2 server tests red |

## Note

Lint is 71 problems on this branch — **identical to main's baseline**, verified by stashing the
work and re-running rather than assumed. None are mine; the four my files initially introduced
were fixed.

## Residual

The harness is one smoke test plus its guards. Every existing frontend component remains
untested, which is not this issue's scope — but the gate now exists, so the next UI change can
be asked for tests rather than told there is nowhere to put them.

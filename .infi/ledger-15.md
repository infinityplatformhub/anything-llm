# Ledger — issue #15 · Phase 0 E2E gate (Playwright on the real docker stack)

Branch: `approof/e2e-playwright` · Worktree: `.claude/worktrees/e2e`
Owner: Dev 3 · Status: **12/12 green** at 9bb314b2 (pre-rebase base); re-verification
on latest main is blocked by a main-side Dockerfile break (see Findings).

## What this gate covers

One ordered flow (workers=1) over a stack raised by `e2e/scripts/up.sh`:
onboarding wizard → embedder switch → login (de-brand + network check) →
workspace → upload + embed → chat with citation → member user via admin UI →
API key via admin UI → audit log → member negative (no admin UI, admin route
denied) → restart resilience → logout.

## Regressions this gate caught on main

1. **`EventLogs is not defined` (hotfix #24).** `POST /api/system/event-logs`
   returned 500 and the whole Event Logs admin page was broken: the P0-6 sweep
   replaced the write path with `emitAuditEvent` and dropped the import, but
   three read/delete call sites still referenced `EventLogs`. No unit test saw
   it; spec 09 did. Fixed on main, spec 09 went green on the rebase.
2. **Docker image cannot build (open).** `docker/Dockerfile:141` still uses
   `node:18-slim` while root, server and frontend `package.json` all declare
   `"node": ">=22 <23"`, so `yarn install` fails in both build stages. This
   breaks real deploys, not just E2E. Reported to PMO; not fixed here (infra
   file, outside #15's scope).

## Rulings

- **Ruling: the stack env stays unconfigured.** `server/utils/boot/markOnboarded.js`
  treats any of LLM_PROVIDER / VECTOR_DB / AUTH_TOKEN / JWT_SECRET as "legacy
  instance already onboarded" and completes onboarding at boot. Pre-configuring
  providers and testing the wizard are mutually exclusive; the wizard wins, and
  the test configures the provider through the real onboarding UI.
  *If wrong:* we would test a shortcut path instead of what a new operator sees.
- **Ruling: mock LLM provider instead of a real key.** A small node container
  answers the generic-OpenAI endpoints with canned SSE and deterministic
  embeddings. Its embedding is **bag-of-words**, not a hash: a random vector
  never clears the workspace similarity threshold, so retrieval would return no
  citations. *If wrong:* the citation assertion tests nothing.
- **Ruling: mock-llm must share the app's docker network.** Compose put it on
  the default network, so the app could not resolve `mock-llm` and every
  embedding failed with a connection error that surfaced only as an empty
  document list. *If wrong:* silent embedding failure, green-looking upload.
- **Ruling: spec 05 uploads through the product API, not the picker modal.**
  The document picker re-renders rows on select (selection is a row `onClick`,
  the checkbox is a styled div), which made Move-to-Workspace flaky without
  protecting anything the gate exists for. Upload + `update-embeddings` now use
  the endpoints the UI itself calls, and the modal keeps one assertion so it is
  not zero-coverage. Approved by PMO with that condition.
  *If wrong:* a regression confined to the picker UI would not be caught.
- **Ruling: session tokens are cached across specs.** Login is rate-limited to
  5 attempts per window (from the P0-4 rate-limit work) and the suite has 12
  specs, so specs 6+ silently hit 429 and sat on `/login`. Specs 03 and 12 still
  drive the real login form; the rest replay a cached token.
  *If wrong:* we lose per-spec login coverage, which 03/12 still provide.
  *Residual (not this issue's scope):* the UI shows no error on a 429 login —
  the form just does nothing.
- **Ruling: the test workspace is pinned to `chatMode: query`.** The default
  `automatic` mode routes questions to the agent, which bypasses RAG and returns
  no sources — this, not the embedder, was why citations were empty.
  *If wrong:* agent-mode chat is not covered by this gate.
- **Ruling: the mock provider URL lives in `e2e/config.js`.** Built from
  `MOCK_LLM_HOST` at runtime so no scheme+host literal appears in specs (gate
  §7.4). Techlead's requirement.
- **Ruling: ports are 3111 (app), 3112 (mock), 55434 (postgres), all bound to
  127.0.0.1, in compose project `aproof-e2e`.** The dev machine holds 3001,
  3101, 5432 and 55433. `up.sh` runs `down -v` and wipes storage before each
  run: onboarding happens once per volume, and the vector cache would otherwise
  replay vectors from a previous embedder.

## Test facts worth keeping

- Login inputs have no `<label>` wiring — select by `input[name=…]`; the
  password field is a controlled component that can drop a programmatic fill.
- First login of a fresh admin shows a Recovery Codes modal (Download → Close).
- The SPA keeps its JWT in `localStorage` (`approofworkspace_authToken`), so
  `page.request` calls need the header injected.
- The provider model field is a `<select>` when the provider lists models and a
  free-text `<input>` when it does not.
- Sidebar upload buttons are per-workspace; `.first()` is the default workspace.

## Evidence

```
e2e/scripts/up.sh up
npx playwright test --config e2e/playwright.config.js
→ 12 passed (12/12)
```

## Addendum — verification on fixed main (a550dccf)

**Dockerfile fix landed in two parts.** `450b19b1` changed only line 141
(`frontend-build`); the `build-arm64` / `build-amd64` base stages still installed
node 18 from nodesource, so `backend-build` (which is `FROM build-${TARGETARCH}`)
still failed `yarn install` with the same engines error. Reported; main fixed
lines 25 and 94 to `node_22.x`. Both arches must move together — patching one
leaves the other failing only on a multi-arch build, where nobody looks.

- **Ruling: `denyReason` restored to the audit allowlist.** The branch was
  reverting main's T-6 addition of that key to `ALLOWED_KEYS` in
  `server/utils/events/redaction.js` — a stale hunk carried through an earlier
  rebase, not a decision. #15 contributes no server code; the diff against main
  is now `e2e/` and docs only. *If wrong:* a deny reason would be silently
  dropped from audit rows, and the gate would have shipped an unrelated
  behaviour change under an E2E issue.

**Running `server` tests locally needs four things CI supplies implicitly.**
Without them the suite reports 22 failed suites that are all environment, not
code — worth knowing before anyone reads a local red run as a regression:

- `node@22` — the machine default is node 26, and `yarn` refuses on `engines`.
- `API_KEY_PEPPER` (≥32 bytes) — R8's boot check fails 6 suites at import time.
- `STORAGE_DIR` — `utils/files/index.js:10` resolves it outside development;
  undefined throws `paths[0] must be of type string` and takes `routeWiring` out.
- **A dedicated empty database.** `actorResolver`'s single-user row mocks
  `isMultiUserMode` but `isConfirmedSingleUser` also counts real `users` rows
  (deliberately — QA-2 FINDING-1), so pointing `DATABASE_URL` at a database that
  has users makes a correct test fail. CI uses `approofworkspace_test`; locally,
  create it and `prisma migrate deploy` before running.

## Evidence (fixed main)

```
e2e/scripts/up.sh up && (cd e2e && ./node_modules/.bin/playwright test)
→ 12 passed, three consecutive runs with down -v + storage wipe between
  (45.8s / 45.0s / 44.7s)

task.sh check --issue 15 --base faac5f24
→ check ผ่านทุกด่าน
→ Tests:       1052 passed, 1052 total
```

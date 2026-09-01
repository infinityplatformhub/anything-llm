# Ledger — issue #10 · P0-4 PR-0b env-dump auth + route auth sweep

Branch: `approof/p0-4-pr0b-envdump` · Worktree: `.claude/worktrees/p0-4-pr0b`
Date: 2026-09-02 · Owner: Dev 3/4

## What

1. `GET /v1/system/env-dump` (server/endpoints/api/system/index.js:16) had **no
   middleware at all** — unauthenticated callers in production could trigger
   `dumpENV()` writing `.env` to storage. Swagger claimed 403/InvalidAPIKey; code
   never checked. Added `[validApiKey]`.
2. Regression guard: `apiRouteAuthSweep.test.js` enumerates every route across all
   9 developer-API endpoint files via a recording fake app and asserts each carries
   `validApiKey`. A route registered without a middleware array (how this bug
   shipped) or without validApiKey fails the sweep by name.

## Rulings

- **Ruling:** Route count asserted **63** (62 from recon F-2 + env-dump). PMO's cc
  count confirmed by the sweep itself — mutation 3 (adding a 64th route) trips it.
  Count assertion is deliberate friction: adding a route means updating the number
  and thereby seeing the auth requirement.
- **Ruling:** Sweep checks identity `middlewares.includes(validApiKey)` not name-
  string, so a same-named stub can't satisfy it. When PR-3 replaces validApiKey the
  sweep updates in the same PR (single import line).
- **Ruling:** `STORAGE_DIR` defaulted to `os.tmpdir()` at test top — document
  endpoint module resolves it at require time; without it the suite can't load.
  Test-only, no runtime change.

## Files

- `server/endpoints/api/system/index.js` (1-line: add `[validApiKey]`)
- `server/__tests__/endpoints/apiRouteAuthSweep.test.js` (new, 3 tests)

## Evidence

```
cd server && npx jest → Test Suites: 46 passed · Tests: 620 passed (617 baseline + 3 new)
```

RED before fix: sweep reported exactly `["GET /v1/system/env-dump (api/system)"]`
as unguarded — 2 failed / 1 passed.

### RED proofs (3 mutations, restored after each)

1. **Remove `[validApiKey]` from env-dump** → 2 failed (sweep + env-dump-specific test).
2. **Remove `[validApiKey]` from `POST /v1/workspace/new`** (different file) → 1 failed,
   sweep names the route — proves coverage beyond the original bug.
3. **Register extra unguarded route `/v1/system/env-dump-extra`** → 2 failed (count 64≠63
   + unguarded list). Proves new-route regression protection.

Final state: full suite green, `git diff` shows only the intended 1-line change +
new test file.

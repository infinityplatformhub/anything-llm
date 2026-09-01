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

## QA-2 round 2 — second hole, same class (fixed)

QA-2 exploited `GET /api/env-dump` (endpoints/system.js:91, the INTERNAL admin
route — distinct from /v1/system/env-dump): **no middleware at all, not even
validatedRequest**. Unauthenticated 200 → production dumpENV() rewrites
server/.env from protectedKeys — env values not in that list are lost after the
rewrite: data-loss DoS on restart.

Fixes:
1. Guard added: `[validatedRequest, flexUserRoleValid([ROLES.admin])]` —
   admin-only, not admin+manager: rewriting the environment file is a
   system-management action, and this route has no API-key equivalent, so the
   strictest existing gate applies.
2. Sweep extended beyond endpoints/api/*: the internal system.js env-dump route
   is asserted from source (system.js registers the real Express app and cannot
   be required standalone into a recorder). Only dumpENV-triggering routes are
   source-asserted; a full internal-route sweep is P0-5 territory.
3. Per-module assertions (PMO suggestion, adopted): every module must register
   ≥1 route and `register()` must return undefined — kills the
   silent-empty-module failure mode where a `return express.Router()` early-exit
   makes the recorder see 0 routes and the count assertion silently absorbs it.

### Rulings (round 2)

- **Ruling:** `/v1/system` env-dump and `/v1/system` currentSettings must get
  **admin-level scopes in PR-B** — not a general scope. QA also flagged that
  currentSettings may return **actual secret values**, not just presence
  (swagger example shows `"[KEY_NAME]": "KEY_VALUE"`). Verify at PR-B; if true,
  that's its own finding.
- **Ruling:** internal-system.js routes are covered by source-assertion only for
  dumpENV routes; the api/ recorder sweep stays identity-based.

### Evidence (round 2)

- Initial RED: reverting system.js guard (git checkout HEAD) → 1 failed
  (internal env-dump test).
- Mutation: `apiAuthEndpoints` returns before registering → 2 failed (per-module
  ≥1-route + count 62≠63) — proves the silent-module guard.
- Final: full suite **622/622** (617 baseline + 3 + 2 new).

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

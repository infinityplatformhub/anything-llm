# Ledger — issue #8 · P0-4 PR-0 SSO issuance hotfix

Branch: `approof/p0-4-pr0-sso-hotfix` · Worktree: `.claude/worktrees/p0-4-pr0`
Date: 2026-09-02 · Owner: Dev 3/4

## What

Close `GET /v1/users/:id/issue-auth-token` by default (403) until PR-5 ships scope
enforcement. Any valid API key could mint a temp token for any user (incl. admin)
and exchange it for a real session JWT at `/request-token/sso/simple` — full admin
impersonation (recon F-4).

## Rulings applied

- **Ruling:** R10 (PMO) — hotfix now, not waiting for scopes; default-closed confirmed
  by PMO ("ยังไม่มีลูกค้า, ช่องโหว่คือ full admin impersonation").
- **Ruling:** Flag named `SIMPLE_SSO_ISSUE_UNSAFE_ALLOW` (opt-in reopen, truthy check —
  empty string stays closed). "UNSAFE" in the name so an operator can't set it without
  reading what they're accepting. Removed by PR-5.
- **Ruling:** `ssoIssuanceLock` placed FIRST in the middleware chain — the 403 fires
  before `validApiKey` touches the DB; also means the lock holds even if later
  middleware is reordered.
- **Ruling (corrected per e5 design review):** Exchange endpoint
  `/request-token/sso/simple` (system.js:353) left open. Temp tokens are single-use
  with 6-minute expiry, **but** a successful exchange yields a session JWT with
  `JWT_EXPIRY` (default 30 days). So: (a) temp tokens issued before deploy remain
  exchangeable for up to 6 minutes after deploy — operators must purge
  `temporary_auth_tokens` post-deploy; (b) sessions already minted via this hole are
  untouched by the hotfix — rotating `JWT_SECRET` is the only revocation. Both are in
  the release note. Original ledger wording ("no long-lived tokens can be
  outstanding") was wrong about what the exchange produces.
- **Ruling (e5):** Flag-open path logs a `console.warn` naming the flag and risk on
  every request, so an operator running with the flag sees it in logs. **PR-5 DoD
  must include:** `grep -rn SIMPLE_SSO_ISSUE_UNSAFE_ALLOW server/` → 0 matches
  (flag, middleware, and tests all removed).
- **Ruling (e5):** Guard stays in middleware, not `TemporaryAuthToken.issue()` —
  PR-5 removes it anyway. If PR-5 slips past 2 weeks, PMO will order the move.
- **Ruling:** Plan-doc name for the flag was `SIMPLE_SSO_ISSUE_DISABLED` default-closed;
  inverted to an allow-flag because "disabled flag absent = disabled" double-negative
  is error-prone. Semantics identical (default-closed).

- **Ruling (QA-2 CONFIRMED fix):** Truthy check replaced with an explicit off-set.
  Plain JS truthiness meant `"false"`, `"0"`, `"no"`, `"off"`, `" "` all REOPENED
  the endpoint (QA-2 exploited 5/5) — an operator writing
  `SIMPLE_SSO_ISSUE_UNSAFE_ALLOW=false` to disable would enable. Now
  `{"", "0", "false", "no", "off"}` after trim+lowercase keep the lock closed;
  unset keeps it closed; anything else is the deliberate opt-in. 8 off-value test
  cases added; mutation reverting to truthiness → 7 tests fail.

- **Ruling (QA-2 round 3, PMO):** Flag flipped from off-set to **allowlist**
  `{"1","true","yes","on"}` (trim+lowercase). The off-set still let `"null"`,
  `"undefined"`, `"disabled"`, `"n"`, `"-1"`, `"0.0"` open the endpoint —
  templating garbage and operator-intent strings. For a flag that opens admin
  impersonation, fail-closed on everything not explicitly listed.
- **Ruling (QA-2 round 3):** HTTP-level suite added (`ssoIssuanceLockHttp.test.js`,
  adapted from QA-2's pattern-8): real app via `require("../index")`, pushed temp
  SQLite schema, counts `temporary_auth_tokens` rows, asserts response BODIES to
  distinguish the lock's 403 from validApiKey's 403. `supertest` added as a
  devDependency (QA's pattern depends on it; test-only).

## Files

- `server/utils/middleware/ssoIssuanceLock.js` (new)
- `server/endpoints/api/userManagement/index.js` (chain: `[ssoIssuanceLock, validApiKey, simpleSSOEnabled]`)
- `server/__tests__/utils/middleware/ssoIssuanceLock.test.js` (new, 3 tests)
- `server/__tests__/endpoints/ssoIssuanceHotfix.test.js` (new, 2 tests)

## Evidence

Baseline + new, all green:

```
cd server && PATH="/opt/homebrew/opt/node@22/bin:$PATH" npx jest
→ numPassedTests: 622 (617 baseline + 5 new), numFailedTests: 0, success: true
```

### RED proofs (3 mutations, each restored after)

1. **Guard disabled** — `sed 's/if (!process.env.SIMPLE_SSO_ISSUE_UNSAFE_ALLOW)/if (false)/'`
   → `ssoIssuanceLock.test.js`: **2 failed**, 1 passed.
2. **Middleware removed from route chain** — `sed 's/\[ssoIssuanceLock, validApiKey, simpleSSOEnabled\]/[validApiKey, simpleSSOEnabled]/'`
   → `ssoIssuanceHotfix.test.js`: **2 failed**.
3. **Truthy check weakened to `"…" in process.env`** (empty string would reopen endpoint)
   → `ssoIssuanceLock.test.js`: **1 failed** (empty-string case).

Initial RED before implementation: suite failed with
`Cannot find module '../../../utils/middleware/ssoIssuanceLock'`.

## Release note (for PMO to include)

> **Simple SSO temporary-auth-token issuance is disabled in this release.**
> `/v1/users/:id/issue-auth-token` previously let ANY valid API key impersonate any
> user, including admins. It returns with the scoped-API-key release (P0-4 PR-5).
>
> **Required operator actions after deploying:**
> 1. Purge outstanding temporary auth tokens — tokens issued before the deploy can
>    still be exchanged for a session until they expire:
>    `DELETE FROM temporary_auth_tokens;`
> 2. If you suspect this endpoint was ever abused, rotate `JWT_SECRET`. Sessions
>    minted through this hole are full session JWTs valid for `JWT_EXPIRY`
>    (default 30 days); this release does not invalidate them — only a secret
>    rotation does (it logs out all users).
>
> **Breaking:** any integration that calls `issue-auth-token` (Simple SSO login
> flows) stops working immediately after deploy. Verify your dependencies before
> upgrading. Operators who accept the impersonation risk in the interim can set
> `SIMPLE_SSO_ISSUE_UNSAFE_ALLOW=1`; the server then logs a warning on every
> issuance request.

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
- **Ruling:** Exchange endpoint `/request-token/sso/simple` (system.js:353) left open —
  tokens are single-use, 6-minute expiry; no long-lived tokens can be outstanding.
- **Ruling:** Plan-doc name for the flag was `SIMPLE_SSO_ISSUE_DISABLED` default-closed;
  inverted to an allow-flag because "disabled flag absent = disabled" double-negative
  is error-prone. Semantics identical (default-closed).

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

> Simple SSO temporary-auth-token issuance (`/v1/users/:id/issue-auth-token`) is
> disabled in this release: any API key could previously impersonate any user,
> including admins. It returns until the scoped-API-key release (P0-4 PR-5).
> Operators who accept the impersonation risk in the interim can set
> `SIMPLE_SSO_ISSUE_UNSAFE_ALLOW=1`.

# Ledger — issue #36 · S1 OIDC identity provider

Branch: `approof/s1-oidc` · Worktree: `.claude/worktrees/s1-oidc`
Owner: Dev 3 · Scope after the R3 split: **OIDC only** — new files, schema,
`index.js` mount. `endpoints/system.js`, `frontend/src/models/system.js`,
`models/systemSettings.js`, `utils/helpers/updateENV.js` and
`ssoIssuanceLockHttp.test.js` are untouched.

## What shipped

`GET /api/sso/:provider/login` → IdP (Authorization Code + PKCE) →
`GET /api/sso/:provider/callback` → session JWT. Eight tasks, RED before GREEN
on every one.

| | |
|---|---|
| T1 | `identity_links`, `identity_login_state` + migrations `080000`/`081000` |
| T2 | five seam-01 error classes |
| T3 | `OidcIdentityProvider` — discovery, PKCE, JWKS |
| T4 | provider registry |
| T5 | `IdentityLoginState` — single-use state/nonce |
| T6 | `linkPrincipal` — R1, R2, subject stability |
| T7 | routes + rate limiter |
| T8 | login-state sweep registered with T-6's purge |

## Rulings

- **Ruling: `jose` was rejected; `jsonwebtoken` + `crypto.createPublicKey` used
  instead.** `jose` v6 is ESM-only and cannot load under this CommonJS Jest
  setup, and it was only ever a transitive dep of `@modelcontextprotocol/sdk`.
  `jsonwebtoken` is already a direct dependency and `createPublicKey({format:
  "jwk"})` is built in, so JWKS verification adds **no new dependency**.
  *If wrong:* a hand-rolled JWK→PEM conversion, which is worse.
- **Ruling: the `alg` allowlist is fixed at `["RS256","ES256"]` and never read
  from the token header.** Asking a token which algorithm to verify it with is
  alg-confusion: HS256 would let anyone holding the client secret — a credential
  the app hands out, not a signing key — mint their own identities.
  *If wrong:* widening the list is a deliberate change, not a compatibility fix.
- **Ruling: every published JWKS key is tried, not just the first match**
  (Techlead F2). A provider mid-rotation normally publishes two keys with no
  `kid`; first-match-only made every rotation an outage reported as a bad
  signature. This is not "accept anything" — candidates are only the issuer's
  own published keys, and issuer/audience are still checked per attempt.
- **Ruling: JWKS cached 10 minutes, with exactly ONE refetch on an unknown
  `kid`** (Techlead F1). Fetching per login made the login path only as
  available as the IdP and let junk tokens amplify traffic onto it. One refetch
  keeps rotation working without buying an attacker unbounded fetches.
- **Ruling: state/nonce consumption is a conditional `updateMany`.**
  `consumedAt: null` and an unexpired `expiresAt` are in the WHERE, never
  checked beforehand: read-then-write lets two concurrent callbacks both pass
  and both log in. *If wrong:* a doubled login, which the PK alone does not stop.
- **Ruling: rows are consumed, never deleted on use.** A consumed row that still
  exists is how a replay is told apart from an expiry — different incidents for
  an operator, same refusal for the user.
- **Ruling: R1 refuses an email collision and names the settings flow.**
  Auto-linking is the classic takeover: anyone who can register that address at
  the IdP inherits the account. Same email under a different subject is refused
  too — the same attack from the other side.
- **Ruling: SSO users get a bcrypt hash of 64 discarded random bytes.** The
  column is NOT NULL and the local login path compares against it, so it cannot
  be blank; nobody holds the plaintext. *If wrong:* an empty or short hash is a
  password-less account.
- **Ruling: the session comes from `TemporaryAuthToken`, not a new type.**
  PMO ruling; S13 (MFA) then wraps one path instead of forking it.
- **Ruling: callback refusals are flat 401s.** Telling a caller whether a state
  was replayed, expired or never existed is an oracle. R1's conflict (409) is
  the one exception, because it is the only case a user can act on.
- **Ruling: the login-state sweep runs BEFORE the audit-window guard.** Logins
  expire on their own 15-minute clock; coupling them meant an operator who never
  set audit retention grew the table on every login attempt.
- **Ruling: the registry table is null-prototype.** `provider` comes from the
  URL, and a plain object would resolve `constructor` to something that is not a
  driver.
- **Ruling: no userinfo call.** Email must be in the id_token — a second round
  trip on the login path, and an IdP withholding email is a configuration
  problem to fix at the IdP.
- **Ruling (ponytail): the discovery cache has no TTL.** Endpoint URLs
  effectively never move and driver instances are per-request, so the window is
  short. Needs a TTL only if drivers become long-lived singletons. Accepted
  residual.

## Defects found and fixed during review

Techlead F1 and F2 were both **real, reproduced RED before fixing** — not
hypotheticals. F2 in particular would have surfaced as an intermittent "bad
signature" outage every time the IdP rotated keys.

## Mutation testing

Every guard was proved by breaking it. Seventeen mutants, each caught by the
test that names it:

- driver: remove nonce check · relax `email_verified` to `=== false` · allow
  HS256 with the client secret · disable JWKS cache · first-match-only keys ·
  refetch on every miss · drop issuer/audience
- login state: read-then-write consume
- linkPrincipal: auto-link on collision · skip `syncLegacyRoleGrant` · ignore
  suspension · key identity off email
- routes: drop the limiter · read state instead of consuming · return
  `error.message` on 401 · mint state without persisting
- purge: move the sweep behind the audit guard

One equivalent mutant is documented rather than chased: the `!claims.nonce` half
of the nonce check, since `completeLogin` already rejects an empty
`expectedNonce`. Kept as defence-in-depth.

## Evidence

```
cd server && yarn test
→ Test Suites: 123 passed, 123 total
→ Tests:       1269 passed, 1269 total
```

Local runs need node@22, `API_KEY_PEPPER`, `STORAGE_DIR` and an empty
`approofworkspace_test` database (see ledger-15's addendum).

# Techlead — #60 S3 LDAP route, `17aadd2f`

Reviewed: `17aadd2f` (Dev3, worktree `.claude/worktrees/s3-ldap`, branch `approof/s3-ldap`)
Delta reviewed in full: `54081944..17aadd2f` (the route commit); `54081944` fixtures were reviewed
separately after my FAIL on `da87ec42`.
Verdict: **PASS**. No blocker, no major. Three notes below, all NIT.

Delta: 11 files, +819/-15 — `endpoints/identity/ldap.js` (new, 246), `endpoints/identity.js` (+12),
`index.js` (+4), `identityProviders/index.js` (+27), driver comment (+10/-2),
`ldapRoutesHttp.test.js` (new, 306), `ldapDriver.test.js` (+47), frontend (+87/-12), ledger.

## The specific points asked, verified

**Wildcard rejects a `redirect:false` provider via `providerCapabilities()`**
`identity.js:65-75` — `if (providerCapabilities(provider).redirect === false) return 404` placed BEFORE
`providerConfig(provider)`. Correct position: the 500 Dev3 hit came from the wildcard building an
OIDC-shaped config for "ldap", and the check has to precede the build to prevent it. `providerCapabilities`
returns `{}` for an unknown provider rather than throwing, so a caller that already ran `isKnownProvider`
needs no second try/catch — and `{}` .redirect is `undefined`, which `=== false` does not match, so an
unknown provider still falls through to the existing `isKnownProvider` 404 rather than being silently
reclassified. Checked: `LdapIdentityProvider.capabilities()` is static and reads no config, so the call is
genuinely free of the configuration the caller is about to look up.

**Mount order** `index.js:137-140` — `ldapIdentityEndpoints(apiRouter)` before `identityEndpoints(apiRouter)`.
Express matches in registration order, so this is load-bearing, and it is the cd4fda5e defect repeating.
The test asserts `status === 200`, not merely `!== 404` — the wildcard is a GET route and would answer a
POST with 404, so a "not 500" assertion would have missed it entirely. That is the §7.9 form.

**Password scope + `finally` clear** `ldap.js:157,238-241` — `let password` at handler scope, `password = null`
in `finally`. The comment states plainly that this is best effort and cannot be a guarantee (the engine may
hold the parsed body and interned copies). I would have flagged a comment that implied otherwise; this one
says the true thing.

**Log message only** `ldap.js:216` — `console.error(..., error.message)`, never the error object and never
the request body. The reason is real: `_classify` deliberately does not attach the original error as `cause`
for result 49, because some ldapts versions carry the bind credential on it. Verified in the driver at
`_classify`'s final branch. Grepped the delta for any other log of `request.body` or `password` — none.

**No audit entry carries the credential** `ldap.js:203` emits `login_event` with `{ip, multiUserMode}` and the
user id; the failure path emits `failed_login_invalid_temporary_auth_token` with `{ip, multiUserMode}`. Both
match the SAML ACS handler byte-for-byte in shape. Test `it never reaches the audit trail` asserts it.

**Plaintext refused; `LDAP_ALLOW_INSECURE` logs** `ldap.js:168-181` — `ldap://` without StartTLS returns 503
unless `LDAP_ALLOW_INSECURE` is set; when it IS set, `warnIfInsecureTransport()` prints at every boot.
Checked the escape hatch is not silent and that the refusal is at the route (a deployment decision) rather
than in the driver (which correctly reads no env). The 503 uses the same flat "identity provider is
unavailable" text as every other unavailable path — no oracle.

**`GET /sso/ldap/enabled` returns one boolean** `ldap.js:142` — `{enabled: <bool>}`, nothing else. No URL, no
base DN, no bind DN. It must be unauthenticated (the login form asks before anyone types) so the discipline
matters; test `it exposes NOTHING about the directory` asserts the response body's shape rather than just
its truthiness.

**Reset-password link hidden under LDAP** `MultiUserAuth.jsx:358+` — the link is replaced with a static
line. Correct for the stated reason: the password lives in the directory and this application cannot change
it, so the flow would end in a reset that changes nothing. `System.ldapEnabled()` fails CLOSED (`.catch(() =>
false)`), so a failed check renders the LOCAL form — the safe direction, since the unsafe one posts a
directory password to `request-token`, which bcrypt-compares it against a local hash.

**StartTLS — 2 tests** `ldapDriver.test.js:326` (negotiated BEFORE any bind) and `:349` (a FAILED StartTLS
aborts, with the assertion that nothing was sent over the plaintext connection afterwards). The second is
the one that matters; `_open()` deliberately does not catch around `startTLS`. `ldapDirectoryFixtures.test.js:344`
adds QA-1 G1: a SEARCH after a failed StartTLS is refused too — that closes the half where the bind is
blocked but the connection stays readable.

**`groups: []` comment** — now says ALWAYS empty and why (ruling 5: S4 owns group→role mapping; populating a
claim before the code that validates it exists puts an unvalidated assertion in front of core; groups are
observations, never authority per R2). This is the right correction: the previous comment read as "not
implemented yet", which invites someone to implement it in the driver.

## Also checked, not asked

- The DN comes from the search, never from input; `AndFilter`+`EqualityFilter` are built, not concatenated,
  and the injection test uses `alice)(uid=*` — the payload that adds a third clause inside the existing `&`,
  which is the case my `da87ec42` FAIL was about. It now runs against a fixture that actually parses `&`.
- Empty/whitespace password refused BEFORE any connection opens (RFC 4513 §5.1.2), and the route test
  asserts zero non-service binds reached the directory — the non-vacuous form.
- Both binds read `authenticated !== true` rather than inferring from the absence of a throw.
- Result code 49 is classified differently at the two binds — service bind → unavailable, user bind →
  refusal. Getting this backwards would report our own misconfiguration as every user's bad password.
- Unknown user, wrong password, ambiguous match (`length !== 1`) and injection are one flat `REFUSED`; the
  test compares `JSON.stringify` of both bodies, not just status.
- `409` for `IdentityConflictError` only — the one case the user can act on. Same as SAML.
- Role assignment: none in the route or driver. `linkPrincipal` sets `DEFAULT_ROLE = "default"` for every
  provider, so S1/S2/S3 share one policy.

## NIT-1 — the limiter is IP-only; local login has a second, per-account bucket
`/sso/ldap/login` carries `inviteRateLimit` (60s / 30, keyed by IP). The local password route
(`system.js:231`) carries BOTH `loginIpRateLimit` (30/IP) and `loginAccountRateLimit` (5, keyed by
`ip+username`). The LDAP route is a password-guessing endpoint pointed at the customer's real directory —
including its lockout counters — so the per-account bucket is arguably more relevant here than on the local
route. `loginKey` reads `request.body.username`, which this route also sends, so it would drop in unchanged.
Not a blocker: ruling 4 asked for a limiter and there is one, and 30/min/IP is a real ceiling. Raising it as
the asymmetry a reviewer would notice.

## NIT-2 — `GET /sso/ldap/enabled` shares the IP bucket with the login POST
Both use `inviteRateLimit` with the same `ipKey`, so the unauthenticated enabled-probe consumes the same 30
that logins draw from. Harmless today (the form asks once per render); worth knowing if the limit is ever
tightened, because the login path would be the one starved.

## NIT-3 — `simpleSSOLoginDisabled()` does not gate this route
`system.js:237` refuses local credential login when `SIMPLE_SSO_ENABLED` AND `SIMPLE_SSO_NO_LOGIN` are both
set; `invite.js:35` applies the middleware too. Neither SAML's ACS nor this LDAP route consults it. I read
that as correct and deliberate — the setting disables LOCAL credential login, and LDAP is the SSO path it
exists to steer people toward — but it is the kind of conjunction that reads as an oversight later.
Recording it so the answer is written down rather than rediscovered.

## What I did not verify
Did not run the suite (595/595 reported by Dev3 via PMO). `ldapts@^9.0.0` resolves to 9.0.0 in
`server/yarn.lock`; I did not audit the dependency itself.

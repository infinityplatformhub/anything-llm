# Ledger — issue #60 · S3 LDAP identity provider

Branch: `approof/s3-ldap` · base `origin/approof/main` `f89fba9a` (S2 merged)
Owner: Dev 3

## Fixtures first

Ruling: the mock directory is written before any LDAP client is chosen and is
DELIBERATELY UNHELPFUL — it reproduces the behaviours that turn an
obvious-looking driver into an authentication bypass, rather than politely
rejecting bad input; if this is wrong we carry a mock more complex than needed,
whereas a polite mock makes every driver test written against it worthless.

Ruling: `ldapDirectoryFixtures.test.js` tests the MOCK itself — this is #43's
lesson (commit `01888688`) in LDAP form: there, two XSW fixtures planted elements
the read path could never reach, so they went green against a deliberately unsafe
verifier and proved nothing. Making the mock reject empty passwords kills exactly
the two tests that assert the trap.

Ruling: `ldapEscape.js` (RFC 4515/4514) is its own module because S4's directory
sync needs the same rule without a client instance, and a second implementation
is how the two drift. The backslash pass runs FIRST and that ordering is
load-bearing — escaping `(` first mangles the escape just written.

## Client selection

Ruling: `ldapjs` is disqualified before any test — npm reports it DECOMMISSIONED,
and an unmaintained library on an authentication path is one CVE away from being
our problem. `ldapts` (MIT, maintained, no native build) is the candidate, and
`ldapClientEvaluation.test.js` is the evidence for the choice rather than an
assertion of it: escaping incl. backslash-first and NUL, buildable filters,
error types precise enough to separate "wrong password" from "server down", and
explicit TLS/StartTLS control.

Ruling: our escaping is asserted to AGREE with `Filter.escape` character for
character. Two implementations of one RFC that disagree means whichever call site
a value passes through decides the outcome.

## Driver (rulings 1-5)

Ruling 1: search-then-bind. The service account binds, the filter is BUILT via
`EqualityFilter` (never concatenated), the search must return EXACTLY one entry,
and the DN that is bound comes from the SEARCH — never assembled from input.

Ruling: 0 and >1 results are the SAME refusal as a wrong password. "No such user"
is an enumeration oracle; picking one of several is picking who to log in as —
the LDAP spelling of S2's XSW document-order bug.

Ruling: an empty, whitespace-only, null or undefined password is refused BEFORE
anything is sent. RFC 4513 §5.1.2 makes a blank password a SUCCESSFUL anonymous
bind, so forwarding it and reading "no exception" as "authenticated" admits
anyone against any DN.

Ruling 2: `beginLogin()` throws `IdentityCapabilityError`; `capabilities()`
declares `password: true, redirect: false`.

Ruling 5: `listPrincipals`/`listGroups` throw — LDAP genuinely COULD sync, which
is exactly why the flags must stay false until the code honours them.

Ruling: only unreachable-directory errors are `IdentityUnavailableError`
(retryable). A wrong password reported as retryable invites the automatic retries
that lock an account; an outage reported as bad credentials tells users their
password is wrong when it is not. The original error is NOT attached as a cause —
some client versions carry the password in it.

Ruling: the password appears in no principal, no error message and no log, and
the refusal names neither the password nor the username.

## Mutation proof

| mutant | expected kill | result |
|---|---|---|
| mock rejects empty password | the two trap tests | killed exactly those two |
| escape order: `(` before backslash | the two ordering tests | killed exactly those two |
| drop the empty-password guard | the two empty-password tests | killed exactly those two |
| `length !== 1` becomes `length === 0` (take the first) | the two multiple-match tests | killed exactly those two |
| built filter becomes concatenated | the two injection tests | killed exactly those two |
| drop the `authenticated !== true` check | — | **SURVIVED** (see below) |

### The survivor, and what it exposed

Dropping the `authenticated` flag check killed NOTHING at first: every test that
could have caught it was already refused by the empty-password guard one step
earlier. The check that exists precisely for the case where the first guard is
bypassed was itself unverified.

Fixed by adding an `alwaysAnonymous` directory mode — a misconfigured server that
resolves EVERY bind anonymously without throwing, where the password is a
perfectly ordinary non-empty string. The re-run kills the mutant with exactly
that one test.

Worth stating plainly, because it generalizes: layered defences hide each other
from mutation testing. To prove the inner layer, either disable the outer one or
find an input the outer layer lets through.

## Evidence

`__tests__/security` (whole tree) — Tests: 547 passed, 547 total, 53 suites.
node@22 (§7.9a); `API_KEY_PEPPER` at least 32 bytes (§7.1); this worktree has its
OWN `yarn install` (§7.6b — a symlink to the main checkout's `node_modules`, plus
a `yarn add` into it, briefly broke jest resolution for every other worktree).

## Not yet done

`POST /sso/ldap/login` + `inviteRateLimit` (ruling 4), the login-page input, and
`identity_providers` configuration wiring.

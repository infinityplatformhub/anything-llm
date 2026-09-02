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

## FINDING-5 + Techlead-1 NITs — deferred to slot 092000

Recon: `docs/superpowers/recon/s3-ldap-finding5.md`. Deliberately NOT in the SHA
at the gate; 092000 is its own commit on top of `17aadd2f` after the route merges.

Ruling: the `identity_providers` CHECK is SHAPE-DERIVED, with no discriminator
column — because `provider` is the UNIQUE registry key, not a type tag, and both
schema tests write random values into it (`saml-${rand}`, `ldap-${rand}`). A CHECK
on `provider = 'saml'` rejects every row the tests insert; `LIKE 'saml%'` would let
a row select its own validation rules by its own name, which is the same class of
error as reading a signed document's Subject document-wide. If this is wrong we
pin two shapes in SQL and S4's provider edits the constraint — cheap, and visible
when it happens.

Ruling: `entityId = ''` / `ssoUrl = ''` meaning "not a SAML provider" is a
DELIBERATE contract, not an accident to be cleaned up later. Under the
shape-derived CHECK the empty string is load-bearing, so 092000 carries
`COMMENT ON COLUMN` on both saying so, AND a test asserting
`is_nullable = 'NO'` from `information_schema.columns`. If this is wrong someone
later makes those columns nullable, writes NULL, and every clause of the
constraint inverts in silence — the comment is documentation and can be ignored,
so the test is the part that actually fails.

Ruling: the constraint is added WITHOUT `NOT VALID` — it validates on apply. If
this is wrong a deployment holding a half-configured row fails at migrate time
rather than carrying it forward, which is the correct direction to fail; the
table has one production row.

Ruling: six tests, not the three the finding named. If this is wrong the
constraint ships half-unproven — a CHECK reduced to `ldapUrl IS NOT NULL` passes
all three obvious tests. The mixed row must be tested from BOTH directions, one
case must insert `ldapUrl: ""` (since `IS NOT NULL` without `<> ''` survives
everything that inserts NULL, and Prisma writes empty strings happily), and the
sixth is the `is_nullable` assertion above.

Techlead-1 PASS on `17aadd2f` with 3 NITs, all deferred to 092000 by PMO:
NIT-1 adds an ip+username rate-limit bucket to `/sso/ldap/login` via the existing
`loginKey`, matching local login; NIT-2 and NIT-3 are comments recording that
`/sso/ldap/enabled` shares the bucket, and that `simpleSSOLoginDisabled`
deliberately does not gate this route.

## Evidence

`__tests__/security` (whole tree) — Tests: 547 passed, 547 total, 53 suites.
node@22 (§7.9a); `API_KEY_PEPPER` at least 32 bytes (§7.1); this worktree has its
OWN `yarn install` (§7.6b — a symlink to the main checkout's `node_modules`, plus
a `yarn add` into it, briefly broke jest resolution for every other worktree).

## Not yet done

`POST /sso/ldap/login` + `inviteRateLimit` (ruling 4), the login-page input, and
`identity_providers` configuration wiring.

## Techlead FAIL on da87ec42 — the fixtures proved the wrong thing

Techlead rejected the fixtures, and the rejection was correct. The filter matcher
special-cased a leading `(|` and otherwise required every clause, so it never
really parsed `&` — the operator every realistic base filter uses. The injection
that actually matters was therefore never exercised, and a driver concatenating
into `(&(objectClass=…)(uid=${input}))` looked safe. This is §7.9b again: a
fixture must match the shape the code actually produces.

Ruling: the mock now carries a REAL RFC 4515 parser — `&`, `|`, `!`, nesting,
substrings and hex unescaping — and the parser is itself under test, because a
parser that silently returned null would make the search tests fail for the wrong
reason while looking strict.

Ruling: the driver builds `(&(objectClass=…)(uid=…))` via `AndFilter`, because
the single-clause filter it wrote before is not what a real deployment needs and
not the shape the dangerous injection targets. `objectClass` is configurable —
directories disagree (inetOrgPerson, user, posixAccount) and a hard-coded one
matches nobody.

Ruling: every PEOPLE entry carries `objectClass`; a DN-case-variant entry
(`UID=Alice.Smith,OU=People,…`) exists so the "bind the DN the search returned"
rule is testable; and an entry with `(` and `*` in its real values proves
escaping PRESERVES a legitimate address — a control that produced false
rejections would be removed by the first operator it inconvenienced.

Ruling: DN comparison in the mock is case-insensitive, as on a real server.
Without it the mock rejected a DN it had just returned from its own search.

Ruling: anonymous READ is disabled. A search before a successful service bind is
refused, so a driver that skipped or swallowed that bind cannot fall back to
whatever the directory shows the world — usually a smaller set, so the failure
would read as "user not found".

Ruling (QA-1 G1): the transport requirement covers SEARCH as well as bind. A
driver caught sending the password in the clear must not still be able to read
the directory over the same plaintext connection.

Ruling (QA-1 G2): a referral is refused on BIND as well as on search — a real
server can refer on either, and bind is the one that authenticates.

Ruling (Techlead 4): anonymous (§5.1.1, empty DN) and unauthenticated (§5.1.2,
DN with empty password) are separate flags with separate tests. A driver can get
one right and the other wrong, and the old single flag hid that.

Ruling: a failure at the SERVICE bind is `IdentityUnavailableError`, including
result code 49. The same code means opposite things at the two binds in
`completeLogin` — our service account being wrong versus the user's password
being wrong — so classifying by code alone reports our misconfiguration as their
bad password and sends the operator hunting in the wrong place.

Ruling (NIT): `escapeDn` escapes NUL as `\00`. A raw NUL truncates the DN at
whatever C library parses it, silently binding a shorter, different DN.

### Mutation proof, re-run against the corrected fixtures

| mutant | expected kill | result |
|---|---|---|
| built filter becomes concatenated (realistic `&` shape) | the two injection tests | killed exactly those two — this is the one that previously proved nothing |
| drop the empty-password guard | the two empty-password tests | killed exactly those two |
| `length !== 1` becomes `length === 0` | the two multiple-match tests | killed exactly those two |
| drop the user-bind `authenticated !== true` check | the alwaysAnonymous test | killed exactly that one |
| drop the SERVICE-bind `authenticated !== true` check | — | **SURVIVED**, then fixed (below) |

### A second §7.9c survivor

The service-bind flag check survived for the same reason the user-bind one did in
the first round: every case that could reach it THREW, and a thrown error is
caught one layer up and reclassified — so the flag check was shadowed and never
exercised.

Fixed with a separate `serviceBindAnonymous` directory mode: a server that
resolves the service bind anonymously, with an ordinary password and no
exception. It is deliberately a SECOND flag rather than an extension of
`alwaysAnonymous`, because one flag covering both binds stops the user-bind test
at the service bind — proving only the earlier check and leaving the later one
shadowed all over again.

That is twice now in one issue. §7.9c is not a corner case: any two guards on the
same path hide each other unless a fixture reaches past the first.

## FINDING-5 + Techlead-1 NITs — deferred to slot 092000

Recon: `docs/superpowers/recon/s3-ldap-finding5.md`. Deliberately NOT in the SHA
at the gate; 092000 is its own commit on top of `17aadd2f` after the route merges.

Ruling: the `identity_providers` CHECK is SHAPE-DERIVED, with no discriminator
column — because `provider` is the UNIQUE registry key, not a type tag, and both
schema tests write random values into it (`saml-${rand}`, `ldap-${rand}`). A CHECK
on `provider = 'saml'` rejects every row the tests insert; `LIKE 'saml%'` would let
a row select its own validation rules by its own name, which is the same class of
error as reading a signed document's Subject document-wide. If this is wrong we
pin two shapes in SQL and S4's provider edits the constraint — cheap, and visible
when it happens.

Ruling: `entityId = ''` / `ssoUrl = ''` meaning "not a SAML provider" is a
DELIBERATE contract, not an accident to be cleaned up later. Under the
shape-derived CHECK the empty string is load-bearing, so 092000 carries
`COMMENT ON COLUMN` on both saying so, AND a test asserting
`is_nullable = 'NO'` from `information_schema.columns`. If this is wrong someone
later makes those columns nullable, writes NULL, and every clause of the
constraint inverts in silence — the comment is documentation and can be ignored,
so the test is the part that actually fails.

Ruling: the constraint is added WITHOUT `NOT VALID` — it validates on apply. If
this is wrong a deployment holding a half-configured row fails at migrate time
rather than carrying it forward, which is the correct direction to fail; the
table has one production row.

Ruling: six tests, not the three the finding named. If this is wrong the
constraint ships half-unproven — a CHECK reduced to `ldapUrl IS NOT NULL` passes
all three obvious tests. The mixed row must be tested from BOTH directions, one
case must insert `ldapUrl: ""` (since `IS NOT NULL` without `<> ''` survives
everything that inserts NULL, and Prisma writes empty strings happily), and the
sixth is the `is_nullable` assertion above.

Techlead-1 PASS on `17aadd2f` with 3 NITs, all deferred to 092000 by PMO:
NIT-1 adds an ip+username rate-limit bucket to `/sso/ldap/login` via the existing
`loginKey`, matching local login; NIT-2 and NIT-3 are comments recording that
`/sso/ldap/enabled` shares the bucket, and that `simpleSSOLoginDisabled`
deliberately does not gate this route.

## Evidence (after the rebuild)

`__tests__/security` — Tests: 577 passed, 577 total, 54 suites.

## Route + Login input (ruling 4)

Ruling: `POST /sso/ldap/login` lives in its own file (`endpoints/identity/ldap.js`,
the Q-1 pattern) and carries `inviteRateLimit` from the first commit. The route is
unauthenticated and every call costs a directory round trip — without a limiter it
is an unmetered password-guessing endpoint pointed at the CUSTOMER's directory,
which is worse than one pointed at us. Removing the limiter kills exactly the
ruling-4 test.

Ruling: POST only, and a test pins that GET is a 404 (§7.9 — assert the method). A
password in a query string lands in access logs, proxy logs and browser history,
none of which we control.

Ruling: `ldapIdentityEndpoints` mounts BEFORE `identityEndpoints`, the same
mount-order rule that bit S2 in `cd4fda5e`.

Ruling: S1's wildcard `/sso/:provider/login` now refuses any provider whose
`capabilities().redirect === false`. Registering LDAP made that wildcard reachable
for it, where it built a driver from OIDC-shaped configuration and returned 500.
Added `providerCapabilities()` to the registry so a route can ask what a provider
does WITHOUT constructing one — constructing it would need the very configuration
the caller is deciding whether to look up.

Ruling: plaintext `ldap://` without StartTLS is REFUSED unless `LDAP_ALLOW_INSECURE`
is set, and when it is set the mount logs an error every boot. Checked in the route
rather than the driver: it is a deployment decision, and the driver should not read
environment variables.

Ruling: the password is held in the narrowest scope that works and cleared in
`finally`. The comment says plainly that this is best effort — JS cannot wipe a
string, the engine may hold copies — because implying a guarantee the language
cannot make is worse than stating the limit.

Ruling: only `error.message` is logged, never the error object or the request body.
A client library can carry the bind credential on the error it throws, and that
line is the one that would print it.

Ruling: `GET /sso/ldap/enabled` returns ONE boolean and nothing else. The login form
must know where to post BEFORE anyone types — posting a directory password to the
local endpoint would compare it against a local hash, putting the credential
somewhere it was never meant to go. A URL, base DN or bind DN here would hand an
unauthenticated caller the shape of the internal directory; a test asserts the
response body has exactly one key.

Ruling: the frontend fails CLOSED — `System.ldapEnabled()` returns false on any
error and the state defaults to false, so a directory that is down renders the
local form rather than one posting to a disabled route.

Ruling: the password-recovery link is hidden when LDAP is on. Recovery resets a
LOCAL password; under LDAP the password lives in the directory and this
application cannot change it, so the link would send someone through a flow ending
in a reset that changes nothing they can log in with.

Ruling (NIT): `groups: []` is ALWAYS empty and the comment says so — not "not
implemented yet". Populating it before S4's consumer exists would put a claim in
front of core that nothing validates.

### Mutation proof (route round)

| mutant | expected kill | result |
|---|---|---|
| drop `inviteRateLimit` from the route | the ruling-4 test | killed exactly that one |
| zero-results gets its own message ("No such user") | the enumeration test | killed at the DRIVER (see below) |
| leak the username in R1's 409 body | — | survived; EQUIVALENT — R1's 409 already discloses that the account exists, by design. The 401 path is where silence matters, and that is covered. |

The enumeration mutant is worth recording carefully: run against the ROUTE tests
alone it survived, because the route flattens every `IdentityAuthenticationError`
to one message and cannot see a distinction the driver introduced. Run against the
driver tests it dies immediately. The lesson is the §7.9c family again — a guard
downstream of the one under test hides it, so the mutant has to be run against the
layer that owns the property.

## FINDING-5 + Techlead-1 NITs — deferred to slot 092000

Recon: `docs/superpowers/recon/s3-ldap-finding5.md`. Deliberately NOT in the SHA
at the gate; 092000 is its own commit on top of `17aadd2f` after the route merges.

Ruling: the `identity_providers` CHECK is SHAPE-DERIVED, with no discriminator
column — because `provider` is the UNIQUE registry key, not a type tag, and both
schema tests write random values into it (`saml-${rand}`, `ldap-${rand}`). A CHECK
on `provider = 'saml'` rejects every row the tests insert; `LIKE 'saml%'` would let
a row select its own validation rules by its own name, which is the same class of
error as reading a signed document's Subject document-wide. If this is wrong we
pin two shapes in SQL and S4's provider edits the constraint — cheap, and visible
when it happens.

Ruling: `entityId = ''` / `ssoUrl = ''` meaning "not a SAML provider" is a
DELIBERATE contract, not an accident to be cleaned up later. Under the
shape-derived CHECK the empty string is load-bearing, so 092000 carries
`COMMENT ON COLUMN` on both saying so, AND a test asserting
`is_nullable = 'NO'` from `information_schema.columns`. If this is wrong someone
later makes those columns nullable, writes NULL, and every clause of the
constraint inverts in silence — the comment is documentation and can be ignored,
so the test is the part that actually fails.

Ruling: the constraint is added WITHOUT `NOT VALID` — it validates on apply. If
this is wrong a deployment holding a half-configured row fails at migrate time
rather than carrying it forward, which is the correct direction to fail; the
table has one production row.

Ruling: six tests, not the three the finding named. If this is wrong the
constraint ships half-unproven — a CHECK reduced to `ldapUrl IS NOT NULL` passes
all three obvious tests. The mixed row must be tested from BOTH directions, one
case must insert `ldapUrl: ""` (since `IS NOT NULL` without `<> ''` survives
everything that inserts NULL, and Prisma writes empty strings happily), and the
sixth is the `is_nullable` assertion above.

Techlead-1 PASS on `17aadd2f` with 3 NITs, all deferred to 092000 by PMO:
NIT-1 adds an ip+username rate-limit bucket to `/sso/ldap/login` via the existing
`loginKey`, matching local login; NIT-2 and NIT-3 are comments recording that
`/sso/ldap/enabled` shares the bucket, and that `simpleSSOLoginDisabled`
deliberately does not gate this route.

## Evidence

`__tests__/security` — Tests: 595 passed, 595 total, 55 suites.

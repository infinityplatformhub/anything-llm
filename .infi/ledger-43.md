# Ledger — issue #43 · S2 Entra SAML identity provider

Branch: `approof/s2-saml` · Worktree: `.claude/worktrees/s2-saml`
Owner: Dev 3 · Scope: SAML driver + ACS route + assertion-replay store, plus the
QA-1 NIT-1 username-derivation fix that S1 left behind.

## Progress

Fixtures first (Q-4), then the library choice, then the driver. The XSW fixtures
are the SELECTION CRITERION, not a validation of a library already picked.

Ruling: XSW fixtures are written before any SAML library is chosen — a library that
accepts a wrapped assertion is disqualified regardless of popularity — because the
opposite order picks a library first and then writes tests it happens to pass; if
this is wrong we spent a day on fixtures we would have needed anyway.

Ruling: every fixture generates its signing key per run rather than embedding a
pasted assertion — a verifier that "passes" by never checking signatures cannot pass
here; if this is wrong the fixtures are slower to build and nothing else.

Ruling: the verifier must prove the assertion it READS is the assertion the signature
COVERS (compare the element ID against the signed reference ID), not merely that the
document contains a valid signature — this is what all three XSW variants exploit; if
this is wrong an attacker logs in as anyone by wrapping a genuine assertion.

## QA-1 NIT-1 — username derivation

Ruling: derivation moves into its own module `utils/identity/deriveUsername.js` shared
by every driver, rather than living inside `linkPrincipal` — if OIDC and SAML derive
usernames differently the same person over two protocols becomes two accounts, or two
people become one; if this is wrong it is one extra file.

Ruling: a local part that cannot start with a letter is PREFIXED, never trimmed — the
old rule deleted leading non-letters so `alice@`, `1alice@` and `_alice@` collapsed to
one username; if this is wrong usernames are one character longer than they need to be.

Ruling: a genuine derived-handle clash between two different mailboxes retries with an
`-sso-<hex>` suffix instead of surfacing the `users.username` P2002 — the constraint
error reaches the caller as a bare 401 against the FIRST person's account, which did
nothing wrong; if this is wrong a rare collision creates a second account instead of
refusing, which is the safer of the two failures.

## R1 order — reconciling the Techlead and PMO rulings

The Techlead's "R1 compares the derived username → 409" and the PMO's "suffix retry"
were incompatible as stated: two different mailboxes sharing a handle would be told
"an account with this email already exists", which is false, and the retry would never
run. Reported to PMO; the line below was accepted, with two added conditions.

Ruling: a derived-handle match is a takeover — and therefore R1's 409 — only when the
account it hits is LOCAL (holds no `identity_links`); an already-federated account that
merely shares a handle is a different person and falls through to the suffix retry —
because refusing them names an account that does not exist and blocks a legitimate
login; if this is wrong an SSO account can be shadowed by a second account sharing its
handle, which the email checks above still catch whenever the address matches.

Ruling (PMO condition 1): both sides of every handle comparison go through one exported
`normalizeForCompare` (NFC then lowercase), and `linkPrincipal` normalizes the incoming
address with that same function — comparing on anything else means `User+X@` and
`user+x@` are two handles for one mailbox and the collision rule silently stops firing;
if this is wrong we normalize slightly more than strictly needed.

Ruling (PMO condition 2): the checks run in a FIXED order — (1a) email already in
`identity_links`, (1b) local account under the raw address, then (2) derived handle.
The handle rule must not shadow the email rule: reversed, an account federated to a
DIFFERENT provider under the same address looks like "someone else sharing a handle"
and the retry quietly creates a second account for one mailbox; if this is wrong the
same address federated twice is refused where it might have been linkable, which is
R1's intended answer anyway.


## Techlead FINDING-1 (medium) — the read scope after the ID match

FINDING-1 was real and reproduced RED before the fix: the harness verified the right
assertion and then read `//saml:Subject` document-wide, so a forged `<saml:Subject>`
loose in `<samlp:Extensions>` was returned as the vouched-for NameID. It passed every
existing guard — one signature, one assertion, and the assertion read WAS the one
signed — because a bare Subject is not an Assertion.

Ruling: after the ID match, `doc` is off limits — every subsequent read (NameID,
Conditions, AudienceRestriction, SubjectConfirmationData/@InResponseTo,
AttributeStatement) is anchored at the verified `assertions[0]` with `./`, never `//`
against the document; if this is wrong we pay one extra variable and nothing else,
whereas the other way an attacker logs in as anyone.

Ruling: the verifier's key comes from configuration ONLY — never from the assertion's
own `KeyInfo`/`X509Certificate`, even when the document verifies against it — because
a self-signed assertion carrying its own certificate is internally consistent and
anyone can generate a keypair; if this is wrong an operator must configure the
certificate by hand, which is the intended cost.

Ruling: `identity_assertion_ids` claims by INSERT against the unique constraint, never
read-then-write — two simultaneous presentations both read "not seen" and both get in,
and a replay sent twice at once is not a hard attack to mount; if this is wrong we
catch a P2002 we could have avoided asking about.

Ruling (NIT-2): exhausting all five username candidates raises `IdentityUnavailableError`
(retryable), not `IdentityConflictError` — five random 4-byte collisions is the database
misbehaving, not "this identity belongs to someone else, an admin must resolve it"; if
this is wrong a caller retries a login that was never going to succeed.

Ruling (NIT-1): the `identity_links.email` NFC backfill ships in slot `082000` alongside
the tables, not a new slot — the normalization and the data it assumes must land
together, or a row written in decomposed form silently misses the R1 email check; PG16
in the test stack was verified to have `normalize()` before relying on it.

Ruling: the STORE side deliberately does not normalize, and the reason is written at
`normalizeForCompare` — it is load-bearing on `users.username` being constrained to
`^[a-z][a-z0-9._@-]*$` plus Prisma's insensitive compare. Widen that regex and the store
side must normalize too.

#
## SamlIdentityProvider

Ruling: the ACS/driver order is verify signature → ID-match → conditions/audience/
InResponseTo → **claim** → (route) linkPrincipal, and `expiresAt` for the claim is the
`NotOnOrAfter` read from the verified node — claiming any earlier turns a leaked
assertion ID into a DoS primitive: an ID is not a secret (logs, proxies, browser
history), so anyone who learns one could pre-register it with XML that never verified
and the victim's genuine login is refused as a replay; if this is wrong we do slightly
more parsing before the first write.

Ruling: every read from a verified assertion goes through `readFromAssertion` /
`readStringFromAssertion`, which close over no document — a document-wide read is not
expressible by a caller rather than merely discouraged; if this is wrong it is one
indirection with no runtime cost.

Ruling: each of DoD 4/5/6/8 gets an `xswUnwrappedSubject`-shaped sibling — a planted
`Conditions`, `AudienceRestriction` and `SubjectConfirmationData` — because NameID was
never the only forgeable read and a guard proven on one field says nothing about the
others; if this is wrong we carry three fixtures that never fire.

Ruling: the driver tries EVERY configured certificate, not the first — an IdP publishes
its next certificate before it signs with it, so first-only means every login fails
between an Entra rotation and someone noticing; if this is wrong we do at most N
signature checks on a failing login.

Ruling: a driver built with an empty certificate list throws at construction — "no
certificate configured" must never read as "accept anything"; if this is wrong an
operator sees an error instead of a silently unsafe provider.

Ruling (NOTE-A): `identity_providers.id` carries `DEFAULT gen_random_uuid()::text` in
SQL, because Prisma's `@default(uuid())` is generated CLIENT-side and any other writer
(psql, a repair script, a later migration) would hit a NOT NULL with no default.

Ruling (NOTE-B/C): the NFC backfill states `requires PG13+` in a comment (stack is PG16,
verified by querying it) and carries `WHERE email <> normalize(email, NFC)` so a
re-run is a no-op rather than a full-table rewrite. No `DO` block.

#
## ACS route (Q-1) — and a mount-order defect the HTTP test caught

Ruling: `/sso/saml/login` and `/sso/saml/acs` live in `endpoints/identity/saml.js`, with
`inviteRateLimit` on BOTH from the first commit (Q-1) — the ACS route is unauthenticated
and every call costs an XML parse plus signature verification before it can be refused,
which is a free CPU sink; if this is wrong an operator raises a limit.

Ruling: the ACS route closes ruling 3's second half — the driver verifies AND claims
before `linkPrincipal` is called, so a forged or replayed assertion never reaches the
code that creates or modifies a user.

Ruling: `samlIdentityEndpoints` is mounted BEFORE `identityEndpoints` in `index.js`.
S1 registers the wildcard `/sso/:provider/login` and Express matches in registration
order, so mounted the other way the wildcard swallows `/sso/saml/login` and hands SAML's
provider id to a config builder that only produces OIDC settings — a 500 on every SAML
login. Found by the HTTP test on its first run, not by reading; a unit test of the
handler would have passed while the route was unreachable. Restoring the original order
fails 8 of 9 route tests.

#
## Techlead round 3 — Recipient, Issuer, Status

Ruling: `SubjectConfirmationData/@Recipient` is checked against our ACS URL before the
claim, read through `readFromAssertion` from INSIDE the signature. `Response/@Destination`
sits outside the signature — usable for a fast refusal, never for a decision. Recipient
is a THIRD axis: an assertion can name us as audience and be perfectly in date yet have
been aimed at another endpoint (intercepted in transit to another SP, or an IdP induced
to deliver elsewhere); if this is wrong a misconfigured IdP is refused until its
Recipient matches, which is the correct answer anyway.

Ruling: `Assertion/Issuer` is checked against `idpEntityId` before the claim — "some
trusted key signed this" is not enough, because a trust list holds several certificates
during a rotation and a deployment may configure more than one provider, so without it
any IdP whose certificate we hold could mint assertions in another's name.

Ruling (NIT-1): when a Response carries no assertion, `samlp:StatusCode` goes to the LOG
and never to the response — it usually means the IdP refused (disabled account, declined
MFA, unknown user), which an operator needs and an attacker would read as an account
oracle.

Ruling (NIT-2): `_checkConditions` and `_checkAudience` each carry a comment saying they
carry weight for each other — conditions bound WHEN, audience bounds WHERE, recipient
bounds WHERE-DELIVERED — so a reviewer cannot remove "the duplicate" without opening one
of three distinct holes.

Ruling: the ACS URL comes from `SSO_ACS_URL` (or `SSO_CALLBACK_BASE_URL`), NOT from the
request's `Host` header. Since that value is what the signed Recipient is compared
against, deriving it from a caller-controlled header would make the check agree with the
attacker rather than with the IdP's configuration. The Host fallback remains only for a
deployment that has configured neither, where the check degrades to "matches whatever
host this request claimed" — no worse than absent, and no better.

This was found by the full-tree run, not by reading: adding the Recipient check turned 4
route tests red, because the HTTP suite reached the ACS through supertest's own host.
The tests were right and the route was wrong.

### Mutation proof (round 3)

| mutant | expected kill | result |
|---|---|---|
| remove `_checkIssuer` | the two wrong-issuer tests | killed exactly those two |
| remove `_checkRecipient` | the two wrong-recipient tests | killed exactly those two |

## Mutation proof (ACS round)

| mutant | expected kill | result |
|---|---|---|
| mount `identityEndpoints` first again | the route tests | 8 of 9 failed |
| drop `inviteRateLimit` from the ACS route | the Q-1 rate-limit test | killed exactly that one |

The rate-limit test sets `INVITE_RATE_LIMIT_MAX=5` for the suite. The limit VALUE is
configuration; what the test pins is that a limiter is mounted at all, which is the part
a refactor can silently drop.


## Techlead round 3 — Recipient, Issuer, Status

Ruling: `SubjectConfirmationData/@Recipient` is checked against our ACS URL before the
claim, read through `readFromAssertion` from INSIDE the signature. `Response/@Destination`
sits outside the signature — usable for a fast refusal, never for a decision. Recipient
is a THIRD axis: an assertion can name us as audience and be perfectly in date yet have
been aimed at another endpoint (intercepted in transit to another SP, or an IdP induced
to deliver elsewhere); if this is wrong a misconfigured IdP is refused until its
Recipient matches, which is the correct answer anyway.

Ruling: `Assertion/Issuer` is checked against `idpEntityId` before the claim — "some
trusted key signed this" is not enough, because a trust list holds several certificates
during a rotation and a deployment may configure more than one provider, so without it
any IdP whose certificate we hold could mint assertions in another's name.

Ruling (NIT-1): when a Response carries no assertion, `samlp:StatusCode` goes to the LOG
and never to the response — it usually means the IdP refused (disabled account, declined
MFA, unknown user), which an operator needs and an attacker would read as an account
oracle.

Ruling (NIT-2): `_checkConditions` and `_checkAudience` each carry a comment saying they
carry weight for each other — conditions bound WHEN, audience bounds WHERE, recipient
bounds WHERE-DELIVERED — so a reviewer cannot remove "the duplicate" without opening one
of three distinct holes.

Ruling: the ACS URL comes from `SSO_ACS_URL` (or `SSO_CALLBACK_BASE_URL`), NOT from the
request's `Host` header. Since that value is what the signed Recipient is compared
against, deriving it from a caller-controlled header would make the check agree with the
attacker rather than with the IdP's configuration. The Host fallback remains only for a
deployment that has configured neither, where the check degrades to "matches whatever
host this request claimed" — no worse than absent, and no better.

This was found by the full-tree run, not by reading: adding the Recipient check turned 4
route tests red, because the HTTP suite reached the ACS through supertest's own host.
The tests were right and the route was wrong.

### Mutation proof (round 3)

| mutant | expected kill | result |
|---|---|---|
| remove `_checkIssuer` | the two wrong-issuer tests | killed exactly those two |
| remove `_checkRecipient` | the two wrong-recipient tests | killed exactly those two |

## Mutation proof (driver round)

| mutant | expected kill | result |
|---|---|---|
| `claim` hoisted to the top of `completeLogin` | the three "records nothing" tests | killed exactly those three |
| `readFromAssertion` reads document-wide instead of `./` | FINDING-1 + the three planted-element tests | killed exactly those four |

The second mutant is why the planted-element fixtures were reshaped mid-flight: as first
written, two of them planted a BARE `AudienceRestriction` / `SubjectConfirmationData`,
which the driver's read path cannot reach even document-wide — so they passed against
the unsafe mutant and proved nothing. They now plant a full `Conditions` / `Subject`,
matching the path shape actually read, and all four die under the mutant.


## ACS route (Q-1) — and a mount-order defect the HTTP test caught

Ruling: `/sso/saml/login` and `/sso/saml/acs` live in `endpoints/identity/saml.js`, with
`inviteRateLimit` on BOTH from the first commit (Q-1) — the ACS route is unauthenticated
and every call costs an XML parse plus signature verification before it can be refused,
which is a free CPU sink; if this is wrong an operator raises a limit.

Ruling: the ACS route closes ruling 3's second half — the driver verifies AND claims
before `linkPrincipal` is called, so a forged or replayed assertion never reaches the
code that creates or modifies a user.

Ruling: `samlIdentityEndpoints` is mounted BEFORE `identityEndpoints` in `index.js`.
S1 registers the wildcard `/sso/:provider/login` and Express matches in registration
order, so mounted the other way the wildcard swallows `/sso/saml/login` and hands SAML's
provider id to a config builder that only produces OIDC settings — a 500 on every SAML
login. Found by the HTTP test on its first run, not by reading; a unit test of the
handler would have passed while the route was unreachable. Restoring the original order
fails 8 of 9 route tests.

#
## Techlead round 3 — Recipient, Issuer, Status

Ruling: `SubjectConfirmationData/@Recipient` is checked against our ACS URL before the
claim, read through `readFromAssertion` from INSIDE the signature. `Response/@Destination`
sits outside the signature — usable for a fast refusal, never for a decision. Recipient
is a THIRD axis: an assertion can name us as audience and be perfectly in date yet have
been aimed at another endpoint (intercepted in transit to another SP, or an IdP induced
to deliver elsewhere); if this is wrong a misconfigured IdP is refused until its
Recipient matches, which is the correct answer anyway.

Ruling: `Assertion/Issuer` is checked against `idpEntityId` before the claim — "some
trusted key signed this" is not enough, because a trust list holds several certificates
during a rotation and a deployment may configure more than one provider, so without it
any IdP whose certificate we hold could mint assertions in another's name.

Ruling (NIT-1): when a Response carries no assertion, `samlp:StatusCode` goes to the LOG
and never to the response — it usually means the IdP refused (disabled account, declined
MFA, unknown user), which an operator needs and an attacker would read as an account
oracle.

Ruling (NIT-2): `_checkConditions` and `_checkAudience` each carry a comment saying they
carry weight for each other — conditions bound WHEN, audience bounds WHERE, recipient
bounds WHERE-DELIVERED — so a reviewer cannot remove "the duplicate" without opening one
of three distinct holes.

Ruling: the ACS URL comes from `SSO_ACS_URL` (or `SSO_CALLBACK_BASE_URL`), NOT from the
request's `Host` header. Since that value is what the signed Recipient is compared
against, deriving it from a caller-controlled header would make the check agree with the
attacker rather than with the IdP's configuration. The Host fallback remains only for a
deployment that has configured neither, where the check degrades to "matches whatever
host this request claimed" — no worse than absent, and no better.

This was found by the full-tree run, not by reading: adding the Recipient check turned 4
route tests red, because the HTTP suite reached the ACS through supertest's own host.
The tests were right and the route was wrong.

### Mutation proof (round 3)

| mutant | expected kill | result |
|---|---|---|
| remove `_checkIssuer` | the two wrong-issuer tests | killed exactly those two |
| remove `_checkRecipient` | the two wrong-recipient tests | killed exactly those two |

## Mutation proof (ACS round)

| mutant | expected kill | result |
|---|---|---|
| mount `identityEndpoints` first again | the route tests | 8 of 9 failed |
| drop `inviteRateLimit` from the ACS route | the Q-1 rate-limit test | killed exactly that one |

The rate-limit test sets `INVITE_RATE_LIMIT_MAX=5` for the suite. The limit VALUE is
configuration; what the test pins is that a limiter is mounted at all, which is the part
a refactor can silently drop.


## Techlead round 3 — Recipient, Issuer, Status

Ruling: `SubjectConfirmationData/@Recipient` is checked against our ACS URL before the
claim, read through `readFromAssertion` from INSIDE the signature. `Response/@Destination`
sits outside the signature — usable for a fast refusal, never for a decision. Recipient
is a THIRD axis: an assertion can name us as audience and be perfectly in date yet have
been aimed at another endpoint (intercepted in transit to another SP, or an IdP induced
to deliver elsewhere); if this is wrong a misconfigured IdP is refused until its
Recipient matches, which is the correct answer anyway.

Ruling: `Assertion/Issuer` is checked against `idpEntityId` before the claim — "some
trusted key signed this" is not enough, because a trust list holds several certificates
during a rotation and a deployment may configure more than one provider, so without it
any IdP whose certificate we hold could mint assertions in another's name.

Ruling (NIT-1): when a Response carries no assertion, `samlp:StatusCode` goes to the LOG
and never to the response — it usually means the IdP refused (disabled account, declined
MFA, unknown user), which an operator needs and an attacker would read as an account
oracle.

Ruling (NIT-2): `_checkConditions` and `_checkAudience` each carry a comment saying they
carry weight for each other — conditions bound WHEN, audience bounds WHERE, recipient
bounds WHERE-DELIVERED — so a reviewer cannot remove "the duplicate" without opening one
of three distinct holes.

Ruling: the ACS URL comes from `SSO_ACS_URL` (or `SSO_CALLBACK_BASE_URL`), NOT from the
request's `Host` header. Since that value is what the signed Recipient is compared
against, deriving it from a caller-controlled header would make the check agree with the
attacker rather than with the IdP's configuration. The Host fallback remains only for a
deployment that has configured neither, where the check degrades to "matches whatever
host this request claimed" — no worse than absent, and no better.

This was found by the full-tree run, not by reading: adding the Recipient check turned 4
route tests red, because the HTTP suite reached the ACS through supertest's own host.
The tests were right and the route was wrong.

### Mutation proof (round 3)

| mutant | expected kill | result |
|---|---|---|
| remove `_checkIssuer` | the two wrong-issuer tests | killed exactly those two |
| remove `_checkRecipient` | the two wrong-recipient tests | killed exactly those two |

## Mutation proof (FINDING-1 round)

| mutant | expected kill | result |
|---|---|---|
| `//saml:Subject` against `doc` instead of `./` at `assertions[0]` | DoD 3d | killed exactly that one; vouched `attacker@example.com` |
| drop the UNIQUE from the assertion-ID index | replay + schema tests | killed 4, all of them replay-related |
| read-then-write claim | (survived — the DB constraint still holds) documented, not a gap |
| NIT-2 back to `IdentityConflictError` | the NIT-2 test | killed exactly that one |


## SamlIdentityProvider

Ruling: the ACS/driver order is verify signature → ID-match → conditions/audience/
InResponseTo → **claim** → (route) linkPrincipal, and `expiresAt` for the claim is the
`NotOnOrAfter` read from the verified node — claiming any earlier turns a leaked
assertion ID into a DoS primitive: an ID is not a secret (logs, proxies, browser
history), so anyone who learns one could pre-register it with XML that never verified
and the victim's genuine login is refused as a replay; if this is wrong we do slightly
more parsing before the first write.

Ruling: every read from a verified assertion goes through `readFromAssertion` /
`readStringFromAssertion`, which close over no document — a document-wide read is not
expressible by a caller rather than merely discouraged; if this is wrong it is one
indirection with no runtime cost.

Ruling: each of DoD 4/5/6/8 gets an `xswUnwrappedSubject`-shaped sibling — a planted
`Conditions`, `AudienceRestriction` and `SubjectConfirmationData` — because NameID was
never the only forgeable read and a guard proven on one field says nothing about the
others; if this is wrong we carry three fixtures that never fire.

Ruling: the driver tries EVERY configured certificate, not the first — an IdP publishes
its next certificate before it signs with it, so first-only means every login fails
between an Entra rotation and someone noticing; if this is wrong we do at most N
signature checks on a failing login.

Ruling: a driver built with an empty certificate list throws at construction — "no
certificate configured" must never read as "accept anything"; if this is wrong an
operator sees an error instead of a silently unsafe provider.

Ruling (NOTE-A): `identity_providers.id` carries `DEFAULT gen_random_uuid()::text` in
SQL, because Prisma's `@default(uuid())` is generated CLIENT-side and any other writer
(psql, a repair script, a later migration) would hit a NOT NULL with no default.

Ruling (NOTE-B/C): the NFC backfill states `requires PG13+` in a comment (stack is PG16,
verified by querying it) and carries `WHERE email <> normalize(email, NFC)` so a
re-run is a no-op rather than a full-table rewrite. No `DO` block.

#
## ACS route (Q-1) — and a mount-order defect the HTTP test caught

Ruling: `/sso/saml/login` and `/sso/saml/acs` live in `endpoints/identity/saml.js`, with
`inviteRateLimit` on BOTH from the first commit (Q-1) — the ACS route is unauthenticated
and every call costs an XML parse plus signature verification before it can be refused,
which is a free CPU sink; if this is wrong an operator raises a limit.

Ruling: the ACS route closes ruling 3's second half — the driver verifies AND claims
before `linkPrincipal` is called, so a forged or replayed assertion never reaches the
code that creates or modifies a user.

Ruling: `samlIdentityEndpoints` is mounted BEFORE `identityEndpoints` in `index.js`.
S1 registers the wildcard `/sso/:provider/login` and Express matches in registration
order, so mounted the other way the wildcard swallows `/sso/saml/login` and hands SAML's
provider id to a config builder that only produces OIDC settings — a 500 on every SAML
login. Found by the HTTP test on its first run, not by reading; a unit test of the
handler would have passed while the route was unreachable. Restoring the original order
fails 8 of 9 route tests.

#
## Techlead round 3 — Recipient, Issuer, Status

Ruling: `SubjectConfirmationData/@Recipient` is checked against our ACS URL before the
claim, read through `readFromAssertion` from INSIDE the signature. `Response/@Destination`
sits outside the signature — usable for a fast refusal, never for a decision. Recipient
is a THIRD axis: an assertion can name us as audience and be perfectly in date yet have
been aimed at another endpoint (intercepted in transit to another SP, or an IdP induced
to deliver elsewhere); if this is wrong a misconfigured IdP is refused until its
Recipient matches, which is the correct answer anyway.

Ruling: `Assertion/Issuer` is checked against `idpEntityId` before the claim — "some
trusted key signed this" is not enough, because a trust list holds several certificates
during a rotation and a deployment may configure more than one provider, so without it
any IdP whose certificate we hold could mint assertions in another's name.

Ruling (NIT-1): when a Response carries no assertion, `samlp:StatusCode` goes to the LOG
and never to the response — it usually means the IdP refused (disabled account, declined
MFA, unknown user), which an operator needs and an attacker would read as an account
oracle.

Ruling (NIT-2): `_checkConditions` and `_checkAudience` each carry a comment saying they
carry weight for each other — conditions bound WHEN, audience bounds WHERE, recipient
bounds WHERE-DELIVERED — so a reviewer cannot remove "the duplicate" without opening one
of three distinct holes.

Ruling: the ACS URL comes from `SSO_ACS_URL` (or `SSO_CALLBACK_BASE_URL`), NOT from the
request's `Host` header. Since that value is what the signed Recipient is compared
against, deriving it from a caller-controlled header would make the check agree with the
attacker rather than with the IdP's configuration. The Host fallback remains only for a
deployment that has configured neither, where the check degrades to "matches whatever
host this request claimed" — no worse than absent, and no better.

This was found by the full-tree run, not by reading: adding the Recipient check turned 4
route tests red, because the HTTP suite reached the ACS through supertest's own host.
The tests were right and the route was wrong.

### Mutation proof (round 3)

| mutant | expected kill | result |
|---|---|---|
| remove `_checkIssuer` | the two wrong-issuer tests | killed exactly those two |
| remove `_checkRecipient` | the two wrong-recipient tests | killed exactly those two |

## Mutation proof (ACS round)

| mutant | expected kill | result |
|---|---|---|
| mount `identityEndpoints` first again | the route tests | 8 of 9 failed |
| drop `inviteRateLimit` from the ACS route | the Q-1 rate-limit test | killed exactly that one |

The rate-limit test sets `INVITE_RATE_LIMIT_MAX=5` for the suite. The limit VALUE is
configuration; what the test pins is that a limiter is mounted at all, which is the part
a refactor can silently drop.


## Techlead round 3 — Recipient, Issuer, Status

Ruling: `SubjectConfirmationData/@Recipient` is checked against our ACS URL before the
claim, read through `readFromAssertion` from INSIDE the signature. `Response/@Destination`
sits outside the signature — usable for a fast refusal, never for a decision. Recipient
is a THIRD axis: an assertion can name us as audience and be perfectly in date yet have
been aimed at another endpoint (intercepted in transit to another SP, or an IdP induced
to deliver elsewhere); if this is wrong a misconfigured IdP is refused until its
Recipient matches, which is the correct answer anyway.

Ruling: `Assertion/Issuer` is checked against `idpEntityId` before the claim — "some
trusted key signed this" is not enough, because a trust list holds several certificates
during a rotation and a deployment may configure more than one provider, so without it
any IdP whose certificate we hold could mint assertions in another's name.

Ruling (NIT-1): when a Response carries no assertion, `samlp:StatusCode` goes to the LOG
and never to the response — it usually means the IdP refused (disabled account, declined
MFA, unknown user), which an operator needs and an attacker would read as an account
oracle.

Ruling (NIT-2): `_checkConditions` and `_checkAudience` each carry a comment saying they
carry weight for each other — conditions bound WHEN, audience bounds WHERE, recipient
bounds WHERE-DELIVERED — so a reviewer cannot remove "the duplicate" without opening one
of three distinct holes.

Ruling: the ACS URL comes from `SSO_ACS_URL` (or `SSO_CALLBACK_BASE_URL`), NOT from the
request's `Host` header. Since that value is what the signed Recipient is compared
against, deriving it from a caller-controlled header would make the check agree with the
attacker rather than with the IdP's configuration. The Host fallback remains only for a
deployment that has configured neither, where the check degrades to "matches whatever
host this request claimed" — no worse than absent, and no better.

This was found by the full-tree run, not by reading: adding the Recipient check turned 4
route tests red, because the HTTP suite reached the ACS through supertest's own host.
The tests were right and the route was wrong.

### Mutation proof (round 3)

| mutant | expected kill | result |
|---|---|---|
| remove `_checkIssuer` | the two wrong-issuer tests | killed exactly those two |
| remove `_checkRecipient` | the two wrong-recipient tests | killed exactly those two |

## Mutation proof (driver round)

| mutant | expected kill | result |
|---|---|---|
| `claim` hoisted to the top of `completeLogin` | the three "records nothing" tests | killed exactly those three |
| `readFromAssertion` reads document-wide instead of `./` | FINDING-1 + the three planted-element tests | killed exactly those four |

The second mutant is why the planted-element fixtures were reshaped mid-flight: as first
written, two of them planted a BARE `AudienceRestriction` / `SubjectConfirmationData`,
which the driver's read path cannot reach even document-wide — so they passed against
the unsafe mutant and proved nothing. They now plant a full `Conditions` / `Subject`,
matching the path shape actually read, and all four die under the mutant.


## ACS route (Q-1) — and a mount-order defect the HTTP test caught

Ruling: `/sso/saml/login` and `/sso/saml/acs` live in `endpoints/identity/saml.js`, with
`inviteRateLimit` on BOTH from the first commit (Q-1) — the ACS route is unauthenticated
and every call costs an XML parse plus signature verification before it can be refused,
which is a free CPU sink; if this is wrong an operator raises a limit.

Ruling: the ACS route closes ruling 3's second half — the driver verifies AND claims
before `linkPrincipal` is called, so a forged or replayed assertion never reaches the
code that creates or modifies a user.

Ruling: `samlIdentityEndpoints` is mounted BEFORE `identityEndpoints` in `index.js`.
S1 registers the wildcard `/sso/:provider/login` and Express matches in registration
order, so mounted the other way the wildcard swallows `/sso/saml/login` and hands SAML's
provider id to a config builder that only produces OIDC settings — a 500 on every SAML
login. Found by the HTTP test on its first run, not by reading; a unit test of the
handler would have passed while the route was unreachable. Restoring the original order
fails 8 of 9 route tests.

#
## Techlead round 3 — Recipient, Issuer, Status

Ruling: `SubjectConfirmationData/@Recipient` is checked against our ACS URL before the
claim, read through `readFromAssertion` from INSIDE the signature. `Response/@Destination`
sits outside the signature — usable for a fast refusal, never for a decision. Recipient
is a THIRD axis: an assertion can name us as audience and be perfectly in date yet have
been aimed at another endpoint (intercepted in transit to another SP, or an IdP induced
to deliver elsewhere); if this is wrong a misconfigured IdP is refused until its
Recipient matches, which is the correct answer anyway.

Ruling: `Assertion/Issuer` is checked against `idpEntityId` before the claim — "some
trusted key signed this" is not enough, because a trust list holds several certificates
during a rotation and a deployment may configure more than one provider, so without it
any IdP whose certificate we hold could mint assertions in another's name.

Ruling (NIT-1): when a Response carries no assertion, `samlp:StatusCode` goes to the LOG
and never to the response — it usually means the IdP refused (disabled account, declined
MFA, unknown user), which an operator needs and an attacker would read as an account
oracle.

Ruling (NIT-2): `_checkConditions` and `_checkAudience` each carry a comment saying they
carry weight for each other — conditions bound WHEN, audience bounds WHERE, recipient
bounds WHERE-DELIVERED — so a reviewer cannot remove "the duplicate" without opening one
of three distinct holes.

Ruling: the ACS URL comes from `SSO_ACS_URL` (or `SSO_CALLBACK_BASE_URL`), NOT from the
request's `Host` header. Since that value is what the signed Recipient is compared
against, deriving it from a caller-controlled header would make the check agree with the
attacker rather than with the IdP's configuration. The Host fallback remains only for a
deployment that has configured neither, where the check degrades to "matches whatever
host this request claimed" — no worse than absent, and no better.

This was found by the full-tree run, not by reading: adding the Recipient check turned 4
route tests red, because the HTTP suite reached the ACS through supertest's own host.
The tests were right and the route was wrong.

### Mutation proof (round 3)

| mutant | expected kill | result |
|---|---|---|
| remove `_checkIssuer` | the two wrong-issuer tests | killed exactly those two |
| remove `_checkRecipient` | the two wrong-recipient tests | killed exactly those two |

## Mutation proof (ACS round)

| mutant | expected kill | result |
|---|---|---|
| mount `identityEndpoints` first again | the route tests | 8 of 9 failed |
| drop `inviteRateLimit` from the ACS route | the Q-1 rate-limit test | killed exactly that one |

The rate-limit test sets `INVITE_RATE_LIMIT_MAX=5` for the suite. The limit VALUE is
configuration; what the test pins is that a limiter is mounted at all, which is the part
a refactor can silently drop.


## Techlead round 3 — Recipient, Issuer, Status

Ruling: `SubjectConfirmationData/@Recipient` is checked against our ACS URL before the
claim, read through `readFromAssertion` from INSIDE the signature. `Response/@Destination`
sits outside the signature — usable for a fast refusal, never for a decision. Recipient
is a THIRD axis: an assertion can name us as audience and be perfectly in date yet have
been aimed at another endpoint (intercepted in transit to another SP, or an IdP induced
to deliver elsewhere); if this is wrong a misconfigured IdP is refused until its
Recipient matches, which is the correct answer anyway.

Ruling: `Assertion/Issuer` is checked against `idpEntityId` before the claim — "some
trusted key signed this" is not enough, because a trust list holds several certificates
during a rotation and a deployment may configure more than one provider, so without it
any IdP whose certificate we hold could mint assertions in another's name.

Ruling (NIT-1): when a Response carries no assertion, `samlp:StatusCode` goes to the LOG
and never to the response — it usually means the IdP refused (disabled account, declined
MFA, unknown user), which an operator needs and an attacker would read as an account
oracle.

Ruling (NIT-2): `_checkConditions` and `_checkAudience` each carry a comment saying they
carry weight for each other — conditions bound WHEN, audience bounds WHERE, recipient
bounds WHERE-DELIVERED — so a reviewer cannot remove "the duplicate" without opening one
of three distinct holes.

Ruling: the ACS URL comes from `SSO_ACS_URL` (or `SSO_CALLBACK_BASE_URL`), NOT from the
request's `Host` header. Since that value is what the signed Recipient is compared
against, deriving it from a caller-controlled header would make the check agree with the
attacker rather than with the IdP's configuration. The Host fallback remains only for a
deployment that has configured neither, where the check degrades to "matches whatever
host this request claimed" — no worse than absent, and no better.

This was found by the full-tree run, not by reading: adding the Recipient check turned 4
route tests red, because the HTTP suite reached the ACS through supertest's own host.
The tests were right and the route was wrong.

### Mutation proof (round 3)

| mutant | expected kill | result |
|---|---|---|
| remove `_checkIssuer` | the two wrong-issuer tests | killed exactly those two |
| remove `_checkRecipient` | the two wrong-recipient tests | killed exactly those two |

## Mutation proof

| mutant | expected kill | result |
|---|---|---|
| `normalizeForCompare` drops `.normalize("NFC")` | the two normalization tests | killed both, only those |
| the (1a) email-link check moved AFTER the handle check | "PMO ruling 2: an email already linked to ANOTHER provider stays under R1" | killed exactly that one |
| naive verifier: valid signature anywhere + read first assertion | the three XSW tests | killed exactly those three |

## Evidence

`__tests__/security` (whole tree) — Tests: 361 passed, 361 total, 37 suites, against real
Postgres via `prisma migrate deploy` (§7.1a, never `db push`).

Two environment traps, both of which produce failures that look like broken code:
`API_KEY_PEPPER` must be at least 32 BYTES — a shorter one fails 8 authorization suites
at import with a message about the pepper, not about the test. And jest must run under
node@22. Under the default node 26
`jsonwebtoken` throws at import and three suites fail to LOAD — which jest reports as
suite-level failures while the test count still reads green, so "58 passed" appeared
next to three broken suites.

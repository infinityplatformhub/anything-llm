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

## Mutation proof

| mutant | expected kill | result |
|---|---|---|
| `normalizeForCompare` drops `.normalize("NFC")` | the two normalization tests | killed both, only those |
| the (1a) email-link check moved AFTER the handle check | "PMO ruling 2: an email already linked to ANOTHER provider stays under R1" | killed exactly that one |
| naive verifier: valid signature anywhere + read first assertion | the three XSW tests | killed exactly those three |

## Evidence

`__tests__/security/identity` — Tests: 101 passed, 101 total (10 suites), against real
Postgres via `prisma migrate deploy`.

# Techlead review — #43 `dab75e1a` (diff from `79448c01`)

**Verdict: PASS.** FINDING-1 is closed correctly and generalized rather than patched.
NIT-1 and NIT-2 both closed. Three notes below, none blocking; one (NOTE-A) needs a
decision before the driver lands, not a code change now.

Static review — `xml-crypto`/`xpath`/`@xmldom/xmldom` are still absent from this checkout's
`server/node_modules`, so the 128 suite was not re-run here.

---

## FINDING-1 — closed

`samlLibraryEvaluation.test.js:79`:

```js
const nameId = select("string(./saml:Subject/saml:NameID/text())", assertions[0]);
```

`./` anchored at the verified assertion node, which is the fix I asked for. What makes this
a close rather than a patch is that the rule is stated where the next person will hit it —
*"past this point `doc` is off limits"* — and it names the other four fields (Conditions,
AudienceRestriction, InResponseTo, AttributeStatement) that inherit it.

`xswUnwrappedSubject` is the fixture I described, built correctly: a bare
`<saml:Subject>` in `<samlp:Extensions>` ahead of the genuinely signed assertion, with its
own namespace declaration so it parses standalone. It passes all three assertion-level
guards — one signature, one assertion, and the assertion read *is* the one signed — so it
isolates exactly the document-order read and nothing else.

The DoD 3d assertion is the interesting one and it is right:

```js
expect(vouched).not.toBe(forgedNameId);
expect(vouched).toBe("person@example.com");
```

Unlike 3a/3b/3c, `null` would be the *wrong* expectation here — the signed assertion is
intact and legitimate, so vouching for its NameID is the correct outcome. Asserting the
positive rather than "not the forged one" is what makes this test fail if the read is ever
scoped to the wrong element in the other direction.

Mutation (`//` + `doc`) kills it, per the ledger. I did not re-run it; the reasoning is
checkable from the fixture and holds.

## DoD 2b — the KeyInfo trust question, answered

I raised this as a thing to decide, not a defect; it came back as a two-sided test, which is
better than a decision recorded in prose.

`selfSignedWithKeyInfo` builds a document that is *internally consistent* — attacker keypair,
attacker certificate in `KeyInfo`, signature valid against it. The test asserts both
directions:

- against the configured key → throws;
- against `attackerPublicKeyPem` → returns `person@example.com`.

The second assertion is the one that matters. Without it the test could pass on malformed
XML; with it, the fixture is proven to be a *working* forgery, which is exactly why reading
the key from `KeyInfo` is fatal. This is the SAML analogue of the OIDC `alg` header rule and
it now has the same shape of proof.

## NIT-1 (NFC backfill) — closed

`UPDATE "identity_links" SET "email" = normalize("email", NFC);` in slot `082000`. Correct
placement — the constraint and the data it depends on land in one migration — and correct
statement. See NOTE-B for the one caveat.

## NIT-2 (`IdentityUnavailableError`) — closed

`linkPrincipal.js:181`. The reasoning in the comment is the right reasoning: five 4-byte
suffix collisions in a row is not a conflict, and `retryable` is a property of the failure
rather than the caller's guess. Message changed to "Please try again", consistent with the
class.

---

## The two things PMO asked to check

### (a) Is EVERY post-ID-match read relative to the assertion, or only NameID?

**In this commit, yes — because NameID is the only read that exists.** `verifyAndExtract`
returns after it; nothing reads Conditions, Audience, or InResponseTo yet.

So the answer for `dab75e1a` is trivially yes, and the answer that matters is about what
comes next. The rule is now written in two places (the code comment and the fixture
docblock) and has a RED behind it, which is the strongest form available before the driver
exists. What it does not yet have is a way to *catch a regression on a field that has not
been written yet* — the DoD 4/5/6/8 fixtures (`expired`, `notYetValid`, `wrongAudience`,
`wrongInResponseTo`) are all still untested, and each one will introduce a new read.

Concretely, when the driver lands each of those four fixtures needs a sibling in the
`xswUnwrappedSubject` shape — a forged bare `<saml:Conditions>` / `<saml:AudienceRestriction>`
/ `<saml:SubjectConfirmationData>` in `Extensions` — or the rule is enforced by review
rather than by test for exactly the fields where a miss is silent. Cheapest form: build
those reads as one `readFromAssertion(node, xpath)` helper that takes the verified node and
has no access to `doc` at all, so document-wide reads are unavailable rather than
discouraged. Recording as the S2-driver acceptance criterion, not as a change to this SHA.

### (b) Is the INSERT-claim before or after signature verification?

**Neither — there is no ACS route yet, so nothing calls `AssertionReplay.claim()` outside
its own tests.** `git grep AssertionReplay` on `dab75e1a` returns the model, its test, and
`purge.js`. The ordering question cannot be answered from this commit, and I am not going to
report it as satisfied.

PMO's stated requirement is right, and I want to record *why* precisely, because the wrong
order is not merely sloppy:

Claim-before-verify makes the replay table a denial-of-service primitive. An attacker who
observes any assertion ID — and IDs appear in IdP logs, proxy logs, browser history, and any
captured response — can POST a garbage document carrying that ID to the ACS endpoint. If the
claim runs first, the row is inserted, the signature check then fails, and the request is
refused. The legitimate user's assertion is now spent before they present it, and their
login fails as a replay. Unauthenticated, unlimited, one row per attempt, and it also fills
the table the purge exists to bound. So the order is: **signature verified → issuer/audience
/conditions checked → THEN claim.**

Two further ordering points for the ACS route, both of which are easy to get wrong in the
opposite direction:

- The claim must come **before** `linkPrincipal`, not after. A claim after account creation
  means a replayed assertion has already created or mutated a user by the time it is
  refused.
- `expiresAt` passed to `claim()` must be the assertion's own `NotOnOrAfter`, read from the
  **verified** assertion node (rule (a) again). Taking it from anywhere else lets an
  attacker set the row's lifetime, and a short one deletes the replay record early.

I would like the ordering pinned by a test when the route lands: present a document with a
valid ID and a broken signature, then present the genuine assertion with that ID, and assert
the genuine one still succeeds. That is the failure claim-before-verify produces, and it is
invisible in any test that only ever presents well-formed assertions.

---

## The slot-082000 tables — reviewed, correct

**`identity_assertion_ids`**

- `@@unique([provider, assertionId])` with the claim written as an INSERT that catches
  `P2002` — not read-then-write. This is right and the comment gives the right reason: the
  check-then-act version loses the race between two simultaneous presentations, which is the
  cheapest possible attack on it. The `Promise.allSettled([claim(), claim(), claim()])` test
  proves it: exactly 1 fulfilled, 2 rejected.
- Provider-scoped rather than global. Correct — assertion IDs are unique only within an
  issuer, so a global constraint means adding a second tenant starts failing random logins
  as replays.
- `P2002` is the *only* swallowed error; everything else surfaces, with a test injecting a
  `P1001`. Right, and the comment names the consequence of getting it wrong (a dead
  connection becoming an unlimited replay window).
- The refusal message does not echo the assertion ID or the table name, asserted directly.
- `@@index([expiresAt])` plus a `pg_indexes` test. Worth having as a test rather than a
  comment: the purge is what stops one row per unauthenticated login attempt accumulating
  forever.
- `purgeExpired` sweeps by expiry alone, wired into `purge.js` **before** `readRetentionDays`
  — so it still runs when retention is unconfigured. Same placement as
  `identityLoginState.purgeExpired`, and correct for the same reason: this sweep is a
  resource bound, not an audit-retention policy, and gating it on an unrelated setting would
  make a disk fill depend on whether someone configured retention.

**`identity_providers`**

- `provider` unique. Right, and the reason given is the real one — two rows means the
  certificate a signature is checked against depends on row order.
- `certificates` as `TEXT[]`. Correct and necessary: Entra publishes the next certificate
  before signing with it, and a single-certificate column forces a flag-day cutover where
  every login fails as a bad signature until someone notices. Verifying against *any*
  certificate in the list is what makes rotation an operation rather than an outage.
- `enabled` defaults `false`. Fail-closed, and the reason is specific rather than generic:
  a settings form saves field by field, so a provider live at first save would accept logins
  against a half-written certificate list.
- The `information_schema` test asserting no `secret`/`privatekey`/`password` column, with
  `expect(names).toContain("entityid")` as the anti-vacuous-pass guard. That guard is the
  part I would have asked for — without it the loop passes on a table that does not exist.
  The SP private key going to `CredentialStore` (AES-256-GCM) rather than a column is the
  right split: this table is read on every login and is in every backup.

Slot discipline: one slot, `20260902082000`, two tables plus the backfill. Matches the
ruling. No collision with `072000` (#52) or earlier.

---

## Three notes (none blocking)

### NOTE-A — `identity_providers.id` default drifts between schema and migration

`schema.prisma:450` declares `id String @id @default(uuid())` — Prisma generates the UUID
client-side. `migration.sql:37` is `"id" TEXT NOT NULL` with no `DEFAULT`. That is Prisma's
normal output and is fine *through Prisma*, but any `INSERT` from raw SQL — a seed, a
support runbook, a data migration — fails with a not-null violation on a column that looks
defaulted in the schema file. `identity_login_state` (S1) sidesteps this by using the state
string as its own PK.

Either add `DEFAULT gen_random_uuid()` in the migration or note in the model that inserts
must go through Prisma. One line; raise now because it is much cheaper before rows exist.

### NOTE-B — `normalize(email, NFC)` requires PostgreSQL 13+

`normalize()` was added in PostgreSQL 13. On 12 or earlier the migration fails with
`function normalize(text, unknown) does not exist`, which halts `migrate deploy` mid-slot —
so the two tables land or do not land depending on statement order, and an operator sees a
partial migration.

I could not find a documented minimum PostgreSQL version for this fork to check it against.
If 13+ is already the floor, this is a non-issue and worth one comment in the migration
saying so. If it is not, the guard is cheap:

```sql
DO $$ BEGIN
  IF current_setting('server_version_num')::int >= 130000 THEN
    UPDATE "identity_links" SET "email" = normalize("email", NFC);
  END IF;
END $$;
```

Flagging rather than fixing since the answer is a project fact I do not have.

### NOTE-C — the backfill is unconditional across every row

`UPDATE identity_links SET email = normalize(email, NFC)` rewrites every row, not only the
non-NFC ones. Functionally identical (NFC of NFC is NFC) and the table is small, so this is
a note rather than a finding — `WHERE email <> normalize(email, NFC)` would touch only what
needs touching if the table ever grows.

---

## Also verified

- The `deriveUsername` load-bearing comment is now explicit about *which* property carries
  the weight (`^[a-z][a-z0-9._@-]*$` admits no uppercase and no non-NFC form) and what
  breaks if the regex widens. That was the point — the risk was not that it was wrong, but
  that it was invisible.
- Check order (1a) → (1b) → (2) unchanged from `79448c01`, still correct.
- `purge.js` returns `assertionIdsPurged` on both exit paths, including the early return
  when retention is unset.

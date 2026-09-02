# Techlead — #68 / S3b pre-review: `identity_providers` one-shape CHECK (slot 092000)

Reviewed: working tree of `.claude/worktrees/s3-ldap` @ `9bba2b24` (branch `approof/s3-ldap`).
Uncommitted at review time: migration `20260902092000_identity_providers_one_shape/migration.sql`
(untracked), plus modifications to `schema.prisma`, `ldapProviderConfig.test.js`,
`ldapRoutesHttp.test.js`, `endpoints/identity/ldap.js`.
Pre-review — no SHA yet. Verdict: **no blocker. Ship it.** Three NITs, none gating.

Every ruling PMO listed is implemented and each one is implemented for the reason given.

## Rulings, verified

**Shape-derived, no discriminator.** Verified the premise rather than accepting it: both schema
suites write random values into `provider` — `ldapProviderConfig.test.js:54` (`ldap-<hex>`) and
`samlSchema.test.js:115` (`saml-<hex>`). A CHECK on `provider = 'saml'` rejects every row those
suites insert, and `LIKE 'saml%'` lets a row select its own validation rule by its own name. The
recon's analogy is exact — it is the same defect class as reading a signed document's Subject
document-wide: the value that chooses the rule is chosen by the party being checked. The constraint
as written names neither provider.

**Empty-string contract kept and pinned.** `COMMENT ON COLUMN` on both `entityId` and `ssoUrl`, and
the `is_nullable = 'NO'` test at `ldapProviderConfig.test.js:227`. The split is the right one and the
test comment states it: a comment is documentation and can be ignored; the test is the part that
actually fails when someone makes those columns optional. Without it, making them nullable inverts
every clause of the constraint in silence.

**No `NOT VALID`.** The migration validates on apply. Correct direction to fail: a deployment holding
a half-configured row learns at migrate time rather than at someone's login. The operational risk is
recorded in the recon (§5) rather than hidden.

**Six tests, both directions, literal `''`.** All present at `:170-234`:
- `a complete SAML row is accepted` — guards the guard. Without it a constraint that rejected
  everything would pass all five rejection tests and look correct.
- `a complete LDAP row is accepted`.
- `SAML columns PLUS a directory URL is REJECTED` and `LDAP columns PLUS a non-empty entityId is
  REJECTED` — the mixed row from both sides. The second is the one that kills a constraint weakened
  to `ldapUrl IS NOT NULL`; the comment says so.
- `an EMPTY ldapUrl is REJECTED` — the input that separates `IS NOT NULL` from `IS NOT NULL AND <> ''`.
  Every test that inserts NULL survives the weaker spelling.
- `a row that is NEITHER shape is REJECTED` — the provider configured to authenticate against nothing.
- Plus the `is_nullable` assertion above.

That is a real mutation-killing set, not six restatements of one property.

**NIT-1, the per-account limiter — implemented, and the test is better than the NIT asked for.**
`ldap.js:173` now carries `[inviteRateLimit, loginAccountRateLimit]`, matching `/request-token`
(`system.js:231`). Two things I would have flagged had they been missing and were not:
- The two limits are set to **different** values in the suite (`INVITE_RATE_LIMIT_MAX=20`,
  `LOGIN_ACCOUNT_RATE_LIMIT_MAX=3`) with a comment saying why: equal values make every test that trips
  one trip the other at the same request, and nothing then distinguishes a per-IP bucket from a
  per-account one.
- `NIT-1: guessing ONE account is capped tighter than the IP budget` (`:208`) asserts the **contrast**,
  not the 429: after the guessed username is refused, a fresh username from the same IP is still
  served, and `refusedAt < INVITE_RATE_LIMIT_MAX`. A single per-IP limiter would block both, so
  "429 eventually" could not tell the two designs apart. And `the per-IP bucket still bounds an
  attacker who spreads across accounts` (`:229`) covers the mirror case — rotating usernames evades
  the per-account bucket entirely, so dropping the IP limiter would leave spraying unmetered.

**NIT-2 / NIT-3 recorded as comments.** `ldap.js:142` explains the shared bucket as deliberate, with a
reason I had not made and accept: a private bucket on `/enabled` would let a caller spend the login
budget and keep polling. `ldap.js:166` records that `simpleSSOLoginDisabled` does not gate this route
— checked the semantics: that flag governs issuance of SSO login links (a bearer credential sent out
of band, `systemSettings.js:1167`), while this route checks a password the caller already holds. The
written answer matches the code.

## Verified independently

- **Out-of-order slot is safe as claimed.** 092000 lands after 101000/102000 in wall-clock (git commit
  times confirm 091000 was authored after 101000 already). `grep -l identity_providers
  server/prisma/migrations/*/migration.sql` returns only 082000 and 091000 — nothing after 091000 has
  touched this table, so the header's claim holds. `migrate deploy` applies pending migrations in
  lexicographic order and does not care that later-named ones are already applied.
- **CHECK-in-migration has precedent on main**: `20260902102000` adds `permissions_scope_check` the
  same way. Prisma has no schema syntax for a row-level CHECK, so the drift between `schema.prisma` and
  the database is a pre-existing, accepted shape here — and the new `schema.prisma` comment block
  (`:446-458`) says so explicitly, which is more than 102000 did.
- **Existing rows pass.** The live SAML row (non-empty `entityId`/`ssoUrl`, LDAP columns NULL) hits
  clause 1. Both existing test fixtures — `ldapRow()` at `:53` and `providerRow()` at
  `samlSchema.test.js:115` — hit clause 2 and clause 1 respectively. Checked every
  `identity_providers.create` in the tree (12 in `ldapProviderConfig`, 8 in `samlSchema`); none
  produces a row the constraint would newly reject.
- **`certificates` correctly excluded.** S2 made it a list so it can be empty during rotation, and
  `enabled` defaulting to false is what stops such a provider authenticating. Constraining it would
  make a legitimate intermediate state unrepresentable.
- **Nothing in `server/` reads this table yet** — only the two schema suites and the migrations
  reference it. So this constrains only what tests insert today, which is why now is the cheap moment.

## NIT-1 (mine) — `is_nullable` query is not schema-qualified
`ldapProviderConfig.test.js:233` selects from `information_schema.columns WHERE table_name =
'identity_providers'` with no `table_schema` predicate, then asserts `toHaveLength(2)`. This suite
creates a throwaway **database**, so there is one schema and the count is right. Several suites in this
repo instead connect with `?schema=<name>` against a shared database (`samlRoutesHttp`,
`ldapRoutesHttp`, `keyScopeCeiling`); if this assertion is ever copied into one of those, the same
table exists in two schemas and the length assertion fails for a reason that has nothing to do with
nullability. `AND table_schema = current_schema()` costs one line and makes it portable. The existing
`:117` and `samlSchema.test.js:163` queries have the same shape, so this is consistency, not a new
defect.

## NIT-2 (mine) — the rejection tests assert `.rejects.toThrow()` without naming the constraint
All five rejection cases pass on ANY error from `create`. A Prisma validation error, a unique-key
collision on `provider`, or a connection failure would satisfy them identically. The fixtures generate
random `provider` values so a collision is not realistic, and the RED (written before 092000 exists)
proves the tests fail without the constraint — so the suite is not vacuous. But `toThrow(/one_shape/)`
would pin that the rejection comes from THIS constraint rather than from whatever else the row happens
to violate later. Postgres puts the constraint name in the message and Prisma passes it through.
Cheap, and it is the difference between "the insert failed" and "the invariant held".

## NIT-3 (mine) — issue number in the header
Migration, schema comment and test header all say `S3b (#68)`. Confirmed #68 is open and titled for
exactly this work, so this is correct — recording it only because the surrounding files say `#60` and
a reader diffing them will wonder.

## What I did not do
Did not run the migration or the suite — no `DATABASE_URL` in this session, and the migration is
uncommitted. The RED claim (three obvious tests pass a weakened constraint; the mixed-direction and
empty-string cases are what kill it) is reasoning I verified by reading the constraint against each
test input, not by executing mutants.

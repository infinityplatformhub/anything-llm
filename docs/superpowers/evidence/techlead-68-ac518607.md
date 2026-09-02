# Techlead — #68 / S3b `identity_providers` one-shape CHECK, `ac518607`

Reviewed: `ac518607` (Dev3, `approof/s3-ldap`, rebased on main), delta `9bba2b24..ac518607`.
Verdict: **PASS.** No blocker, no major. Two NITs, neither gating.

Diffstat: 5 files, +339/-97 — migration `20260902092000_identity_providers_one_shape` (new, 57),
`schema.prisma` (+13 comment), `ldapProviderConfig.test.js` (+97), `ldapRoutesHttp.test.js` (+46/-4),
`endpoints/identity/ldap.js` (+126/-93, of which `git diff -w` shows **+49/-16** — the rest is
prettier reflow from wrapping the handler in an array-middleware call).

## Every ruling implemented, and for the stated reason

**Shape-derived CHECK, no discriminator.** I verified the premise rather than accepting it: both schema
suites write random values into `provider` — `ldapProviderConfig.test.js:54` (`ldap-<hex>`),
`samlSchema.test.js:115` (`saml-<hex>`). A CHECK on `provider = 'saml'` rejects every row those suites
insert; `LIKE 'saml%'` would let a row select its own validation rule by its own name. The recon's
analogy holds exactly — same defect class as reading a signed document's Subject document-wide: the
value that chooses the rule is chosen by the party being checked. The constraint as written names
neither provider.

**Empty-string contract kept and pinned.** `COMMENT ON COLUMN` on both `entityId` and `ssoUrl`, plus the
`is_nullable = 'NO'` assertion at `:227`. The split is right and the comment says why: a comment is
documentation and can be ignored; the test is the part that fails when someone makes the columns
optional. Without it, writing NULL inverts every clause of the constraint in silence.

**No `NOT VALID`** — validates on apply. Correct direction to fail: a deployment holding a
half-configured row learns at migrate time, not at someone's login.

**Seven tests** (`:170-234`), and they are a mutation-killing set rather than seven restatements:
- `a complete SAML row is accepted` — guards the guard. Without it, a constraint that rejected
  *everything* would pass all four rejection tests and look correct.
- `a complete LDAP row is accepted`.
- `SAML columns PLUS a directory URL is REJECTED` **and** `LDAP columns PLUS a non-empty entityId is
  REJECTED` — the mixed row from both directions. The second is the one that kills a constraint
  weakened to `ldapUrl IS NOT NULL`; the three obvious cases survive it.
- `an EMPTY ldapUrl is REJECTED` — the literal `''`, which is what separates `IS NOT NULL` from
  `IS NOT NULL AND <> ''`. Every test that inserts NULL survives the weaker spelling.
- `a row that is NEITHER shape is REJECTED` — the provider configured to authenticate against nothing.
- The `is_nullable` assertion.

RED 4/9 is the arithmetic I would expect and it checks out: the four rejection cases fail without the
migration; the two accepts and `is_nullable` pass without it (those columns are already NOT NULL from
082000), and the two limiter tests in the route suite make up the 9.

**NIT-1 (per-account limiter) — implemented, and the test is stronger than the NIT asked for.**
`ldap.js:173` is now `[inviteRateLimit, loginAccountRateLimit]`, matching `/request-token`
(`system.js:231`), reusing the existing `loginKey` (ip+username) with no new limiter invented. Two
things I would have flagged had they been missing:
- The two limits are set to **different** values in the suite (`INVITE_RATE_LIMIT_MAX=20`,
  `LOGIN_ACCOUNT_RATE_LIMIT_MAX=3`) with a comment saying why: equal values make every test that trips
  one trip the other at the same request, and nothing then distinguishes a per-IP bucket from a
  per-account one.
- `NIT-1: guessing ONE account is capped tighter than the IP budget` (`:208`) asserts the **contrast**,
  not the 429: after the guessed username is refused, a fresh username from the same IP is still
  served, and `refusedAt < INVITE_RATE_LIMIT_MAX`. A single per-IP limiter would block both, so "429
  eventually" cannot tell the two designs apart. `the per-IP bucket still bounds an attacker who
  spreads across accounts` (`:229`) covers the mirror: rotating usernames lands every request in a
  fresh per-account bucket, so dropping the IP limiter would leave spraying unmetered. Two mutants,
  two separate tests, each killing one.

**NIT-2 / NIT-3 recorded as comments.** `ldap.js:141` explains the shared `/enabled` bucket as
deliberate, with a reason I had not made and accept: a private bucket there would let a caller spend
the login budget and keep polling. `ldap.js:165` records that `simpleSSOLoginDisabled` does not gate
this route — I checked the semantics, and the written answer matches the code: that flag governs
issuance of SSO login links, a bearer credential sent out of band (`systemSettings.js:1167`), while
this route checks a password the caller already holds.

## Verified independently

- **Out-of-order slot is safe as the header claims.** `grep -l identity_providers
  server/prisma/migrations/*/migration.sql` returns only 082000 and 091000 — nothing after 091000 has
  touched this table. (Git commit times confirm 091000 itself was authored after 101000 already, so
  out-of-order application is established practice on this branch, not new here.) `migrate deploy`
  applies pending migrations lexicographically and does not object to later-named ones already applied.
- **CHECK-in-migration has precedent on main**: `20260902102000` adds `permissions_scope_check` the same
  way. Prisma has no schema syntax for a row-level CHECK, so schema/database drift is a pre-existing
  accepted shape — and the new `schema.prisma` comment (`:446-458`) states it explicitly, which 102000
  did not.
- **No existing row is newly rejected.** The live SAML row (non-empty `entityId`/`ssoUrl`, LDAP columns
  NULL) satisfies clause 1. Both fixtures — `ldapRow()` at `:53` and `providerRow()` at
  `samlSchema.test.js:115` — satisfy clause 2 and clause 1. Checked every `identity_providers.create`
  in the tree (12 in `ldapProviderConfig`, 8 in `samlSchema`); none produces a row the constraint
  refuses.
- **`certificates` correctly excluded.** S2 made it a list so it can be empty during rotation, and
  `enabled` defaulting to false is what stops such a provider authenticating. Constraining it would
  make a legitimate intermediate state unrepresentable.
- **Migration text is byte-identical to what I pre-reviewed** (md5 `ef7a4455…` at both the working tree
  and `ac518607`), so the pre-review verdict carries.
- **Nothing in `server/` reads this table yet** — only the two schema suites and the migrations
  reference it, so this constrains only what tests insert today. That is why now is the cheap moment.
- **The route change is comment + middleware only.** `git diff -w` confirms the sole behavioural edits
  are the `loginAccountRateLimit` import and its addition to the middleware array; every other hunk is
  reindentation. Nothing in the handler body changed.

## NIT-1 (mine) — `is_nullable` query is not schema-qualified
`:233` selects from `information_schema.columns WHERE table_name = 'identity_providers'` with no
`table_schema` predicate, then asserts `toHaveLength(2)`. This suite creates a throwaway **database**,
so there is one schema and the count is right today. Several suites here instead connect with
`?schema=<name>` against a shared database (`ldapRoutesHttp`, `samlRoutesHttp`, `keyScopeCeiling`); if
this assertion is copied into one of those, the table exists in two schemas and the length assertion
fails for a reason unrelated to nullability. `AND table_schema = current_schema()` is one line. The
existing `:117` and `samlSchema.test.js:163` queries share the shape, so this is consistency rather
than a new defect.

## NIT-2 (mine) — the rejection tests assert `.rejects.toThrow()` without naming the constraint
All four rejection cases pass on ANY error from `create` — a Prisma validation error, a unique
collision on `provider`, or a dropped connection would satisfy them identically. The fixtures generate
random `provider` values so a collision is not realistic, and the RED (4/9 with the migration removed)
proves the suite is not vacuous. Still, `toThrow(/one_shape/)` would pin that the rejection comes from
*this* constraint rather than whatever else the row happens to violate later. Postgres puts the
constraint name in the message and Prisma passes it through. It is the difference between "the insert
failed" and "the invariant held".

## What I did not do
Did not run the migration or the suite — no `DATABASE_URL` in this session. RED 4/9 and the mutation
claims are Dev3's, reported through PMO; I verified the constraint against each test input by reading,
which is what tells me the arithmetic is right, not that it was observed.

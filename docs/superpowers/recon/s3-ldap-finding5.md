# Recon — FINDING-5, `identity_providers` row-level CHECK (#60, slot 092000)

Read against `approof/s3-ldap` @ `17aadd2f`. Recon only — no migration written
and no schema edit; slot 092000 lands as its own commit after the #60 route work
merges. This is the statement, its effect on existing rows, and the tests, plus
the two questions that had to be answered before the statement could be written,
because the obvious spelling of the constraint is wrong. Both are now ruled
(§3, §4) and the rulings are folded in below.

## 1. What the table looks like today

`identity_providers` after slot 091000:

| column | null? | note |
|---|---|---|
| `provider` | NOT NULL, UNIQUE | NOT a discriminator — see §3 |
| `entityId`, `ssoUrl` | **NOT NULL** | S2's, no default |
| `certificates` | NOT NULL (`TEXT[]`) | |
| `enabled` | NOT NULL default `false` | |
| `ldapUrl`, `baseDn`, `bindDn` | NULL | S3's |
| `usernameAttribute`/`emailAttribute`/`displayNameAttribute` | NOT NULL, defaulted | |

Nothing in `server/` reads or writes this table yet — only the two schema tests
and the migrations reference it. So a constraint added now costs nothing at
runtime and constrains only what the tests insert. That is the cheapest moment
to add it and the reason to do it in its own slot rather than later.

## 2. The defect FINDING-5 names

An LDAP row today is inserted as `entityId: ""`, `ssoUrl: ""`, `certificates: []`
— because those columns are NOT NULL and something has to satisfy them. A SAML
row leaves `ldapUrl`/`baseDn`/`bindDn` NULL. Nothing stops a row that is
half of each, or a row that is neither: `entityId: ""` with `ldapUrl: NULL` is
a provider configured to authenticate against nothing, and it is accepted.

The constraint's job is to make the half-configured row unrepresentable, so a
login never reaches a provider row that cannot answer.

## 3. Ruling #1 (DECIDED: (a)) — `provider` is NOT a discriminator

The proposed shape is "saml → entityId/ssoUrl non-empty, ldap → ldapUrl/baseDn/
bindDn non-empty". That needs a column saying which kind a row is. `provider` is
not it. It is the UNIQUE registry key, and both existing tests deliberately write
random per-test values into it:

- `samlSchema.test.js:116` — `provider: \`saml-${randomBytes(4).hex}\``
- `ldapProviderConfig.test.js:54` — `provider: \`ldap-${randomBytes(4).hex}\``

`samlSchema.test.js:87` also writes `"saml-secondary"` (to `identity_assertion_ids`,
but the same naming habit). A CHECK matching `provider = 'saml'` rejects every
one of them; a CHECK matching `provider LIKE 'saml%'` is a prefix test on a
free-text key, which means a provider named `samlish-corp` or `ldap-eu` decides
its own validation rules by its name. That is the wrong mechanism — the same
class of error as reading a signed document's Subject document-wide: the value
that selects the rule is attacker- or operator-chosen.

**The two candidates that were weighed:**

- **(a) Shape-derived, no discriminator.** The constraint asserts only that a
  row is exactly one complete shape, without naming which:

  ```sql
  ALTER TABLE "identity_providers" ADD CONSTRAINT "identity_providers_one_shape"
  CHECK (
    (
      "entityId" <> '' AND "ssoUrl" <> ''
      AND "ldapUrl" IS NULL AND "baseDn" IS NULL AND "bindDn" IS NULL
    ) OR (
      "ldapUrl" IS NOT NULL AND "ldapUrl" <> ''
      AND "baseDn"  IS NOT NULL AND "baseDn"  <> ''
      AND "bindDn"  IS NOT NULL AND "bindDn"  <> ''
      AND "entityId" = '' AND "ssoUrl" = ''
    )
  );
  ```

  Self-describing, needs no new column, and rejects the mixed row from both
  directions. Cost: the two shapes are pinned in SQL, so S4's next provider
  edits this constraint.

- **(b) Add a `kind` column** (`'saml' | 'ldap'`, NOT NULL) and branch on it.
  Honest and extensible, but it is a second column meaning almost what
  `provider` means, and a row can still lie by setting `kind` wrong — the CHECK
  then enforces the wrong half. It also makes slot 092000 a data migration
  (backfill `kind` for the live SAML row), not just a constraint.

**Recommendation: (a).** It needs no backfill, cannot be lied to, and the
extensibility (b) buys is speculative — S4 is directory sync on this same LDAP
row, not a fourth shape.

**PMO ruled (a).** No discriminator column; the constraint is the SQL above.

## 4. Ruling #2 (DECIDED: keep, and pin it) — the empty string is doing NOT NULL's job

`entityId = ''` is currently how an LDAP row says "not a SAML provider". Under
(a) that meaning becomes load-bearing: the constraint reads `''` as absence.
It works, and it needs saying out loud in the migration comment, because the
natural later cleanup — making `entityId`/`ssoUrl` nullable and writing NULL —
silently inverts every clause.

**PMO ruled: keep the empty-string contract, and make it impossible to flip
quietly.** Two obligations fall out, both in slot 092000:

- `COMMENT ON COLUMN "identity_providers"."entityId"` and `."ssoUrl"`, saying
  that NOT NULL plus `''` is part of the CHECK and that making either nullable
  requires rewriting the constraint in the same migration.
- A test asserting `is_nullable = 'NO'` for both, read from
  `information_schema.columns`. A comment is documentation and can be ignored;
  this is the part that actually fails when someone flips it. It brings the
  count to six tests.

## 5. Effect on existing rows

- **The live SAML row**: `entityId`/`ssoUrl` non-empty, LDAP columns NULL →
  satisfies clause 1. Passes.
- **Rows written by current tests**: the LDAP rows write `entityId: ""`,
  `ssoUrl: ""`, `certificates: []` and all three LDAP columns → clause 2. Pass.
- **`certificates`** is deliberately NOT in the constraint. S2 made it a list
  precisely so it can be empty during rotation, and a SAML provider that is
  configured but not yet certificated is a real intermediate state; `enabled`
  defaulting to `false` is what keeps it from authenticating.
- **Any row that is neither shape** — the failure mode FINDING-5 is about —
  would be rejected. There are none in the migrated database today; if a
  deployment has one, `ALTER TABLE` fails at migrate time rather than silently
  accepting it, which is the correct direction to fail. Worth calling out as the
  one operational risk: on a database nobody has audited, this migration can
  refuse to apply. `NOT VALID` + a later `VALIDATE CONSTRAINT` is the escape
  hatch if PMO wants the migration to be unconditionally safe; I would not use
  it here, since the table has exactly one production row. **PMO ruled: no
  `NOT VALID`** — the migration validates on apply.

## 6. The tests (RED first, in `ldapProviderConfig.test.js`)

```js
test("a complete SAML row is accepted", …)   // entityId+ssoUrl set, LDAP cols NULL
test("a complete LDAP row is accepted", …)   // ldapUrl+baseDn+bindDn set, SAML cols ''
test("a row that is half of each is REJECTED", …)
```

Those three are the obvious set. The third is the only one that can fail today,
so it is the RED. Two mutation notes, both §7.9c-shaped, are why three is not
enough:

- A constraint reduced to `ldapUrl IS NOT NULL` still passes all three above.
  The mixed row has to be tested **from both directions** — SAML columns set
  *plus* an `ldapUrl`, and LDAP columns set *plus* a non-empty `entityId` — or
  half the constraint is unproven.
- `IS NOT NULL` without `<> ''` survives every test that inserts NULL. One case
  must insert `ldapUrl: ""` explicitly: an empty string is not a directory
  address, and Prisma will happily write one.

So five tests, not three. The extra two are the ones that actually kill mutants.
Ruling #2 adds a sixth: `is_nullable = 'NO'` on `entityId` and `ssoUrl`, which is
what stops the empty-string contract from being inverted in silence.

## 7. Sequencing

Slot **092000**, as its own commit on top of `17aadd2f`, landing only after the
#60 route work merges — deliberately NOT part of the SHA currently at the gate.
Slot 091000 is untouched and unrenumbered.

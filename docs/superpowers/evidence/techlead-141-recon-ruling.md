# Techlead-1 — #141 recon rulings (auth)

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist — secret
storage, fail-closed provider resolution, schema constraint correctness. `infi-lessons` not
invoked.

§7.14: no suite run. Source reads of both S3 migrations, `endpoints/identity/ldap.js`,
`utils/identityProviders/index.js`.

---

## (1) Migration shape: **new nullable columns, following S3 exactly — and the same migration MUST rewrite the `identity_providers_one_shape` CHECK**

S3 did columns, not JSON: `20260902091000_identity_providers_ldap` adds `ldapUrl`, `baseDn`,
`bindDn` plus a defaulted attribute map, all nullable or defaulted so the SAML provider already in
production survives the migration. Follow that: `larkAppId` (or `appId`) and whatever tenant field
the driver needs, nullable, no secret column. The migration's own comment states the rule to copy
verbatim — *"There is deliberately NO bind-password column… this table is read on every login and
sits in every backup, so it belongs in CredentialStore"*. A JSON config column would also defeat
the constraint work below, which reads individual columns.

**The blocker the recon has not named: a Lark row cannot exist today.**
`20260902092000_identity_providers_one_shape` is a two-branch CHECK, and a Lark row satisfies
neither — SAML requires `entityId <> '' AND ssoUrl <> ''`, LDAP requires `ldapUrl IS NOT NULL`.
A row with Lark columns filled and both others empty is **rejected by the database**. The
constraint is deliberately `NOT VALID`-free and shape-derived precisely so the next provider kind
edits it, and its comment says so: *"the next provider kind edits this constraint. That is
deliberate: it is a visible edit in a migration, not a silent gap."* #141 is that next provider
kind. **The third branch is not an optional extra — without it the resolution test cannot even
insert its fixture row**, so this is the first thing to write, not the last.

Two things carried from that migration's reasoning, which #141 must not re-derive wrongly:

- **The branch must not name `provider`.** That column is the free-text UNIQUE registry key chosen by whoever configures the deployment, and the schema tests write `saml-<hex>` / `ldap-<hex>` into it. A `provider = 'lark'` or `LIKE 'lark%'` clause lets a row select its own validation rule by its own name — the exact class of error the S3b comment rejects.
- **Empty string is load-bearing.** The Lark branch must assert `entityId = '' AND ssoUrl = ''` and the LDAP columns NULL, the way the LDAP branch does, or a half-Lark-half-SAML row becomes representable again. Add a `COMMENT ON COLUMN` for each new column in the same style, so the next person finds the rule where they are standing.

## (2) Can a row exist without the secret? **Yes — and resolution fails closed. Do not add a DB-level dependency.**

The secret is not in the database, so no constraint can see it; forcing the row to prove a
CredentialStore entry exists would put a runtime lookup inside a migration and inside every write.

The right shape is the one the driver already has: `LarkIdentityProvider`'s constructor throws
`IdentityConfigurationError` when `appId`/`appSecret` are missing (measured on the #138 read). So
`resolveDriver("lark")` on a row whose secret was never set throws a **named configuration error**,
not a null driver and not a silent skip. Two conditions:

- **`enabled` stays the operator's switch and defaults false**, exactly as S3b relies on for a rotating certificate. A configured-but-secretless row is inert until someone enables it, and enabling it produces a legible error rather than a sync that quietly does nothing.
- **The sync path must surface it.** #138's `runDirectorySync` already throws a named error for a missing driver; a missing *secret* must be distinguishable from a missing *registration*, or an operator who set the row and forgot the secret is told the provider is not registered. One test per direction.

```
RF : a saved lark row with NO CredentialStore entry -> resolveDriver throws
     IdentityConfigurationError naming the missing secret; the SAME row with the
     secret set resolves and reaches the token endpoint
mut : return null / skip when the secret is absent
why : every "the provider resolves" fixture is green with the secret present, and
      a null-return is invisible until a scheduled sync silently does nothing.
      The pair is what separates "not configured" from "not registered".
```

## (3) Tier `auth` — **confirmed.** New schema columns, a credential path, and a provider that
resolves identities. Full QA plus a Techlead verdict before merge, §7.11a.

## (4) Sequence: **after the #138 queue merge — and it is a hard dependency, not a courtesy**

#138's queue half touches `handlers.js`, `JobRuntime.js` and the job type strings; #141 registers
the driver those types resolve. Running them concurrently puts two devs in the registry/handler
seam at once, which is the lane rule. More concretely, #141's resolution test is only meaningful
once the sync path exists to consume it — before that it asserts a registry lookup with no caller.

One sequencing note the recon should carry: **#141 does not unblock a working Lark sync on its
own.** It makes the driver resolvable; whether a real tenant then syncs depends on the schedule
registration, which is #138's. Say so in the issue, or "Lark support" reads as done when it is
half done — the same over-claim S4a made by merging a driver nobody could configure.

---

## Addendum — three rulings on Dev2's recon detail

**Skills:** `superpowers:requesting-code-review`, `security-review`.

### (1) `entityId` / `ssoUrl`: **keep them NOT NULL. Write empty strings. Do NOT drop NOT NULL.**

The empty string is not a workaround here — it is the established encoding, documented in two
places. `schema.prisma:469-472`: *"`entityId` and `ssoUrl` are NOT NULL, and an empty string is
how a row says 'not a SAML provider'. The constraint reads it as absence. Making either optional
here inverts every clause of that constraint, and Prisma will let you do it silently."* The LDAP
branch of the CHECK already asserts `entityId = '' AND ssoUrl = ''`, and migration `092000` put a
`COMMENT ON COLUMN` on both saying the same thing.

So an LDAP row today **already** writes empty strings into those columns; a Lark row doing the
same is following the precedent, not faking SAML values. Dropping NOT NULL would invert every
clause of the constraint — the `= ''` tests would have to become `IS NULL OR = ''` in all three
branches, and any row written before that migration keeps the old encoding. That is a schema-wide
change to accommodate one new provider, and it loosens a guarantee every SAML row holds today, for
nothing: **the constraint's third branch is what makes the Lark row legal, and it works with the
existing encoding unchanged.**

Add the `COMMENT ON COLUMN` for each new Lark column in the same style, so this rule is found by
the next person where they are standing.

### (2) Name it `baseUrl` — and only if the row needs to carry it

Measured: the driver takes `baseUrl` (`index.js:86,93,114`, defaulted to `LARK_BASE_URL` and
right-trimmed), and has no `tenant` parameter at all. So if "tenant" in the recon means *Lark vs
Feishu*, the column is **`baseUrl`**, matching the constructor argument it feeds — a column whose
name differs from the field it populates is a translation layer nobody asked for.

If it means anything the driver does not model, **do not add the column.** A column no code reads
is worse than absent: it looks configurable, an operator sets it, and nothing happens. The rule
this program has applied twice already — a field that exists and does nothing is a defect, not a
placeholder.

Given the driver defaults `baseUrl`, the column is nullable and the resolver passes it only when
present, so a row that omits it gets the default rather than `null`.

### (3) Scope: **write the row in the test. Do not add a configuration endpoint to #141.**

Dev2 is right that nothing in `server/` reads `identity_providers` today — all provider config is
env, and the only reference is `samlSchema.test.js`. So "save a row → resolve" has no writer.

Adding one is a **different issue**: a configuration endpoint is a new authenticated surface with
its own permission question (which action gates writing an identity provider?), its own validation,
and its own UI. Folding it into #141 turns a registry registration into a feature, and #141 is
already `auth` tier with a migration and a credential path.

So #141's RF inserts the row directly with the test's own client, and the issue records the
residual plainly: **there is no way to configure a Lark provider through the product; the row must
be written by hand.** That is honest and it is the same shape as #138's declared seam.

**RF-1 must resolve THROUGH the registry** — agreed, and this is the sharpest point in the
addendum. The existing Lark tests `require` the class directly, so every one of them is green with
`lark` absent from `identityProviders`. That is precisely the gap #141 exists to close, and a test
that constructs the class proves nothing about it.

```
RF-1 : resolveDriver("lark", configFromRow) returns a LarkIdentityProvider instance
       and reaches the token endpoint — routed through utils/identityProviders/index.js,
       never by requiring the class
mut  : remove the `lark` key from the registry object
why  : every existing Lark test survives that mutation, because they construct the
       class directly. Only a registry-routed resolution goes red, and that is the
       entire content of this issue.
```

Pair it with `isKnownProvider("lark") === true` and a negative (`isKnownProvider("larks")` false),
so the null-prototype guard stays exercised.

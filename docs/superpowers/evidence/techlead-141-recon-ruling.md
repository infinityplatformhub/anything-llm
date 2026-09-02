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

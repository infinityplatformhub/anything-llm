# #141 recon — register `lark` as an identity provider

Skills: `infi-dev` (evidence contract shape), `brainstorming` (open items left as
questions). Recon only, no code. Measured at `approof/main` in a clean worktree.

**Depends on #138's queue merge** — the driver this registers is the file #138
is changing. Starting before that merge means writing a resolution test against
a constructor signature that is still moving.

---

## 1. The driver exists; the registry does not know about it

`server/utils/identityProviders/LarkIdentityProvider/index.js` is 18.3 KB of
working driver: `providerId()` returns `"lark"`, `capabilities()` declares
`{password:false, redirect:true, directorySync:true, groupSync:true,
deltaSync:false}`, and the constructor takes `{appId, appSecret, baseUrl?,
pageSize?, maxRetries?, fetchImpl?, timeoutMs?}`, throwing
`IdentityConfigurationError` without the first two.

`server/utils/identityProviders/index.js` registers three drivers — OIDC, SAML,
LDAP — and not this one. So today:

```js
isKnownProvider("lark")        // false
getIdentityProvider("lark", …) // throws "Unknown identity provider: lark"
providerCapabilities("lark")   // {}
```

`larkDirectorySync.test.js` (25.4 KB) drives the class **by requiring it
directly**, which is why the gap is invisible: every existing Lark test passes
while nothing can reach the driver through the only module callers are allowed
to import.

**Registration is one line**, and the registry's own header says so ("S2 and S3
are one line each instead of a change at every call site"). The line is a **key**
in the null-prototype map:

```js
[LarkIdentityProvider.providerId()]: LarkIdentityProvider,
```

Not a second lookup, not a branch. The null prototype is deliberate — `provider`
arrives from the URL, and on a plain object `"constructor"` resolves to a
function that is not a driver. Anything that adds a fallback path around the map
re-opens that.

## 2. `appId` / `tenant` have nowhere to live — this is the real blocker

`identity_providers` (`schema.prisma:476-509`) has **no column for either**. Its
shape is SAML's, with LDAP's nullable half bolted on:

| column | type | note |
|---|---|---|
| `provider` | `String @unique` | one row per provider |
| `entityId` | `String` | **NOT NULL** |
| `ssoUrl` | `String` | **NOT NULL** |
| `certificates` | `String[]` | SAML public material |
| `enabled` | `Boolean @default(false)` | fail closed |
| `ldapUrl` / `baseDn` / `bindDn` | `String?` | S3 added these nullable |
| `usernameAttribute` / `emailAttribute` / `displayNameAttribute` | `String` with defaults | LDAP attribute map |

**`entityId` and `ssoUrl` are NOT NULL**, so a Lark row cannot be written at all
without inventing SAML values for a provider that has neither. That is not a
cosmetic problem: a placeholder in a NOT NULL column is a lie that the next
reader has to know about, and `enabled` is a real switch that would be sitting
next to it.

**Proposed migration** — follow S3's precedent exactly, since it solved the same
problem for LDAP:

```sql
ALTER TABLE "identity_providers" ADD COLUMN "appId"    TEXT;
ALTER TABLE "identity_providers" ADD COLUMN "tenantId" TEXT;
ALTER TABLE "identity_providers" ALTER COLUMN "entityId" DROP NOT NULL;
ALTER TABLE "identity_providers" ALTER COLUMN "ssoUrl"   DROP NOT NULL;
```

The first two are additive and safe. **The two `DROP NOT NULL` statements are a
real decision and should not be made by a dev alone**: they weaken a constraint
that currently guarantees every SAML row is complete. The alternatives are worse
in different ways — a separate table per provider shape duplicates `provider`,
`enabled` and the attribute map; a JSON `config` column moves validation out of
the database and into whichever caller remembers. My reading is that S3 already
chose "one table, each provider fills the half that applies", and dropping the
two NOT NULLs is the honest completion of that choice rather than a new one —
**but it is a schema ruling, so it belongs to a Techlead.**

**Open question I cannot answer by reading:** is `tenantId` needed at all?
`LarkIdentityProvider`'s constructor does not take one — it takes `baseUrl`,
which is how a different Lark/Feishu region is reached. If "tenant" means the
region endpoint, the column should be `baseUrl` and match the driver; if it
means something the driver does not model yet, adding a column before the driver
uses it stores a value nothing reads.

## 3. `appSecret` goes to `CredentialStore` — a plaintext column is a reject

The precedent is explicit and one file away. `endpoints/identity/ldap.js:51-57`:

```js
const bindPassword =
  (await CredentialStore.get("SSO_LDAP_BIND_PASSWORD").catch(() => null)) ??
  process.env.SSO_LDAP_BIND_PASSWORD ??
  null;
```

with the schema comment (`:493-497`) stating the rule: *"unlike SAML's
certificates (public material) it is a real secret, and this table is read on
every login and sits in every backup."* Both halves of that sentence apply
unchanged to a Lark app secret.

So: **`SSO_LARK_APP_SECRET` in `CredentialStore`, env as the bootstrap path, and
no column.** A `appSecret TEXT` column in `identity_providers` is a reject, and
the reason to say so in the contract rather than in review is that the column
would look symmetrical with `appId` sitting beside it — the shape invites the
mistake.

The driver already protects the value once it is in memory: `toJSON()` is
overridden so the secret cannot reach a log or a serialized driver.

## 4. The resolution test — what makes it real

The test the issue asks for must fail today. Its shape:

```
save a row for provider "lark" (appId + enabled)
store SSO_LARK_APP_SECRET in CredentialStore
resolve THROUGH getIdentityProvider("lark", config)   ← not by requiring the class
assert the driver reaches the token endpoint
```

**Every clause is load-bearing:**

- **Through the registry.** `larkDirectorySync.test.js` requires the class
  directly and passes today; a new test that does the same would pass before the
  registration line exists and prove nothing.
- **From a saved row**, not a literal config object. The gap in §2 is that no row
  can be saved; a test built on an inline object never touches it.
- **Reaching the token endpoint** rather than asserting `instanceof`. A driver
  constructed with the wrong config shape is still a `LarkIdentityProvider`.

**Reuse #138's accept-then-silent server** (`/tmp/qa138`, described in
`qa1-138-driver-baseline.md`) rather than a dead port: a dead port rejects
immediately, which is green whether or not the timeout wiring is present. Accept
-then-silent is what distinguishes "configured and reached the network" from
"failed before it got there".

**Fixture hazard, from QA-1's own note:** `_tenantAccessToken` is memoised via
`_tokenExpiresAt`, so a second call in the same test is green regardless. Build a
fresh provider per case.

## 5. RF list

- **RF-1** `isKnownProvider("lark")` is true and `providerCapabilities("lark")`
  returns the driver's five flags. RED today: `false` and `{}`.
- **RF-2** `getIdentityProvider("lark", {appId, appSecret})` returns a working
  driver. RED today: throws `Unknown identity provider: lark`.
- **RF-3** a `lark` row **saves** with `appId` and without SAML fields. RED
  today: `entityId`/`ssoUrl` NOT NULL rejects it.
- **RF-4** the secret is read from `CredentialStore`, and **no plaintext secret
  is in `identity_providers`** — asserted by selecting the row and checking no
  column holds it, so a future column addition fails this test.
- **RF-5** end to end: saved row + stored secret → resolved through the registry
  → token endpoint reached, against the accept-then-silent server, fresh provider
  per case.
- **RF-6** the registry is still null-prototype: `isKnownProvider("constructor")`
  and `isKnownProvider("toString")` are both false. This exists because §1's
  one-line change is exactly where someone might "simplify" the map.

## 6. Open questions

1. **`tenantId` or `baseUrl`?** (§2) The driver models region as `baseUrl`. A
   column the driver does not read is a value nothing consumes.
2. **Dropping NOT NULL on `entityId`/`ssoUrl`** — Techlead ruling, not a dev
   decision (§2).
3. Does #141 include a **configuration endpoint**, or only the registry plus
   schema? Nothing in `server/` reads `identity_providers` today — the only
   references are in `samlSchema.test.js`. Every provider is configured from
   env, so "save a row" has no writer yet, and RF-3/RF-5 need one to exist or
   must write the row directly in the test.

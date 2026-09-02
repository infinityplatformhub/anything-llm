# Techlead review — #50 `4a5f4a65` (delete simple-SSO)

**Verdict: PASS.** Every item in my pre-check is addressed, including the one it flagged as
the highest risk and the one #58's ledger handed here. Two nits and two notes, no findings.

Reviewed as the diff from the branch base (`6f4dd4d4`), which isolates #50's own 31 files
from the T-5 and evidence work the rebase brought along. The `ff42b682` → `4a5f4a65` delta
is the §7.3a describe-title renames, the §5.1 single-line requires, and the rebase itself —
no behaviour change, verified by diffing those files directly.

---

## The seven things PMO asked

### 1. Redirect retarget → first OIDC provider

**Correct, and it handles the case my pre-check said would otherwise be a lockout.**
`Login/index.jsx:21-47` keeps the operator's explicit `noLoginRedirect` as first choice,
then starts a login with the first enabled provider, and — when there is neither — renders
an explicit message rather than navigating somewhere blank.

That third branch is the one that matters. My pre-check's warning was that deleting
file-by-file produces "credential login refused, nowhere to go" by accident; here it is a
deliberate branch that names the cause and the fix (`enable one or unset
SIMPLE_SSO_NO_LOGIN`). An operator who does this to themselves can read the screen and
recover.

`window.location.replace` rather than `<Navigate>` is right and the comment says why:
`/api/sso/:provider/login` is a **server** route that 302s to the IdP, so a client-side
router navigation would look for a React route that does not exist.

`paths.sso.login(provider)` now takes a provider — correct, since there is no "the" provider
any more once S2 lands.

### 2. `SSOProviders` in `currentSettings` — ids only

**Verified, and the test is the right shape.** `ssoEnabledProviders()` returns
`Object.keys(identityProviders).filter(...)` — bare strings, derived from the registry, so a
provider added by S2/S3 appears without another edit here.

The payload question is the important half: `GET /setup-complete` is **unauthenticated**
(`system.js:148-156`, no middleware array), because the login page reads it before anyone has
signed in. `ssoProvidersPayload.test.js` sets `SSO_OIDC_ISSUER`, `CLIENT_ID` and
`CLIENT_SECRET` to distinctive values and asserts none appears in the serialized output, plus
`every(p => typeof p === "string")` — so there is no object for a field to hide in. The
docblock names the failure it prevents: *"a future edit adding 'just the issuer, it's public
anyway' is exactly how this leaks."* That is the correct thing to write down, because the
leak would arrive as a reasonable-sounding convenience.

The truthy-spelling test (`"1" | "true" | "yes" | "on"`, plus `"TRUE"` / `" On "`) pins
agreement with `providerConfig()` in `endpoints/identity.js`. Worth having: if the two lists
disagreed the page would offer a provider the route 404s, or hide one that works. The
configured-but-disabled case is asserted separately for the same reason.

### 3. `simpleSSOEnabled.js:66` predicate + shape (b) tests

**Closed, and the ledger hand-off from #58 is honoured.** `response.locals.multiUserMode =
!(await isConfirmedSingleUser())` — inverted, not substituted, so the local keeps its meaning
for the `if (response.locals.multiUserMode && simpleSSOLoginDisabled())` line below.

`noLoginShapeB.test.js` has the structure I look for:
- **the fixture asserts it really is shape (b)** first (`isMultiUserMode() === false`,
  `isConfirmedSingleUser() === false`, `users.count() > 0`) — without that, the test below
  could pass on a plain multi-user instance and prove nothing;
- the block is enforced in shape (b);
- **the control**: with the flags unset, the same shape (b) request passes through. A guard
  that refused everything would pass the positive test while breaking every login;
- `SIMPLE_SSO_ENABLED` alone does not block — pins that both flags are required, which is
  the same conjunction my pre-check flagged as the reason `SIMPLE_SSO_ENABLED` cannot be
  deleted from the env surface.

The `simpleSSOEnabled` export is gone and the two `SIMPLE_SSO_ENABLED`-gated issuance
requires with it; `simpleSSOLoginDisabled` / `...Middleware` survive and still guard
`system.js:237`, `admin.js:271`, `invite.js:35`. That is the split my pre-check asked for.

### 4. Migration 090000

**Correct in every ordering detail, and one of them is not obvious.**

- **`role_permissions` before `permissions`.** I verified the constraint rather than the
  comment: `20260902020000:200` does declare `ON DELETE CASCADE` on the FK, so Postgres
  would have cascaded anyway — the explicit delete is belt-and-braces, not load-bearing. The
  migration's comment says "no ON DELETE CASCADE", which is **wrong about the mechanism**
  though right about the order. See NIT-1: the statement is harmless and idempotent, but a
  comment that misdescribes a constraint is a trap for whoever relies on it next.
- **Strip → `[]`, not revoke.** `("scopes"::jsonb) - 'sso.issue'` removes by value and is a
  no-op when absent, so re-running changes nothing — asserted directly by the idempotence
  test. Leaving an emptied key **alive and refused** rather than revoked is the right call
  and the comment gives the right reason: whether a credential should exist is the operator's
  decision, and revocation is quieter and irreversible.
- **The `NOTICE`** names the emptied keys by prefix so an operator can find them without
  writing a query, and it is a notice rather than a table because it is a fact about one
  upgrade, not state.
- **`policy_versions` bump.** Correct and easy to forget: the permission vocabulary changed,
  so a decision cached under the old vocabulary must not be trusted afterwards.
- **New slot, not an edit to `020000`/`045000`.** As my pre-check required, with the reason
  recorded (`_prisma_migrations` records by checksum; editing an applied migration makes a
  fresh database and an upgraded one disagree).

`ssoIssueRetirement.test.js` covers the four cases that matter — mixed key keeps the rest,
only-`sso.issue` key is emptied but `revokedAt` stays null, idempotent, untouched key
untouched — plus an orphan check via `LEFT JOIN`, which is the assertion that would catch an
out-of-order delete if the CASCADE were ever dropped.

`ALL_ACTIONS.length` decremented to 61 and `sso.issue` removed from `API_ACTIONS`,
`ALL_ACTIONS` and `setup_admin`. `ROUTE_SCOPES` lost its entry, and because
`ADMIN_DEFAULT_SCOPES` / `SINGLE_USER_KEY_SCOPES` derive from `Object.values(ROUTE_SCOPES)`,
they drop it with no edit — as measured in the pre-check.

### 5. `/v1` sweep — `mw[0].name`

**Present and correctly reasoned.** `apiRouteAuthSweep.test.js` now asserts
`route.middlewares[0]?.name === "apiKeyRequired"` for **every** `/v1` route, and the comment
draws the distinction that makes it worth having: carrying a guard *somewhere* in the array
(already asserted above it) is a weaker claim than the guard being *first* — a guard in
position 2 runs after whatever sits in position 1.

Asserting on the name rather than identity is required, not a shortcut: `validApiKey` is a
factory returning a named function expression, so `toBe(export)` cannot work. The comment
says the name was given deliberately, which is what stops someone converting it to an
anonymous arrow.

The failure output maps to `METHOD path (module) -> actualName`, so a failure names the
route rather than printing a boolean. That is the difference between this and a sweep nobody
can act on.

Route count 63 → 62, updated deliberately.

`issueAuthTokenWiring.test.js` (renamed from `ssoIssuanceHotfix.test.js`) asserts the
deletion in **both** directions — route absent from the table, and `scopeFor` returns
undefined. Keeping the file under a new name rather than deleting it preserves the history
of why the route went.

### 6. Single-use moved to the OIDC callback test

**Correct, and it is the stronger version of what it replaced.**
`identityRoutesHttp.test.js` asserts `temporary_auth_tokens` is empty after a login **and**
that redeeming a freshly minted token twice fails the second time — the same call the
callback makes. The old test proved single-use only through the deleted `/sso/simple`
exchange; this proves the property of the model that OIDC actually depends on.

The comment records why it moved: that file held the only HTTP proof, OIDC now depends on the
same property, so the proof follows the dependency rather than leaving with the feature that
used to carry it. `identity.js:134-137` gained a comment noting it is now the only caller of
`TemporaryAuthToken.validate` in the tree, and that the token never leaves the function.

### 7. `t1-authz-migration` assertion — replay artifact

**Correct diagnosis, and the fix is scoped rather than loosened.** That suite replays
`020000`'s step-7a *after* `migrate deploy`, which re-INSERTs the vocabulary as `020000`
wrote it — including a row `090000` has since deleted. On a real boot the migrations run in
order and the row stays deleted.

What makes this acceptable rather than a weakened assertion is the second expectation:

```js
expect(actions.filter(a => !RETIRED.includes(a))).toEqual([...ALL_ACTIONS].sort());
expect(actions).toEqual([...ALL_ACTIONS, ...RETIRED].sort());
```

The first keeps the test measuring what it is for (step-7a and the seed file agree); the
second pins that the replayed row is the **only** difference. Subtracting without that second
line would hide real drift. And `ssoIssueRetirement.test.js` asserts the row is genuinely
gone against a plain `migrate deploy`, so the property is not merely excused — it is proved
elsewhere.

---

## NIT-1 (low) — migration 090000's comment misdescribes the FK

`migration.sql:15-16`: *"role_permissions has no ON DELETE CASCADE (20260902020000:33-39), so
the order matters"*. It does have one — `20260902020000:200`:

```sql
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey"
  FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

The cited lines 33-39 are the `CREATE TABLE`, which indeed shows no cascade; the constraint
is added 160 lines later, as Prisma always emits it.

The statement is still correct to keep — explicit is better than relying on a cascade, and it
is idempotent. Only the comment needs fixing, and it needs fixing because the next person to
delete a permission will read it and believe the FK does not cascade. One line.

## NIT-2 (low) — `ssoEnabledProviders` duplicates the truthy-value list

`["1","true","yes","on"]` now appears in `systemSettings.js:1143`, `identity.js:32` and
`saml.js` (`samlEnabled`). Three copies of one rule; the test pins the first two together
but nothing pins the third. Worth one shared helper when S3 lands — flagging now because the
test exists precisely because the drift is plausible.

## NOTE-A — `SIMPLE_SSO_ENABLED` survives, and the env docs now say so

Both `.env.example` files re-comment the three flags for what they now mean, including that
`SIMPLE_SSO_ENABLED` is *required alongside* `SIMPLE_SSO_NO_LOGIN`. That is the trap my
pre-check flagged: `simpleSSOLoginDisabled()` requires **both**, so deleting the first would
silently disable the surviving feature. Documented rather than deleted — correct.

`SIMPLE_SSO_NO_LOGIN_REDIRECT`'s line now says it defaults to the first enabled SSO provider,
which matches `Login/index.jsx`. The names are now misleading (nothing "simple SSO" remains),
but renaming them would break every existing deployment's configuration. Leaving them is the
right trade; the comments carry the explanation.

## NOTE-B — the frontend surface is fully unwired

Verified by grep rather than by the file list: `simpleSSOLogin` gone from
`frontend/src/models/system.js`, `SimpleSSOPassthrough` import and `/sso/simple` route gone
from `main.jsx`, `pages/Login/SSO/simple.jsx` deleted. Every remaining hit for `sso/simple`
in the tree is a comment explaining the deletion. `useSimpleSSO` survives with a `providers`
field, which is what the retarget needs.

## Also verified

- `pr4aScopeHttp.test.js`'s `sso.issue` swapped for a live scope — it only ever used the
  string as "a scope this key does not hold", so any live scope works.
- `swagger/openapi.json` regenerated rather than hand-edited (59 lines removed, no manual
  hunks).
- `ssoIssuanceLock.js`, its two test files, and `ssoIssuanceLockHttp.test.js` all deleted.
  pr4c is merged, so the delete/modify conflict my pre-check warned about could not occur.
- `endpoints/system.js` lost the `/request-token/sso/simple` route and the `simpleSSOEnabled`
  require, and kept `simpleSSOLoginDisabled` at :237. #48's `DELETE /system/credential/:envKey`
  and #58's `/request-token` guard are both untouched — the three-way contention in that file
  resolved cleanly.
- §7.3a describe titles and §5.1 single-line requires are cosmetic gate fixes; the
  `noLoginShapeB` require placement carries a comment explaining it must stay inside the test
  because §7.10's `jest.resetModules()` runs in `beforeAll`. That is a real constraint worth
  the comment, not a gate being appeased.

# Techlead pre-check — #50 (delete simple-SSO), on `bb7dd00b`

Re-measured on the current main head rather than trusting the recon's `3e97e538` list.
Ruling (A) — delete `GET /v1/users/:id/issue-auth-token` and its scope mapping — is
accepted, with one correction to its blast radius that Dev2 must have before starting.

Command (widened from the recon's, to catch the route and scope surface too):

```bash
git grep -ln 'sso/simple\|ssoIssuanceLock\|SIMPLE_SSO\|simpleSSOEnabled\|issue-auth-token\|sso\.issue' \
  -- server docker frontend
```

---

## 1. The file list: 15 → 23 files, and the 8 new ones are all from ruling (A)

The recon's 15 files are all still in the surface. Ruling (A) adds eight, because deleting
a `/v1` route means deleting a scope, and the scope is asserted in four places by exact
value.

**Unchanged from the recon (15).** Line numbers moved; nothing was added or removed:

| file | then → now |
|---|---|
| `server/utils/middleware/ssoIssuanceLock.js` | delete outright |
| `server/__tests__/utils/middleware/ssoIssuanceLock.test.js` | delete outright |
| `server/__tests__/endpoints/ssoIssuanceHotfix.test.js` | see §2 |
| `server/__tests__/ssoIssuanceLockHttp.test.js` | see §3 |
| `server/endpoints/api/userManagement/index.js` | now a whole-route delete, not an edit — §4 |
| `server/endpoints/system.js` | route at **389-390**, requires at **79-81** (was 364-~400) |
| `server/utils/middleware/simpleSSOEnabled.js` | keep, see §5 |
| `server/models/systemSettings.js` | **625-627** and **1137-1148** |
| `server/utils/helpers/updateENV.js` | **1868-1870** (recon said 1869-1871) |
| `server/.env.example` | **497-499** |
| `docker/.env.example` | **491-493** |
| `server/swagger/openapi.json` | **3495**, **3521** — regenerate |
| `frontend/src/models/system.js` | **813-814** |
| `frontend/src/main.jsx` | **11**, **35-36** |
| `frontend/src/utils/paths.js` | **36** |

**New, all consequences of ruling (A) (8):**

| file | what | why it is not optional |
|---|---|---|
| `server/utils/apiKeySecurity/scopes.js` | drop `"GET /v1/users/:id/issue-auth-token": "sso.issue"` (line 19) | this IS the mapping ruling (A) removes |
| `server/__tests__/utils/middleware/routeScopes.test.js` | drop line 27 | `expect(ROUTE_SCOPES).toEqual(EXPECTED)` — an exact-equality assertion, so it FAILS the moment the map loses an entry |
| `server/__tests__/prisma/vocabulary-diff.test.js` | drop `"sso.issue"` from `approved`, decrement `ALL_ACTIONS.length` | asserts `toBe(62)`; see §6 |
| `server/prisma/seeds/permissions.js` | `sso.issue` at **73**, **111**, **121** | §6 |
| `server/__tests__/pr4aScopeHttp.test.js` | `["system.read", "sso.issue"]` at **26** | uses `sso.issue` only as a scope string a key does not hold; swap for any other live scope |
| `frontend/src/pages/Login/SSO/simple.jsx` | delete the file | the page `main.jsx:11` imports; the recon's `main.jsx` line does not mention it |
| `frontend/src/pages/Login/index.jsx` | **25-30** | §7 |
| `frontend/src/hooks/useSimpleSSO.js` | delete the file | §7 |

**Two migration files also match the grep and must NOT be touched**:
`20260902020000_t1_authz_schema` (seeds `sso.issue` into `permissions`) and
`20260902045000_api_key_scope_no_wildcard` (names it inside a backfilled scope-list
literal). Applied migrations are immutable — see §6 for what to do instead.

## 2. `ssoIssuanceHotfix.test.js` — the assertion still moves, and now it changes shape

The recon's §2 rewrite assumed the route survives with `validApiKey` first. Under ruling (A)
the route is gone, so `routes["/v1/users/:id/issue-auth-token"]` is `undefined` and the
whole file is about a route that does not exist. Delete it.

That loses a property worth keeping. The file's real subject is *"the refusing middleware
runs first, before anything touches the database"*, which applies to every `/v1` route, not
only this one. Its replacement is a sweep, not a per-route assertion:

```js
for (const [route, middlewares] of Object.entries(routes))
  expect(middlewares[0].name).toBe("apiKeyRequired");
```

`validApiKey` is a factory (`validApiKey.js:101`) returning a **named** function expression
`apiKeyRequired`, so identity comparison cannot work but the name can — and the name was
given deliberately. Whether that sweep belongs in #50 or a follow-up is PMO's call; what
must not happen is the file being deleted with the property going unrecorded.

## 3. `ssoIssuanceLockHttp.test.js` — delete, and it takes the last exchange proof with it

Delete. Every one of its five tests is about the lock or the `/sso/simple` exchange.

Worth noting what leaves with it: its final test is the only place in the tree that proves
`TemporaryAuthToken` **single-use** over HTTP — mint, exchange (200), exchange again (401).
The model keeps that behaviour and OIDC now depends on it (`identity.js:133-138` issues and
validates in-process), so the property still matters and will no longer have an HTTP test.
`identity.js` has its own coverage; flagging so the loss is deliberate rather than noticed
later.

pr4c (`5cb44484`) modified this file — it is already merged into `bb7dd00b`, so the
delete/modify conflict the recon warned about cannot occur. The recon's ordering constraint
is satisfied: #27 is in, and no unmerged branch holds these files.

## 4. `userManagement/index.js` — ruling (A) makes this a route delete

I verified the two facts Dev2's measurement rests on, and both hold on `bb7dd00b`:

- **The token is exchangeable in exactly one place.** `TemporaryAuthToken.validate` has two
  callers: `system.js:394` (the `/sso/simple` route #50 deletes) and `identity.js:138`
  (OIDC, in-process). Nothing else in the tree exchanges one.
- **OIDC does not use this route.** `identity.js:133-138` calls
  `TemporaryAuthToken.issue()` then `.validate()` directly, never over HTTP.

So after the deletion the route would mint a token nothing can redeem and return a
`loginPath` pointing at a 404. **Ruling (A) is right.**

I found no consumer PMO missed. The only thing that reads `loginPath` is the swagger example
(3521) and the route's own docblock (91).

Delete lines **72-123** whole, plus the `ssoIssuanceLock`, `simpleSSOEnabled` and `scopeFor`
requires if nothing else in the file uses them, plus `TemporaryAuthToken` at line 3.

## 5. `simpleSSOEnabled.js` — the recon's "keep" is still right, and the reason is unchanged

`simpleSSOLoginDisabled` and `simpleSSOLoginDisabledMiddleware` guard three live sites that
have nothing to do with token issuance:

- `system.js:237` — `POST /request-token`, refuses credential login when SSO is forced;
- `admin.js:271` — `POST /admin/invite/new`;
- `invite.js:35` — `POST /invite/:code`.

That is `SIMPLE_SSO_NO_LOGIN` — "force users through SSO", a policy an **OIDC** deployment
wants and which S1 does not replace. Delete only the `simpleSSOEnabled` export (the
issuance/exchange gate) and its two `SIMPLE_SSO_ENABLED` require sites.

Two consequences that follow and are easy to miss:

- **`SIMPLE_SSO_ENABLED` cannot be deleted from the env surface.**
  `simpleSSOLoginDisabled()` is `"SIMPLE_SSO_ENABLED" in process.env && "SIMPLE_SSO_NO_LOGIN" in process.env` —
  both, so removing the first silently disables the *surviving* feature. Only
  `SIMPLE_SSO_NO_LOGIN_REDIRECT` is unambiguously deletable from `updateENV.js`, and only
  after §7. Keep two of the three `.env.example` lines and re-comment them for what they now
  mean.
- **#58's ledger flagged `simpleSSOEnabled.js:22,66` as failing OPEN in shape (b)** and
  routed it here rather than changing it under two issues at once. Line 22 is inside the
  half being deleted, so it resolves itself. **Line 66 is inside `simpleSSOLoginDisabledMiddleware`,
  which survives** — it reads the raw setting, and in shape (b) applies the restriction less
  often than it should. #50 should fix it while it is in the file: `!(await isConfirmedSingleUser())`,
  exactly as #58's rulings A/B did. If PMO would rather not, it needs an owner, because #58's
  ledger recorded it as handed to #50.

## 6. `sso.issue` the permission — the part with real ordering risk

Ruling (A) removes the only route that asks for `sso.issue`. What to do with the *permission*
is a separate decision and the two are easy to conflate.

Facts on `bb7dd00b`:

- `permissions.js` lists it in `API_ACTIONS` (73), `ALL_ACTIONS` (111) and `setup_admin`'s
  list (121).
- `vocabulary-diff.test.js` asserts `ALL_ACTIONS.length === 62` **exactly** and carries
  `sso.issue` in a hand-maintained `approved` array.
- Two applied migrations name it: `20260902020000` INSERTs it into `permissions`, and
  `20260902045000` names it inside the JSON scope-list literal it backfills onto existing
  keys.
- `ADMIN_DEFAULT_SCOPES` and `SINGLE_USER_KEY_SCOPES` are *derived* from
  `Object.values(ROUTE_SCOPES)`, so removing the route entry removes `sso.issue` from both
  automatically. No edit needed, and three tests import those constants and will simply see
  a shorter list.

The risk is **existing API keys**. `045000` wrote `sso.issue` into the scope column of every
key it backfilled. Those rows keep it. `validateScopes` (`apiKeys.js:23`) rejects unknown
scopes **at creation**, and `parseScopes` does not re-validate at authentication time — so a
stale scope on an existing key is inert rather than fatal. Confirmed by reading both paths;
worth stating because "remove a permission" usually does break existing rows and here it does
not.

My recommendation: **remove `sso.issue` from `permissions.js` and the test's `approved`
array, decrement the count to 61, and add a NEW migration deleting the `permissions` row.**
Do not edit `020000` or `045000` — `_prisma_migrations` tracks by name and content; editing
an applied migration means a fresh database and an upgraded one disagree, which is exactly
the drift the slot discipline exists to prevent.

If PMO would rather keep the permission for S-series SSO to reuse, that is defensible — but
then it is a seeded permission no route asks for, and `vocabulary-diff`'s
`liveScopesFromSource()` walks for `requireScope(...)` rather than for `ROUTE_SCOPES`
membership, so nothing will notice. Either answer works; it needs to be **stated**, because
the silent version is a permission that outlives every reason for it.

## 7. Frontend — three more files, and one behaviour change to decide

The recon lists three frontend files. Following the imports gives five, and the last one is a
behaviour decision rather than a deletion:

- `main.jsx:11` imports `@/pages/Login/SSO/simple` — **that file must go too**.
- `paths.js:36` (`paths.sso.login()`) has exactly one caller: `Login/index.jsx:30`.
- `Login/index.jsx:25-30` is the SSO-forced redirect. It reads `useSimpleSSO()`, whose only
  consumer it is, and that hook reads `SimpleSSOEnabled` / `SimpleSSONoLogin` /
  `SimpleSSONoLoginRedirect` from `System.keys()` — which is `systemSettings.js:625-627`.

So `systemSettings.js:625-627` and `1137-1148` (`simpleSSO.noLoginRedirect`) are load-bearing
for the frontend redirect, not only for the deleted route. **The decision #50 must make
explicitly**: `SIMPLE_SSO_NO_LOGIN` survives on the backend (§5), so does its frontend
redirect survive too?

- **Keep it** → `useSimpleSSO.js`, `Login/index.jsx:25-30`, `paths.sso.login()` and all three
  settings keys stay; only `paths.sso.login()`'s *target* changes, since `/sso/simple` will
  404. It must point at the OIDC login start.
- **Drop it** → all five files go, and an operator running `SIMPLE_SSO_NO_LOGIN` finds
  credential login refused by the backend with no redirect to anywhere. That is a lockout.

Neither is wrong, but doing the deletion file-by-file without deciding produces the second
outcome by accident. This is the highest-risk item in the whole issue, and it is the one the
15-file list hides completely.

## 8. Order and conflicts

- The recon's blocker is cleared: #27 (`5cb44484`) is merged. `git log` shows no unmerged
  branch touching these files.
- **`endpoints/system.js` is the contended file.** #48's new SHA lands in it
  (`DELETE /system/credential/:envKey` near 654-690) and #58's `/request-token` guard is at
  353. #50 deletes 79-81 and 389-412 in the same file. Different hunks — a textual conflict is
  unlikely, but whichever lands second should re-read the require block at 79-81, since #48
  and #50 both edit imports at the top.
- `models/systemSettings.js` and `utils/helpers/updateENV.js` were held by t7 per the recon.
  Re-check before starting: if t7 is still open, §5/§7 touch both.

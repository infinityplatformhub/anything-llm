# #50 recon — delete simple-SSO

Lane B cleanup, split out of S1 by PMO ruling (2026-09-02). Base `approof/main` @ `3e97e538`.

S1 (#36) ships OIDC only. This issue removes what OIDC replaces. They were one PR until
the file list was measured: the deletion touches **15 files**, four of which S1's own
ruling forbids Dev3 from editing because `t7` and `pr4c` hold them.

## 0. Why this is a separate issue

R3 in the S1 recon reads as three things to delete — `/request-token/sso/simple`,
`ssoIssuanceLock`, `SIMPLE_SSO_ISSUE_UNSAFE_ALLOW`. The real surface is 15 files, and
the overlap is with branches that have not merged:

| file | held by |
|---|---|
| `frontend/src/models/system.js` | `t7` — and S1's ruling says "No frontend/src/models/system.js edits (reserved t7)" |
| `server/endpoints/system.js` | `t7` (7 hunks) **and** `pr4c` |
| `server/models/systemSettings.js` | `t7` |
| `server/utils/helpers/updateENV.js` | `t7` |
| `server/__tests__/ssoIssuanceLockHttp.test.js` | `pr4c` — deleting a file the other branch modifies is a delete/modify conflict git will not auto-resolve |

Nothing in OIDC depends on the deletion, so ordering it after the branches that hold
those files costs nothing and removes every conflict.

**Order: after #27 (PR-4c) and #31 (T-7) merge.** Not "after S1" — S1 and this are
independent once split; this one waits on the branches holding the files.

## 1. The 15 files

Measured with `git grep -ln 'sso/simple\|ssoIssuanceLock\|SIMPLE_SSO\|simpleSSOEnabled' -- server docker frontend`
on `3e97e538`. Re-run it on the merge candidate rather than trusting this list — #27 and
#31 land in between.

**Delete outright (4)**
- `server/utils/middleware/ssoIssuanceLock.js`
- `server/__tests__/utils/middleware/ssoIssuanceLock.test.js`
- `server/__tests__/endpoints/ssoIssuanceHotfix.test.js` — but see §2, the assertion moves rather than dies
- `server/__tests__/ssoIssuanceLockHttp.test.js`

**Edit (11)**
- `server/endpoints/api/userManagement/index.js` — drop `ssoIssuanceLock` and `simpleSSOEnabled` from the `/v1/users/:id/issue-auth-token` middleware array and both requires; drop the two `/sso/simple?token=` strings in the swagger docblock
- `server/endpoints/system.js` — delete the `GET /request-token/sso/simple` route (line 364-~400 on `3e97e538`) and the `simpleSSOEnabled` require. **Keep `simpleSSOLoginDisabled`** — see §3
- `server/utils/middleware/simpleSSOEnabled.js` — **not deleted**, see §3
- `server/models/systemSettings.js` — the `SIMPLE_SSO_ENABLED` / `SIMPLE_SSO_NO_LOGIN_REDIRECT` reads
- `server/utils/helpers/updateENV.js` — three keys at 1869-1871
- `server/.env.example`, `docker/.env.example` — three commented lines each (497-499 / 491-493)
- `server/swagger/openapi.json` — one `sso/simple` reference; regenerate rather than hand-edit
- `frontend/src/models/system.js` — the `request-token/sso/simple` fetch
- `frontend/src/main.jsx` — the `/sso/simple` route
- `frontend/src/utils/paths.js` — the `/sso/simple` path helper

## 2. The middleware-order assertion moves, it does not die

`server/__tests__/endpoints/ssoIssuanceHotfix.test.js:20` asserts:

```js
expect(route.middlewares[0]).toBe(ssoIssuanceLock);
```

That is not a test about the lock. It is a test that **the route's first middleware is
the one that refuses**, written when the lock was the refusing thing. Delete the lock
and the property still matters: after the deletion the array is
`[validApiKey(scopeFor("GET", "/v1/users/:id/issue-auth-token"))]`, and `validApiKey`
must stay first so an unauthenticated request never reaches anything that touches the
database.

Rewrite it, do not drop it:

```js
expect(route.middlewares).toHaveLength(1);
expect(route.middlewares[0].name).toBe("apiKeyRequired");
```

`validApiKey` is a factory (`validApiKey.js:101`) returning a **named** function
expression `apiKeyRequired` — so identity comparison against the export cannot work, but
the name can, and the name was given deliberately. Assert on the name.

Keep the second test in that file too, retargeted: a request with no `Authorization`
header is refused by `middlewares[0]` with `next` never called. Its current form asserts
403 from the lock; the same shape asserts 403 from `validApiKey`'s
`"No valid api key found."` branch. The point of both tests is that the refusal happens
**before** the handler, and that survives the deletion intact.

Rename the file — `ssoIssuanceHotfix.test.js` names a hotfix that no longer exists.
`server/__tests__/endpoints/issueAuthTokenWiring.test.js`.

## 3. `simpleSSOEnabled.js` is not deleted

The module exports three things, and only one of them is about issuance:

| export | used by | fate |
|---|---|---|
| `simpleSSOEnabled` | `endpoints/system.js` (the deleted route), `endpoints/api/userManagement/index.js` | goes with the route |
| `simpleSSOLoginDisabled` | `endpoints/system.js:213` | **stays** |
| `simpleSSOLoginDisabledMiddleware` | `endpoints/admin.js:186`, `endpoints/invite.js:35` | **stays** |

`SIMPLE_SSO_NO_LOGIN` is a different feature: it disables *password* login so an
operator can force users through SSO. That is exactly what an OIDC deployment wants, and
`endpoints/admin.js` and `endpoints/invite.js` guard on it today. Deleting the file takes
out the invite flow's protection along with it — silently, because nothing named
"issuance" is involved.

Delete the `simpleSSOEnabled` function and its two call sites. Leave the file, the other
two exports, and `SIMPLE_SSO_ENABLED` in `updateENV`'s allowlist, since
`simpleSSOLoginDisabled()` still reads it.

**This narrows the §1 list**: `SIMPLE_SSO_ENABLED` stays in `updateENV.js` and both
`.env.example`s. Only `SIMPLE_SSO_ISSUE_UNSAFE_ALLOW` (which is not in any `.env.example`
— it is undocumented on purpose) and the `SIMPLE_SSO_NO_LOGIN*` lines are in play, and
the `NO_LOGIN` ones stay too. Net: the `.env.example` edits may be **zero**. Check before
editing; a diff that removes a still-read env key is the failure this section exists to
prevent.

## 4. RED DoD

1. `GET /api/request-token/sso/simple?token=<valid>` returns 404, not 401 or 403 — the
   route is gone, not merely refusing. A 403 would mean `simpleSSOEnabled` is still
   mounted somewhere.
2. `GET /v1/users/:id/issue-auth-token` with a key holding `sso.issue` **succeeds**
   without `SIMPLE_SSO_ISSUE_UNSAFE_ALLOW` set. This is the point of the whole issue: the
   flag existed because the route was unscoped, and PR-4a scoped it.
3. Same route with a key **lacking** `sso.issue` returns 403. Delete the lock, keep the
   refusal.
4. Middleware-order test per §2 — `validApiKey` first, one entry, refusal before the
   handler.
5. Invite flow still refuses when `SIMPLE_SSO_ENABLED` + `SIMPLE_SSO_NO_LOGIN` are both
   set (`endpoints/invite.js:35`). This is the §3 regression test: it fails if
   `simpleSSOEnabled.js` was deleted wholesale.
6. `git grep -n 'sso/simple\|ssoIssuanceLock\|SIMPLE_SSO_ISSUE_UNSAFE_ALLOW'` returns
   nothing under `server/` and `frontend/` except `.env.example` comments that §3 keeps.
   This is the gate; run it, do not eyeball the diff.

Real Postgres, `migrate deploy` (code-standards §7.1a). No migration in this issue.

## 5. Collision

- **#27 / #31** — the reason for the ordering. After both merge, re-measure §1.
- **#36 (S1)** — none. S1 adds `endpoints/identity.js` and never touches these files.
- **frontend** — `main.jsx` and `paths.js` are untouched by every open branch; only
  `models/system.js` is contested, and only by `t7`.

## 6. Estimate

Half a day of deletion, plus §2 and §3 which are the parts that need thought. The risk
is not the work, it is deleting one export too many — §3 is the whole issue in miniature.

### PMO rulings (2026-09-02, supersede §1/§4 on issue-auth-token)
- Ruling: `GET /v1/users/:id/issue-auth-token` is removed with `/request-token/sso/simple`. The token it mints is only exchangeable at the simple route; OIDC uses `TemporaryAuthToken` in-process. A credential-minting endpoint with no exchange path is attack surface without a feature. T-4a's /v1 restriction covers live routes, not a route that `ssoIssuanceLock` has always closed.
- Ruling: remove `scopes.js` mapping + `sso.issue` from issuable scope lists; existing keys holding `sso.issue` stay valid for other routes (test).
- Ruling (a): `simpleSSOLoginDisabledMiddleware` raw-mode predicate (fail-open on shape (b)) → separate issue, not #50.
- Ruling (c): `yarn swagger` regenerated output committed with the removal.

# QA-3 evidence — #40 task 1 `a2bbb0de` — FAIL

Author: QA-3 (anything-llm-ea). Worktree `/tmp/qa3-40`, own `yarn install` +
`prisma generate`, own database `qa3_40`. A second worktree `/tmp/qa3-40base` at
the merge base (`d69a9382`) for the before/after comparison.

## BLOCKER — `singleUserRouteShapeB` now passes 17 routes to the SPA fallback

```
Tests: 2 failed, 34 passed, 36 total
```

Both failures are the same list of seventeen:

```
POST /system/update-password → 200
POST /system/generate-api-key → 200
DELETE /system/api-key/:id → 200
POST /telegram/connect → 200
… (17 in total, the whole of SINGLE_USER_ONLY_ROUTES)
```

On the merge base the same suite is **9/9 green**. So this is introduced here,
not pre-existing.

### What is actually happening

The suite changed how it mounts the router:

```js
- app._router = built.app._router;     // merge base
+ app.use(built.app._router);          // a2bbb0de
```

`index.js` mounts the API under a prefix — `app.use("/api", ipAllowlist,
apiRouter)` (`index.js:100`) — and also registers an SPA catch-all,
`app.use("/", …)` (`index.js:169`), which answers **200 text/html** for anything
unmatched.

Assigning `_router` replaced the test app's router wholesale, so paths resolved
as they do in `index.js`. Re-mounting it with `app.use` nests it one level down,
and the test's URLs — `${baseUrl}/system/update-password`, with no `/api` — no
longer reach the API router at all. They fall through to the SPA handler.

Proven directly, same process, same two URLs:

```
POST /system/update-password      -> 200  text/html          <- the SPA fallback
POST /api/system/update-password  -> 401  application/json   <- the real route, refusing
```

Adding the missing prefix makes the suite **36/36**:

```js
fetch(`${baseUrl}/api${url}`, …)
```

### Why this matters more than a broken test

The assertion is *"no single-user-only route answers 2xx to an ordinary
session"*. It is now satisfied — or rather violated — by an HTML page, not by
authorization. Had the routes been genuinely reachable and genuinely open, this
suite would report exactly the same seventeen lines. A test whose failure mode
and whose success mode both run through the SPA fallback cannot distinguish an
authorization regression from a routing typo.

Fix: prefix the URLs with `/api`, or keep the direct `_router` assignment. The
first is better — it exercises the mount `index.js` actually uses, including
`ipAllowlist`.

I checked the other three suites that interpolate `${baseUrl}${route}` without a
prefix (`chatReadOthers`, `impersonationWrites`, `routeWiring`): none of them
require `index.js`, they mount endpoint functions onto a bare express app, so
their unprefixed URLs are correct. `singleUserRouteShapeB` is the only one that
mounts the real router, and the only one affected.

## The rest of the lane

`routeGateSweep` (the wildcard identity exemption), `workspaceCapabilities` and
`apiRouteAuthSweep` are **86 passed** between them, with no failures. I have not
written up the wildcard-exemption and R-2 timing probes in detail because the
blocker above changes how the sweep's own router is built, and re-running them on
the fixed SHA is cheaper than reasoning about which results survive the fix.

What I did read, and what looks right:

- `isPermissionGate` / `isApiKeyGuard` use `Symbol.for`-keyed `WeakSet`s on
  `globalThis`, frozen with `writable: false, configurable: false`, and both
  files say plainly that this is test evidence rather than a security boundary.
  That is the honest framing — a registry a test consults is not a gate.
- The wildcard exemption is by **mounted layer identity** (`layer ===
  terminalWildcard`), not by path string, and `terminalWildcard` is additionally
  required to be the last layer and to consist only of `terminalNotFound`
  handlers. A second `*` route would fail `expect(wildcardRoutes).toHaveLength(1)`
  rather than being silently exempted too.

## Suites

| suite | result |
|---|---|
| `routeGateSweep` | pass |
| `workspaceCapabilities` | pass |
| `apiRouteAuthSweep` | pass |
| `singleUserRouteShapeB` | **2 failed / 36** |

Combined: 86 passed, 2 failed.

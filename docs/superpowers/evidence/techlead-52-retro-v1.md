# Techlead-1 — #52 retro: what the router sweep never saw

Asked after #40's bypass 6: `routeGateSweep.test.js` never mounted `developerEndpoints`, so the
`/v1` surface — 62 routes — was outside every sweep-derived conclusion in #52.

**Result: no hole. All 62 `/v1` routes carry `validApiKey`, all 37 mutating ones included.** Two #52
claims must be narrowed in wording; none is factually wrong about what it actually measured.

Enumerated by hand on `main` (`387a6152`, one commit past the `c81fcb75` named in the request — same
`/v1` surface; no endpoint file changed between them), mounting `developerEndpoints(app, router)`
directly rather than through the sweep helper.

## Why the sweep missed it

`buildRouter` matches registrations with `/^[a-zA-Z]+\(apiRouter\);$/gm`. Every mount in `index.js`
fits that shape **except one**:

```js
developerEndpoints(app, apiRouter);   // index.js:120 — two arguments
```

Two arguments, so the regex does not match, so the name never enters `registrations`, so the module is
never required and never mounted — and because it was never in `registrations`, it never appeared in
`skipped` either. The sweep reported a complete run while 62 routes were invisible. Not a failure of
the guard I reviewed in #40 (`skipped` empty, `registrations === 31`): both were true and both stayed
green, because the route was never a candidate.

That is the same class as #40's bypass 6 and worth naming: a line-shape regex silently *narrows the
population* rather than failing. `registrations.length === 31` pins the count of what the regex found,
not the count of what `index.js` mounts.

## The measurement

Mounted `developerEndpoints(app, router)` on a bare express router and read `router.stack` directly —
no helper, no grep.

```
total /v1 routes                       62
mutating (POST/PUT/PATCH/DELETE)       37
mutating without validApiKey            0
any route without validApiKey           0
guarded but carrying no .scope          0
```

Every one of the 62 has `apiKeyRequired` as its **first** middleware, confirmed two independent ways:
`handle.isApiKeyGuard === true` (the property `validApiKey` stamps) and the middleware function name.
Every route also carries a `.scope`, across 33 distinct actions.

The 37 mutating routes and their declared scopes:

| method | route | scope |
|---|---|---|
| POST | `/v1/admin/invite/new` | invite.create |
| DELETE | `/v1/admin/invite/:id` | invite.delete |
| POST | `/v1/admin/preferences` | system.write |
| POST | `/v1/admin/users/new` | user.write |
| POST, DELETE | `/v1/admin/users/:id` | user.write |
| POST | `/v1/admin/workspace-chats` | chat.read_others |
| POST | `/v1/admin/workspaces/:workspaceId/update-users` | workspace.members.manage |
| POST | `/v1/admin/workspaces/:workspaceSlug/manage-users` | workspace.members.manage |
| POST | `/v1/document/create-folder`, `/move-files` | document.folder.manage |
| DELETE | `/v1/document/remove-folder` | document.folder.manage |
| POST | `/v1/document/raw-text`, `/upload`, `/upload-link`, `/upload/:folderName` | document.write |
| POST | `/v1/embed/new` | embed.create |
| POST | `/v1/embed/:embedUuid` | embed.write |
| DELETE | `/v1/embed/:embedUuid` | embed.delete |
| POST | `/v1/openai/chat/completions` | chat.write |
| POST | `/v1/openai/embeddings` | embedding.compute |
| POST | `/v1/openai/images/generations` | image.generate |
| DELETE | `/v1/system/remove-documents` | document.delete |
| POST | `/v1/system/update-env` | system.write |
| POST | `/v1/workspace/new` | workspace.create |
| DELETE | `/v1/workspace/:slug` | workspace.delete |
| POST | `/v1/workspace/:slug/update` | workspace.write |
| POST | `/v1/workspace/:slug/chat`, `/stream-chat` | chat.write |
| POST | `/v1/workspace/:slug/thread/new` | thread.create |
| POST | `/v1/workspace/:slug/thread/:threadSlug/update` | thread.write |
| DELETE | `/v1/workspace/:slug/thread/:threadSlug` | thread.delete |
| POST | `/v1/workspace/:slug/thread/:threadSlug/chat`, `/stream-chat` | chat.write |
| POST | `/v1/workspace/:slug/update-embeddings` | workspace.embeddings.manage |
| POST | `/v1/workspace/:slug/update-pin` | document.pin |
| POST | `/v1/workspace/:slug/vector-search` | document.search |

**No hotfix needed.**

## The #52 claims to narrow

Neither is false about what it measured; both are stated in language that reads as covering the whole
API, and that reading is what bypass 6 invalidates.

**Issue #52, ruling at comment 27** — *"`routeGateSweep.test.js` enumerates `app._router.stack` after
mounting every module `index.js` mounts, never greps source."* The second half is the part to fix:
it mounts every module whose registration matches a one-line, one-argument shape. `developerEndpoints`
is neither. The ruling's *argument* is unaffected — a router sweep still beats a grep, and it was
right that sweeping four modules found 6 ungated routes where the fuller router found 20.

**Issue #52, ruling at comment 28** — *"the sweep asserts it actually mounted something (>20
registrations, >100 routes, at most one skip)."* True and useful, and it cannot detect this: the
thresholds are satisfied by the 31 modules the regex does find. A guard on the *lower bound* of a
population cannot see a population that was silently narrowed at the top.

**Not affected**, because they are claims about session-authenticated routes and `/v1` carries no
session at all:

- "no mutating route carries `validatedRequest` alone" — `/v1` routes carry `validApiKey`, never
  `validatedRequest`, so they were never in scope for this assertion. Verified: none of the 62 has
  `validatedRequest` in its stack.
- `SINGLE_USER_ONLY_ROUTES` (17) and `SELF_SERVICE_ROUTES` — both enumerate session routes.
- QA-2's addendum 3/7 probes fired real impersonated **JWTs**; an impersonated JWT is not an API key
  and cannot reach `/v1`.
- The `#53` assertions inside the same file (`org.member` never paired with a workspace resolver;
  `chat.send` on exactly three routes) read `handler.handle.action`, which is `requirePermission`'s
  property. `/v1` gates are `validApiKey`, which stamps `.scope` instead — so those two assertions
  were never about `/v1`, and their `checked >= 4` guard is unaffected.

The `chat.send` assertion is worth one extra note: it asserts an exact three-route list. Had
`developerEndpoints` been mounted, `/v1` routes would still not have appeared (no `.action`), so that
list is correct as written and does not change when the sweep is fixed.

## Recommendation

When Dev2's #40 SHA lands, `buildRouter` should assert the registration count against what `index.js`
actually mounts rather than against a regex's yield — count `(apiRouter)` occurrences, or accept the
two-argument form and mount `developerEndpoints(app, apiRouter)`. Fixing the regex alone would raise
the count to 32 and leave the next differently-shaped mount invisible in the same way.

## What I did not do
Did not run the suite (§7.14). The table above comes from mounting `developerEndpoints` under node 22
and reading the router stack, plus reading `index.js` and the sweep helper. Nothing was written to any
worktree.

# Ledger — #25 T-4a route wiring

Base: `d7f92baf` (approof/main). Branch `approof/t4a-route-wiring`. DB `approofworkspace_t4a`.

## Recount on the real base (recon said `731e4c1d`)

| Symbol | Files | Occurrences |
|---|---|---|
| `flexUserRoleValid` | 27 | 176 |
| `strictMultiUserRoleValid` | 2 | 18 |
| `ROLES.` | 30 | 185 |

Unchanged from the recon's numbers — `d7f92baf` added no new role-gated routes.

## Scope carved by PMO rulings after the recon

Ruling: T-4a does NOT touch `server/utils/authorization/actorResolver.js` — T-3 (#22) owns it for the B-2 membership derivation. The recon assigned it to T-4a; PMO reassigned. If wrong, the B-1 api-key derivation has no home and T-4b inherits it.
Ruling: T-4a does NOT touch `server/utils/chats/commands/img.js` — T-5 collision, PMO deferred. The `ROLES.`-free role literal at `:55` therefore survives this branch; the grep gate is scoped to T-4a's file set, not the whole repo. If wrong, a role-string check outlives the middleware deletion.
Ruling: T-4a does NOT touch `server/endpoints/api/**` or `server/utils/apiKeySecurity/scopes.js` — Dev1 #26 (PR-4b) owns them. S-9's ingress half is therefore proven at the engine/derivation layer, not on a `/v1` route. If wrong, the `/v1` scope-vs-grant proof lands in T-4b instead.
Ruling: W-5 (`ActorIdentityStore` merge) moved to T-4b by PMO. If wrong, two Actor construction sites coexist one issue longer.

## Rulings from the Techlead forecast (PMO, 2026-09-02)

Ruling: T-4a also owns `endpoints/experimental/imported-agent-plugins.js`, `endpoints/extensions/index.js`, `endpoints/mobile/index.js` — they hold `flexUserRoleValid` call sites (3+8+4 by count) and W-1 deletes the module, so leaving them breaks boot. If wrong, the server fails to start after the middleware deletion.
Ruling: T-4a also owns `endpoints/mobile/utils/index.js` (6 `getWithUser`/`whereWithUser` callers) and `utils/middleware/validWorkspace.js` (2) — W-2 changes what those functions return, so their callers change with them. If wrong, non-member admins get 404 on paths that should reach the engine.
Ruling: `utils/helpers/search.js:35` stays T-5's file and is NOT edited here, even though W-2 changes `whereWithUser`'s semantics underneath it. The change is behavioural, not textual: search stops returning non-member workspaces for managers, which is the intended fix. Recorded so T-5 is not surprised by a behaviour change with no diff in its own file. If wrong, search silently narrows before T-5 expects it.
Ruling: W-4 (`grants(creator) ∩ scopes(key)`) is implemented in `utils/authorization/engine.js`, NOT in `utils/middleware/validApiKey.js`. `validApiKey` already writes `locals.apiKeyContext = {keyId, scopes, ...}` and does its own scope 403; the resolver already mints `api-key:<keyId>`; the engine has `api_keys` in scope through prisma and can read `createdBy` itself. No edit to `validApiKey.js` is required, so no `pr4b-1` merge dependency. If wrong — if the derivation turns out to need something the context does not carry — this becomes a hard dependency on Dev1's #26 and T-4a stalls.

## Carries received from T-3 (#22 HEAD `f5bf914f`)

- `readableWorkspaceIds` no longer reads `actor.workspaceIds`. Scope comes from grants + `workspace_users` only. T-4a may therefore set `locals.userWorkspaceIds` from the request without opening a cross-workspace hole — the value affects the cache key, not the scope.
- `policyVersion` is a **string**, not BigInt. Routes echoing a filter need no conversion; `JSON.stringify` no longer throws.

## RED proof on base `d7f92baf` (Node 22)

`routeWiring.test.js` — 6 failed, 1 passed:
- S-1 non-member manager by slug: Expected 404, Received 200
- S-2 `whereWithUser` scope: Expected [W1], Received [W1, W2]
- S-3 chat in a non-member workspace: Expected 404, Received 200
- S-9 ingress api-key ceiling: Expected false, Received true
- B-1 api-key with creator grant: Expected true, Received false (`no_grants`)
- W-6 `authorizeMany` 501: resolved instead of rejecting
- S-3 regression (thread ids, green today): PASSED — kept as a guard, not a RED

`t4aRouteIdor.test.js` — 1 failed:
- G11 legacy `role === "admin"` without an org-wide grant: Expected 403, Received 200

Ruling: the implementer's first S-3 case (`PUT /workspace/workspace-chats/:id` with a chat the actor owns) was a **false RED** — the fixture had the manager editing their own chat and the route carries no workspace slug, so 200 was correct behaviour. Replaced with a chat the actor owns inside a workspace they are NOT a member of, which is the real gap: the lookup is `(id, user_id)` and never consults membership. If wrong, S-3 would have been "fixed" by breaking a legitimate route.
Ruling: rejected a test-only `require("buffer").SlowBuffer = require("buffer").Buffer` shim added to work around `jsonwebtoken@9.0.2` failing to load on Node 26. Monkey-patching a core module inside a Jest worker changes behaviour for every module in that worker and hides a real incompatibility. Tests run on Node 22 (`/opt/homebrew/opt/node@22/bin`), where the dependency loads unpatched. If wrong, the suites need a Node 26 story before this branch can run in CI.

## GREEN rulings

Ruling: `AuthorizationUnavailableError` maps to **503**, not 403. A policy-store outage must read as an outage; answering "no permissions" would send operators looking for a missing grant that was never the problem. PMO approved. If wrong, a store outage looks like a normal denial to every caller.
Ruling: `requirePermission` is mocked pass-through in the two mock-prisma guard suites (`removeAndUnembedHttp.test.js`, `t4aRouteIdor.test.js`). Those suites exercise the purge GUARD; the GATE is proven end-to-end against real Postgres in `routeWiring.test.js`. Without the mock they returned 503 — the engine correctly reporting that a mocked prisma has no policy tables. If wrong, the gate's route-level behaviour is only covered in one suite.
Ruling: replaced the guard's `user.role === "admin"` shortcut with an `orgWideDocumentDelete` argument the route computes from a second engine decision (`document.delete`, `workspaceId: null`). Deleting the shortcut outright broke a legitimate capability — a real positive-control test caught it — because purging is system-wide and someone must be able to do it. Passing the capability in keeps the behaviour while making it revocable: revoking the org-wide grant now revokes the purge, which a role string could not express. If wrong, cross-workspace purge needs a distinct action name rather than an org-wide scope of `document.delete`.
Ruling: rewrote `removeAndUnembedHttp.test.js`'s "admin (non-member) still purges" positive control to assert 403 instead of 200, renamed to say why. The contract changed deliberately: inside that suite the gate is mocked away, so a legacy admin reaching the guard alone must now be refused. Renamed rather than deleted — the case still pins real behaviour, just the opposite outcome. If wrong, a genuine admin-purge regression could hide behind the rename.

## B-1 handed to T-4b (PMO ruling, 2026-09-02)

Ruling: removed the B-1 derivation from `engine.js` — `API_KEY_PRINCIPAL`, `scopeAllows`, `creatorPrincipal`, and the `evaluateGrants` split. Both T-4a and T-4b implemented `grants(creator) INTERSECT scopes(key)` with different designs and PMO chose T-4b's (the resolver attaches `grantPrincipal`; the engine only reads it). W-6's `MAX_BATCH_RESOURCES` cap stays here. If wrong, `/v1` has no api-key grant path until T-4b merges — which is exactly the window the ruling accepts, since T-4a no longer owns `/v1`.
Ruling: the S-9-ingress and B-1 tests are preserved verbatim in `.infi/recon/t4b-b1-tests-handoff.js` and handed to Dev4 rather than deleted. They are the acceptance bar for whichever design ships, and a moved test that nobody re-arms is a deleted test. If wrong, T-4b ships the intersection with no proof that a key can neither exceed nor lose its creator's permissions.

## Carries — narrowing, not holes (recorded, deliberately not fixed here)

`Workspace.whereWithUser` lost its role bypass, so every caller of it now sees membership only. Two places narrow as a result:
- `endpoints/agentFileServer.js:174` (`findInWorkspaceChats`) — a caller holding org-wide `workspace.read` but no membership passes the gate and then finds no source.
- `utils/helpers/search.js:35` — T-5's file, untouched by ruling; same narrowing with no diff of its own.

Ruling: left as-is. Both fail CLOSED (fewer results, never more), which is the correct direction to be wrong in while the grant-aware list query does not exist yet. Fixing them properly means teaching `whereWithUser` to union membership with grant-visible workspaces, which needs the engine in the model layer — the layering T-4a exists to remove. If wrong, org-wide grant holders see an incomplete file/search list until a grant-aware list lands.

## Middleware deletion (W-1) — what came out of it

Ruling: `multiUserProtected.js` is deleted, but three things in it were not role gates and were salvaged rather than dropped:
- `isMultiUserSetup` / `isSingleUserMode` → `utils/middleware/deploymentMode.js`. They answer "which shape is this deployment", which some routes legitimately need. Kept apart from the engine so that question can never again be mistaken for "may this caller do this" — which is precisely how `flexUserRoleValid` grew its bypass.
- `ROLES` values → `utils/legacyRoles.js`, consumed only by `helpers/admin/index.js` for role ASSIGNMENT validation (which legacy role string an admin may write onto another user). That is data validation, not an access decision, and R4 keeps `users.role` frozen rather than dropped. Kept in a separate module so nothing can import a role list and a bypass from the same file again.
If wrong, `deploymentMode` becomes a second place people reach for when they mean authorization.

Ruling: three model-layer bypasses became caller-supplied capabilities rather than disappearing.
- `BrowserExtensionApiKey.whereWithUser` took `user.role === "admin"` → now takes `orgWideKeyManage`, computed by the route from a `key.manage` decision.
- `User.canSendChat` exempted admins from the daily quota → now takes `exemptFromLimit`, computed from `system.write`. The quota is not an authorization decision, but who is exempt from it is.
- `websocket.js` `userCanToggleTools` compared `user.role` → now asks the engine directly, because the agent runtime has no request to hang middleware on.
In each case the behaviour is preserved and becomes revocable: revoking the grant revokes the capability, which a role string could not express. If wrong, these three need distinct action names rather than borrowing `key.manage` / `system.write`.

Ruling: `img.js:55` (`user.role === "admin"`) is the ONE live role literal left in the tree. It is T-5's file by PMO ruling and is deliberately untouched. If wrong, a role-string check outlives the middleware deletion until T-5 lands.

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

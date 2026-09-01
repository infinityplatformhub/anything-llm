# T-4a plan — wire `assertAuthorized` into routes (#25)

Base `d7f92baf`. Branch `approof/t4a-route-wiring`.

## Design

**Ingress shape.** Routes stop naming roles and start naming actions:
```
flexUserRoleValid([ROLES.admin, ROLES.manager])   →   requirePermission("workspace.update", fromWorkspaceSlug)
```
`requirePermission(action, resourceResolver)` is a new middleware in
`server/utils/middleware/requirePermission.js`. It calls `resolveActor(request, response)`
(read-only use — T-3 owns that file) and `engine.assertAuthorized`. It never decides
anything itself: no role strings, no multi-user branch.

`resourceResolver` maps the request to `{type, id, orgId, workspaceId}`. Resolvers live
beside the middleware, not inline in routes, so the "workspaceId comes from the row, not
the body" rule (B-3) is enforceable by reading one file.

**Where B-1 lives.** PMO reassigned `actorResolver.js` to T-3 and `/v1` to Dev1 (#26), so
the api-key grant derivation cannot go in either. It goes in `engine.js` (T-2's file,
merged): `evaluate()` maps a `api-key:<keyId>` service principal to its creator's grants
and intersects the decision with the key's scopes. That is also the correct layer — the
resolver normalizes identity, the engine decides.

**Bypass removal.** `Workspace.getWithUser` / `whereWithUser` lose their role branch and
become pure membership queries. Non-member admins keep cross-workspace access through an
org-wide grant, evaluated by the engine at the route — not by a role string in the model.
`validWorkspaceSlug` therefore has to look the workspace up unconditionally and let
`requirePermission` decide, or a non-member admin would get a 404 before the engine runs.

**404 vs 403 (S-1).** A denied workspace read returns 404. `AuthorizationDeniedError`
carries the reason; the route layer maps `no_grants` on a workspace resource to 404 so
existence does not leak, and everything else to 403.

## Steps

1. RED tests: S-1, S-2, S-3, S-9 ingress, G11, B-1 regression, W-6 cap. Prove red on `d7f92baf`.
2. `engine.js`: api-key creator derivation (B-1) + `authorizeMany` cap 500 (W-6).
3. `requirePermission` middleware + resource resolvers.
4. `models/workspace.js`: delete both role branches; `validWorkspace.js` reworked.
5. Route sweep: 22 files, 176 `flexUserRoleValid` + 18 `strictMultiUserRoleValid` invocations.
6. `models/user.js`, `models/browserExtensionApiKey.js`, `utils/helpers/admin/index.js`,
   `utils/agents/aibitat/plugins/websocket.js` bypasses.
7. Delete `multiUserProtected.js`. Grep gates green for T-4a's file set.

## Out of scope (PMO rulings, recorded in the ledger)

`utils/authorization/actorResolver.js` (T-3) · `utils/chats/commands/img.js` (T-5) ·
`endpoints/api/**` and `utils/apiKeySecurity/scopes.js` (Dev1 #26) · W-5 `ActorIdentityStore` (T-4b).

# P0-5 T-2 — Actor resolver detail

Status: **awaiting architect (anything-llm-8b) review + #4/#5 merge.** No runtime code written.
Fulfills: seam 02 `Actor` typedef as the single ingress-normalized identity; PMO ruling "actor resolver กลางครบ 6 identity types เข้า T-2 DoD"; R5 single-user principal.

## 1. Ingress inventory (verified against code)

| # | Ingress | Anchor | Identity today | Writes | Notes |
|---|---|---|---|---|---|
| 1 | Session JWT (multi-user) | `utils/middleware/validatedRequest.js:9-11,44-85` (`decodeJWT`, encrypted `p` payload) + `userFromSession` | full user row reloaded per request | `response.locals.user` | suspension re-checked each request |
| 2 | Session JWT (single-user) | same file; `SystemSettings.isMultiUserMode()` gate at `:9-10` | synthetic/default user | `locals.user` may be null | today `flexUserRoleValid:69-73` skips all checks — the R5 hole |
| 3 | P0-4 scoped API key | `utils/middleware/validApiKey.js:4-24` → P0-4 Step 2 builds seam-02 `Actor` (`type:"service"`, `scopedKeyId`) | service actor with scopes | `locals` (per P0-4) | consumes this contract unchanged |
| 4 | Browser-extension key | `utils/middleware/validBrowserExtensionApiKey.js:20-48` | resolves a real user row | `locals.user` | maps to `Actor{type:"user"}` + `scopedKeyId` provenance so it can never outrank the key's grant (S-9) |
| 5 | Mobile device token | `endpoints/mobile/middleware/index.js:12-37` | approved device → user | `locals` | `Actor{type:"user"}` + device id in attributes |
| 6 | Embed config | `utils/middleware/embedMiddleware.js:9-20` (`validEmbedConfig`) | anonymous config, **no user** | `locals.embedConfig` | `Actor{type:"embed", id:embed.uuid}` — never null-actor: scope absent ⇒ `matchNone` filter, not deny-by-absence at ingress |
| 7 | SSO temp token | `endpoints/api/userManagement/index.js:67` issue + `models/temporaryAuthToken.js:69-100` single-use exchange | becomes a session JWT (row 1) | n/a | exchange path inherits row 1; issuance itself gated by `sso.issue` (P0-4) |
| 8 | Agent runtime | `utils/agents/index.js:88,516-517` — `invocation.user_id \|\| null`; nullable from the source (`models/workspaceAgentInvocation.js:22,29` defaults `user = null`) | **nullable** user ref | invocation | resolver maps null → deny on all but explicitly anonymous-capable actions |
| 9 | Background jobs | `jobs/embedding-worker.js`, `jobs/sync-watched-documents.js`, `jobs/handle-telegram-chat.js:32` | **none** — bare `Workspace.get({slug})` | none | must run as `Actor{type:"service"}` with explicit narrow grants (seam 02 boundary) |
| 10 | Telegram channel | chat state → `workspaceSlug`, no user binding | none | none | channel actor: `Actor{type:"service"}` scoped to the bound workspace until S4/V2 adds real user binding |
| 11 | Unauthenticated routes | `endpoints/api/system/index.js:16` (`env-dump`, PR to P0-4) | none | none | null actor ⇒ deny everywhere; only auth routes intentionally allow null |

## 2. Resolver contract

```js
// server/utils/authorization/actorResolver.js  (lands in T-2)
/**
 * Single normalization point. Called by validatedRequest (and each ingress
 * above) after its own auth check. Never performs authentication — only
 * maps an authenticated/anonymous ingress to a seam-02 Actor.
 * @returns {Promise<Actor|null>} null ONLY when no ingress authenticated anything.
 */
async function resolveActor(request, response) {}
```

- Writes `response.locals.actor`; every existing ingress keeps its current `locals.user`/`embedConfig` writes for backward compat until T-4a/T-4b delete them.
- **`authorize()` never receives a null actor silently**: `assertAuthorized({actor:null, ...})` → denied, reason `"missing_actor"`. Callers must not pre-check actor themselves — the engine IS the default-deny point; a caller-side `if (!actor) return 401` would recreate the two-defaults bug.
- Impersonation (`view-as-user`, T-7): resolver stamps `impersonatedBy` from a signed session claim — immutable from the moment the actor is built; engine denies all mutations before policy lookup (seam 02).

## 3. Single-user principal (R5)

`resolveActor` when `!SystemSettings.isMultiUserMode()`:

```js
const SINGLE_USER_PRINCIPAL = { type: "service", id: "single-user", orgId: 1 };
// seeded grant: principal_role_grants { principal_type:"service", principal_id:<hash or string id>, role: super_admin }
```

- Architect ruling (2026-09-02): **never an integer sentinel in the user-id namespace** — `users.id` autoincrement starts at 1 but nothing contractually forbids a future `id=0` row, and `explainAccess` joining `users` for a virtual id returns "user (unknown)" where the true answer is "system is in single-user mode". Chosen option: `type:"service"` in both the Actor and the DB principal — direct grant lookup, no user-row join, no mapping layer between `Actor.type` and `principal_type`.
- **The engine evaluates it like any principal** (matrix conformance covers it). DoD sentence: no code path anywhere branches on "not multi-user ⇒ allow".
- Seeded grants are the `super_admin` role_permissions, so admin-duty splits (T-7) apply to single-user mode too, and T-7 can revoke from it like any principal.

## 2b. Denial → HTTP status (decided here, consumed by T-4a/T-4b)

`AuthorizationDeniedError` maps to exactly one status per denial shape — callers never re-decide:
- **404** when the decision is resource-scoped (existence must not leak): workspace/document/thread lookups.
- **403** when action-scoped on a resource the caller already legitimately knows exists (their own workspace, admin duties).
- `AuthorizationUnavailableError` ⇒ 503 fail-closed, never a partial allow.

Today's middleware already splits both ways by accident (`multiUserProtected.js:18,40,48,82` return 401; `:91` returns 403) — the engine replaces all of it with this one table.

## 4. Tests (extend T-2 DoD)

- One resolver unit test per ingress row 1–11: correct `Actor` shape, provenance fields (`scopedKeyId`, `impersonatedBy`) absent unless applicable.
- Null actor through `assertAuthorized` → denied `missing_actor` (S-4 base).
- **Resolver store failure fails closed**: grant lookup throwing must surface as `AuthorizationUnavailableError` (503), never as a valid-but-grantless Actor that reads as "user with no permissions".
- Single-user principal: unknown action denied (already in T-2 DoD) **and** `chat.read_others` denial applies when T-7 removes it from the role — proves single-user isn't secretly exempt.
- Agent runtime `user_id:null` → resolver yields null (not a synthetic user) — agent actions then require an explicit service actor (row 8/9 rule).
- Post-T-4 grep DoD: no `if (!actor)` / `if (!user) return 401` remains in any endpoint — the engine is the only default-deny point (today's five 401 sites in `multiUserProtected.js:18,40,48,82` + `:91` 403 must all be gone).

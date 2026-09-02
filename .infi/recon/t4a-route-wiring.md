# T-4a recon — route wiring for `assertAuthorized`

Author: Dev 2 (Authorization Architect). Date: 2026-09-02. **Read-only recon — no runtime code written.**
Base: `main 731e4c1d`. Deps merged: **T-2 `323b2256`** (engine + resolver + policyRepository), **T-1** (`20260902020000_t1_authz_schema`), **PR-4a** (`validApiKey(action, binding)`).
Sources: `docs/superpowers/design/p0-5-authorization-recon.md` §3 (T-4a/T-4b split at :377-380), §4 (S-tests), §5c (G7/G11) · seam `02-authorization-engine.md`.

---

## 0. Blockers found during recon (must be answered before the issue opens)

| # | Finding | Why it blocks | Proposed resolution |
|---|---|---|---|
| **B-1** (PMO: derive, accepted) | **No principal grants exist for `api-key:<id>` service actors.** `actorResolver.js:39` mints `id: "api-key:${ctx.keyId}"`, but the T-1 seed (`prisma/seeds/permissions.js`) and the migration seed only `user` principals + the two service principals (`single-user`, `core-jobs`). `engine.evaluate` therefore returns **`no_grants` for every scoped-key request**. | Wiring `assertAuthorized` on any `/v1` route today turns every API key into a hard 403. T-4a owns internal routes, but the same resolver path is shared. | Grants for a key are **derived from its creator**, not stored: engine resolves `api-key:<id>` → `api_keys.createdBy` → that user's grants, then **intersects with `ctx.scopes`**. Needs a T-4a-owned resolver change (see §3 W-4) + a `api_keys.createdBy` backfill check (nullable today, `schema.prisma:20`). |
| **B-2** (PMO: T-3 derives; impersonatedBy → T-7) | `actorResolver` reads `locals.userWorkspaceIds` and `locals.impersonatedBy` — **nothing in the codebase writes either** (verified: only the resolver and its tests reference them). Every user Actor currently carries `workspaceIds: []`. | S-1/S-2 (workspace membership) cannot pass: the engine's `workspaceScope` uses `resource.workspaceId`, not the actor's, so this is not fatal for the engine — but T-3's `documentFilter` consumes `actor.workspaceIds` and will match-none everything. | T-4a populates `locals.userWorkspaceIds` in the JWT middleware (`validatedRequest`) from `workspace_users`. One query, cached per request. |
| **B-3** (PMO: accepted) | Vocabulary gap for G11. Seed has `document.delete` but the destructive route also purges **outside the workspace**. There is no action distinguishing "remove from this workspace" from "purge the file". | Without it T-4a has nothing to pass for the destructive half; see §5c ruling that G11 is what forced document CRUD into the vocabulary. | Reuse `document.delete` with `resource.workspaceId` **derived from the document row, never from the request body**. No new action. Recorded so T-4a does not invent one. |

B-1 and B-2 are wiring work inside T-4a's own file set. B-3 is a decision, already resolved above.

---

## 1. Scope

T-4a = **internal routes + models + bypass removal**. `/v1`, jobs, embed channels, agents are T-4b.

Recounted on `731e4c1d` (no truncation):

| Symbol | Files | Occurrences |
|---|---|---|
| `flexUserRoleValid` | 27 | 176 |
| `strictMultiUserRoleValid` | 2 | 18 |
| `ROLES.` | 30 | 185 |

(Higher than the recon note's earlier count because P0-3/P0-4 added route files. Counts include test files and the middleware itself.)

## 2. Owner files (disjoint from T-4b / T-5 / T-7)

- `server/utils/middleware/multiUserProtected.js` — **deleted**
- `server/utils/middleware/validatedRequest.js` — populate `locals.userWorkspaceIds` (B-2)
- `server/endpoints/*.js` — 22 top-level route files (**not** `endpoints/api/**`, `endpoints/embed/**` → T-4b)
- `server/models/workspace.js` — bypasses at `:299`, `:425`
- `server/models/user.js`, `server/models/browserExtensionApiKey.js` — bypasses
- `server/utils/chats/commands/img.js:55`, `server/utils/helpers/admin/index.js:10-44` (G7)
- `server/utils/authorization/actorResolver.js` — B-1 derivation + merge of `ActorIdentityStore` (§3 W-5)
- `server/utils/jobs/ActorIdentityStore.js` — **deleted**; `JobRuntime.js:4,12` + `CoreJobWorker.js:14` rewired
- New tests under `server/__tests__/security/authorization/`

Collision check: T-4b owns `endpoints/api/**`, `endpoints/embed/**`, `jobs/**`, `utils/agents/**`, `utils/telegramBot/**`. T-5 owns `utils/chats/**` *except* `commands/img.js` (a role-literal site, not a search call site) — **narrow overlap, call it out in both issues**. T-7 creates only new files.

## 3. Work items

**W-1 — Delete both middlewares.** No feature flag, no dual-run (A-R3). Each route gets `assertAuthorized({ actor, action, resource })` with the actor from `resolveActor(request, response)`.

**W-2 — Remove model-layer bypasses.** `workspace.js:299` and `:425` (`[ROLES.admin, ROLES.manager].includes(user.role)` → `this.get(clause)`) are the live IDOR. `getWithUser` must not decide access; the decision moves to the route. Membership stays a data filter.

**W-3 — Single-user mode.** Nothing to delete: R5 closed it in T-2 (resolver yields the `single-user` service principal). T-4a only removes the `if (!multiUserMode) next()` shape along with the middleware.

**W-4 — apiKeyContext scope-vs-grant.** Effective permission = **grants(creator) ∩ scopes(key)**. Deny if either side denies; `no_grants` when `createdBy` is NULL (old keys) — surfaced as a startup report, not a silent 403. PR-4a's `validApiKey` stays raw-only (ruling upheld): it keeps writing `locals.apiKeyContext` and doing its own scope 403; the engine adds the grant half.

**W-5 — Merge `ActorIdentityStore.resolveActor` into `actorResolver`. → MOVED TO T-4b (PMO ruling, to hold 5d).** Today it is the second Actor construction site (`utils/jobs/ActorIdentityStore.js:4`), it spreads the full `user` row into the Actor, hardcodes `workspaceIds: []`, and **never stamps `impersonatedBy`** — the exact path the single-construction-site rule exists to prevent. Export `resolveActorRef(actorRef)` from `actorResolver` for the job runtime; delete the class.

**W-6 — `authorizeMany` batch cap 500.** `engine.js:94-99` currently `Promise.all`s an unbounded array and issues 3 queries per resource. Add a contract cap: >500 resources → `AuthorizationContractError`. (Cap only; batching the queries is an optimization, not T-4a scope.)

**W-7 — G11.** `DELETE /workspace/:slug/remove-and-unembed` (`endpoints/workspaces.js`) must resolve the document row first and authorize against **its** `workspaceId`, ignoring caller-supplied `documentLocation`.

## 4. RED tests (DoD)

Every one must fail on `731e4c1d` before the fix lands.

- **S-1** non-member requests a workspace by slug → **404**, not 403 (no existence leak). Targets `workspace.js:299`.
- **S-2** `whereWithUser` returns only member workspaces for every role except `super_admin`. Targets `workspace.js:425`.
- **S-3** thread/document/chat ids from workspace A used against workspace B's endpoints → denied for all 4 verbs.
- **S-9** a scoped key cannot exceed its creator's permissions even with a broader role attached. *(Repository-side half already green in T-2 `engine.test.js:181`; the ingress half is W-4.)*
- **G11-attack** `remove-and-unembed` with a `documentLocation` belonging to another workspace → denied, file still present.
- **B-1 regression** a request on a valid API key whose creator holds the right grant → **allowed** (proves keys are not universally 403'd).
- **B-2 regression** `locals.userWorkspaceIds` is populated for a JWT session (asserts the field is written, not just read).
- **W-6** `authorizeMany` with 501 resources throws `AuthorizationContractError`; 500 succeeds.
- **grep gates**: `grep -rn "ROLES\." server --include='*.js' | grep -v node_modules | grep -v utils/authorization/` → 0 for T-4a's file set; `flexUserRoleValid` / `strictMultiUserRoleValid` do not exist; `ActorIdentityStore` has no references.

Plus: every P0-3 route test still green.

## 5. Migration slot

**None required.** T-1's `20260902020000_t1_authz_schema` already carries the tables. B-1's derivation is resolver logic, not schema. *If* PMO instead rules that api-key principals get their own stored grants, T-4a needs slot **`20260902040000`** (next free after `20260902031000_browser_key_digest`) to seed them — recommended against: derived grants cannot drift from the creator's, stored ones can.

## 6. Estimate

5d, unchanged from §3. B-1 + B-2 are ~1d of that and were not in the original estimate; W-6 and W-5 are small. If the estimate must hold, W-5 (`ActorIdentityStore` merge) is the movable piece — it can ride with T-4b, which owns the job call sites anyway.

---

## 7. PMO rulings applied (2026-09-02, `anything-llm-47`)

| # | Ruling |
|---|---|
| B-1 | Derive `grants(creator) ∩ scopes(key)`. No stored grants for api-key principals. `createdBy IS NULL` → boot report **and** deny — never a silent 403. No migration slot. |
| B-2 | T-3 derives `userWorkspaceIds` from `workspace_users` in the resolver. `impersonatedBy` deferred to T-7. |
| B-3 | G11 uses `document.delete`, `workspaceId` derived from the document row. |
| W-5 | `ActorIdentityStore` merge moves to **T-4b**. T-4a holds 5d. |
| — | `utils/chats/commands/img.js:55` collision written into both the T-4a and T-5 issues. |

### Follow-up raised back to PMO

B-2's ruling puts a **T-3 edit inside `server/utils/authorization/actorResolver.js`**, which §2 assigns to T-4a and which T-2 already owns as the single Actor construction site. Two issues writing that file is exactly the collision the split exists to avoid. Recommended: T-3 owns the resolver change (it is the consumer), T-4a's §2 drops the file, and T-4b's W-5 merge lands **after** it.

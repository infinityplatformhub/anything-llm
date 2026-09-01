# P0-5 Authorization redesign — recon note + implementation plan

Status: **recon complete, PMO rulings applied 2026-09-02, no runtime code written.** Issues to open after **#4 (P0-3) / #5 (P0-4) merge**.
Implementation owner: `anything-llm-cc`. Architect (read-only review): Dev 2.
Author: Dev 2. Date: 2026-09-02. Branch: `approof/main` (read-only audit; `p0-2`/`p0-6` worktrees untouched).

Sources: `docs/superpowers/plans/phase0-foundation.md` §P0-5 · spec §F3 · seams `02-authorization-engine.md`, `07-vector-acl.md` · `.infi/residual-risks.md` #2, #3, #7.

---

## 0. PMO rulings (binding, 2026-09-02)

| # | Ruling |
|---|---|
| R1 | Add **`workspaces.created_by`** in T-1 and backfill from the earliest `workspace_users` row. Manual re-grant is rejected. This is what makes the `manager → workspace owner` half of the legacy mapping executable. |
| R2 | **Seed `orgId = 1` (singleton org).** No `organizations` model in Phase 0 — spec cut multi-tenant SaaS — but the column ships on every new table per the seam contracts, so opening multi-org later needs no second migration. |
| R3 | **T-6 does not block the Phase 0 gate**, but boot-refuse is mandatory: any configured provider without ACL prefilter must refuse to boot. Silent post-filter fallback is forbidden. LanceDB (the default) must land in T-5. |
| R4 | **`users.role` is not dropped in Phase 0.** Frozen, read only as legacy mapping input. The drop is a post-fan-out task — a reverse migration during Phase 0 is worse than a dead column. |
| R5 | **A-1 is fixed in T-2, not deferred.** Single-user mode becomes deny-by-default with an explicit single-user principal holding a full role — never a skipped check. |

### Architect rulings (carried from recon, unchanged by PMO)

| # | Ruling | If wrong |
|---|---|---|
| A-R1 | P0-5 starts only after **P0-2 (Postgres) + P0-4 (scoped keys) merge**. Migrations are Postgres-native. | 1-week slip |
| A-R2 | Action strings are **seam 02 verbatim** — identical vocabulary to P0-4 scopes. One namespace, no mapping layer. | Rename churn across ~28 files |
| A-R3 | **No dual-run / feature-flagged legacy path.** `flexUserRoleValid` is deleted in the same PR that lands the engine call for that route group. | Bigger PRs, harder review |
| A-R4 | Legacy-role migration is **declared, one-way, irreversible**: `admin→super_admin`, `manager→owner of workspaces they created (via R1 `created_by`) + org role `member`, `default→member`. No `manager` global read after migration. | Some managers need re-grant |
| A-R5 | `explainAccess` reverse index is **maintained in the same transaction as the grant write**, not rebuilt periodically. A lagging index that fails closed is useless in a support ticket. | Slightly heavier grant write path |

---

## 1. Audit findings (verified against code)

### A-1 — Role checks are middleware string comparisons, no engine (CRITICAL, the whole task)
- `server/utils/middleware/multiUserProtected.js:3-8` — `ROLES = {all, admin, manager, default}`; that is the entire model.
- `strictMultiUserRoleValid` (`:29-48`) and `flexUserRoleValid` (`:56-81`) both reduce to `allowedRoles.includes(user?.role)`. No resource, no action, no reason, no audit.
- **`flexUserRoleValid` bypasses everything when not in multi-user mode** (`:69-73`: `if (!multiUserMode) { next(); return; }`). Single-user deployments have no authorization at all on 23 route files.
- `DEFAULT_ROLES = [ROLES.admin, ROLES.admin]` (`:9`) — duplicated entry, `manager` silently absent from the default. Cosmetic today, but it is the kind of bug an engine makes impossible.
- **Counts, recounted without truncation (2026-09-02, prompted by e5's `head`-truncation correction on P0-4):**

| Symbol | Files | Occurrences |
|---|---|---|
| `flexUserRoleValid` | 24 | **171** |
| `strictMultiUserRoleValid` | 2 | **18** |
| `ROLES.` (server) | 29 | **244** |
| `user.role` / `user?.role` (frontend) | 10 | 20 |
| literal `"admin"`/`"manager"`/`"default"` (frontend) | 36 | 105 |

  The plan's "~23 files" (`phase0-foundation.md:111`) counts *importers*, not *call sites*. The real T-4 surface is **189 middleware invocations across 24 files plus 244 `ROLES.` references across 29 files** — roughly 2× the figure the plan sizes against. T-4 stays inside one week only because the edits are mechanical and the engine (T-2) absorbs the logic; if T-2 slips, T-4 must be split by route group, not compressed.

### A-2 — Global admin/manager bypass sits inside the data layer (CRITICAL)
Bypasses are not only in middleware; they are in models, so no route-level fix removes them:
- `server/models/workspace.js:298` — `getWithUser()`: `if ([ROLES.admin, ROLES.manager].includes(user.role)) return this.get(clause)` — returns any workspace regardless of membership.
- `server/models/workspace.js:424` — `whereWithUser()`: same bypass on list.
- `server/models/browserExtensionApiKey.js:148` — admin sees all extension keys.
- `server/models/user.js:366` — admin exempt from `dailyMessageLimit`.
- `server/utils/agents/aibitat/plugins/websocket.js:22` — agent capability gate is `user?.role === ROLES.admin`.
- Consequence: `validWorkspaceSlug` (`server/utils/middleware/validWorkspace.js:8-11`) delegates the entire workspace-access decision to `Workspace.getWithUser`, so **manager crosses every workspace boundary** — this is the standing IDOR.

### A-3 — Workspace membership has no role column (HIGH)
- `schema.prisma:214-222` — `workspace_users {id, user_id, workspace_id, createdAt, lastUpdatedAt}`. Membership is boolean. There is no owner/editor/viewer, so F3's workspace-local roles need a schema change, not a code change.
- `server/models/workspaceUsers.js` — `createMany`/`createManyUsers`/`create` all write membership with no role argument; every call site needs a default.

### A-4 — Vector search has **zero** authorization input (CRITICAL — the headline risk)
- `VectorDatabase.performSimilaritySearch` (`server/utils/vectorDbProviders/base.js`) accepts `{namespace, input, LLMConnector, similarityThreshold, topN, filterIdentifiers}`. **No actor, no ACL, no tenant.** Authorization is `namespace === workspace.slug` and nothing else.
- `filterIdentifiers` is *not* a security filter — it is the pinned-document dedupe list, applied **after** the provider returns rows (`lance/index.js:206-212`, `:246-252`, and the same shape in all 8 other providers). Post-filtering forbidden candidates is explicitly banned by seam 07.
- LanceDB (`lance/index.js:196-201`, `:236-241`) issues `collection.vectorSearch(queryVector).distanceType("cosine").limit(...)` — **no `.where()` prefilter anywhere in the repo**; grep for `prefilter|filter:` across pgvector/qdrant/pinecone/chroma returns 0 hits. Every provider is currently unfiltered by construction.
- 8 call sites consume it: `endpoints/api/workspace/index.js:998` (raw `/v1` search — returns chunk text directly), `utils/chats/stream.js:187`, `apiChatHandler.js:329,717`, `openaiCompatible.js:100,344`, `embed.js:116`, `telegramBot/chat/stream.js:226`, `agents/aibitat/plugins/memory.js:94`.
- `embed.js:116` searches with **no actor at all** — the anonymous embed path. Seam 02 requires `principalType:"embed"` with `matchNone:true` when scope is absent; today an embed key inherits the whole workspace namespace.

### A-5 — Document identity is workspace-scoped only (HIGH)
- `schema.prisma:27-40` — `workspace_documents` has `docId (unique)`, `workspaceId`, `metadata`, `pinned`, `watched`. No owner, no ACL, no visibility/hidden flag.
- `document_vectors` (`:113-119`) maps `docId → vectorId` with no workspace or ACL column — it cannot answer "which vectors must this filter exclude" without a join back through `workspace_documents`.
- Vector-row metadata is whatever `addDocumentToNamespace` spread in (`lance/index.js:320,335-337`) — it carries `docId`, `title`, `chunkSource`, `text`. **No `hidden`, no `workspaceId`, no grant attributes.** Prefiltering requires adding these columns to the vector payload, which means a **re-embed-free metadata backfill** (see T-5).

### A-6 — Admin privacy posture is a single env var (MEDIUM)
- `server/utils/middleware/chatHistoryViewable.js:8-12` — `"DISABLE_VIEW_CHAT_HISTORY" in process.env` is the entire posture control. Not a permission, not per-admin, not auditable, not runtime-changeable.
- No `chat.read_others`, no `document.bulk_export`, no moderator/setup-admin separation. F3 requires all three as grantable permissions.

### A-7 — No `explainAccess` substrate exists (MEDIUM, blocks F3 diagnostics)
- Nothing in the schema can answer "who can see document X and why". Answering it today means a manual join across `workspace_documents → workspace_users → users.role` plus reading middleware source. Residual risk #7 marks this a hard schema requirement, not an optimization.

### A-9 — Frontend gates on raw role strings, not on server-supplied capabilities (MEDIUM)
- `frontend/src` never imports a `ROLES` constant; it compares literals. `PrivateRoute/index.jsx:89` — `user?.role === "admin" || !multiUserMode`; `SettingsSidebar/MenuOption/index.jsx:50-51,58-59,186-187` — `roles.includes(user?.role)`; plus `ManageWorkspace`, `SettingsButton`, `Sidebar`, `SearchBox`, `QuickActions`, `keyboardShortcuts.js:129`.
- `PrivateRoute:89` mirrors the exact A-1 defect on the client: `|| !multiUserMode` disables the gate in single-user mode.
- These are **UI affordances, not security boundaries** — the server decides — so they cannot leak data once T-4 lands. But after the legacy roles are gone, every one of them silently evaluates false and the admin UI disappears for real admins. **The frontend must ship in the same release as T-4**, consuming a server-supplied capability list rather than a role string.
- Server has 2 stragglers outside the middleware too: `endpoints/invite.js:55` (`role: "default"` literal) and `utils/chats/commands/img.js:55` (`user.role === "admin"`). Neither imports `ROLES`, so a `ROLES.`-only grep misses both — T-4's DoD grep must cover literals.

### A-8 — `policyVersion` and cache invalidation are undefined (MEDIUM — residual risks #2/#3)
- Seam 02 requires `policyVersion` on every `DocumentAclFilter`; seam 07 requires rejecting a stale one. Neither doc defines *how* a driver learns staleness or what the TTL is. Nothing in the codebase emits ACL-change events. Resolution proposed in §3 T-2/T-3.

---

## 2. Schema proposal (reverse-queryable, Postgres)

Design constraint: `authorize()` (principal→resource) and `explainAccess()` (resource→principals) **must read the same rows through the same evaluator**, per seam 02. That forces grants into one table keyed both ways, not two mirrored structures.

```prisma
// ---- policy vocabulary (seeded, not user-editable) ----
model permissions {
  id          Int    @id @default(autoincrement())
  action      String @unique   // seam-02 verbatim: "document.read", "workspace.write", "chat.read_others", "access.diagnose"
  description String
  category    String            // "document" | "workspace" | "admin" | "agent" | "export"
}

// ---- roles: org-level and workspace-local in one table ----
model roles {
  id          Int      @id @default(autoincrement())
  name        String                   // "super_admin", "member", "owner", "editor", "viewer", custom
  scope       String                   // "org" | "workspace"
  orgId       Int
  isSystem    Boolean  @default(false) // system roles cannot be deleted; can be cloned
  createdAt   DateTime @default(now())
  role_permissions role_permissions[]
  @@unique([orgId, scope, name])
}

model role_permissions {
  role_id       Int
  permission_id Int
  effect        String @default("allow")  // "allow" | "deny"; deny wins
  roles         roles       @relation(fields: [role_id], references: [id], onDelete: Cascade)
  permissions   permissions @relation(fields: [permission_id], references: [id], onDelete: Cascade)
  @@id([role_id, permission_id])
}

// ---- principal grants: THE reverse-queryable table ----
// One row per (principal, role, scope). Indexed both directions.
model principal_role_grants {
  id             Int      @id @default(autoincrement())
  orgId          Int
  principal_type String            // "user" | "group" | "service" | "embed"
  principal_id   Int
  role_id        Int
  workspace_id   Int?              // null = org-wide grant
  granted_by     Int?
  granted_at     DateTime @default(now())
  expires_at     DateTime?
  policy_version BigInt            // stamped from policy_versions at write time
  roles          roles      @relation(fields: [role_id], references: [id], onDelete: Cascade)
  @@unique([orgId, principal_type, principal_id, role_id, workspace_id])
  @@index([principal_type, principal_id, workspace_id])   // forward: authorize()
  @@index([workspace_id, role_id])                        // reverse: explainAccess()
}

// ---- group membership (feeds Actor.groupIds; S4 Lark sync writes here) ----
model groups {
  id     Int    @id @default(autoincrement())
  orgId  Int
  name   String
  source String @default("local")   // "local" | "lark" | "oidc" | "ldap"
  externalId String?
  @@unique([orgId, name])
}
model group_members {
  group_id Int
  user_id  Int
  @@id([group_id, user_id])
  @@index([user_id])                // reverse: user → groups, hot path in filter build
}

// ---- document ACL: additive grants + explicit denies ----
model document_acl {
  id             Int      @id @default(autoincrement())
  orgId          Int
  document_id    String            // workspace_documents.docId
  principal_type String            // "user" | "group" | "workspace" | "embed"
  principal_id   String            // int-as-string; "workspace" uses workspace_id, "embed" uses embed uuid
  action         String            // "document.read" | "document.search"
  effect         String @default("allow")
  source         String @default("manual")  // "manual" | "connector" | "inherited_workspace" | "document_set"
  granted_at     DateTime @default(now())
  policy_version BigInt
  @@unique([document_id, principal_type, principal_id, action])
  @@index([principal_type, principal_id, action])  // forward: build filter for actor
  @@index([document_id])                            // reverse: explainAccess(document)
  @@index([orgId, source])                          // connector re-sync + emergency revoke by source
}

// ---- visibility, separate from ACL: emergency hide must not touch grants ----
model document_visibility {
  document_id String   @id
  hidden      Boolean  @default(false)
  hidden_by   Int?
  hidden_at   DateTime?
  reason      String?
}

// ---- monotonic policy clock (resolves residual risk #2) ----
model policy_versions {
  version    BigInt   @id @default(autoincrement())
  changed_at DateTime @default(now())
  change_type String            // "role" | "grant" | "document_acl" | "group" | "visibility"
  scope_key   String            // "org:1" | "workspace:7" | "document:<docId>"
  actor_id    Int?
}
```

**Additions to existing models** (small, additive, no destructive migration):
- `workspace_users`: `+ role_id Int?` — workspace-local role. Backfilled per R4.
- `workspace_documents`: `+ orgId Int` (constant `1` per R2), `+ owner_id Int?`.
- `workspaces`: `+ created_by Int?` — **required by R1**; backfilled from the earliest `workspace_users` row per workspace, null where no membership row exists (report those; they get no owner).
- `users`: `role String` is **kept and frozen for all of Phase 0** (R4) — read only as legacy mapping input during the T-1 backfill. Nothing reads it after T-4; the drop is a post-fan-out task.

### Why this is reverse-queryable
`explainAccess(document)` is three indexed reads, no scan:
1. `document_acl WHERE document_id = ?` → direct principal grants + denies.
2. `principal_role_grants WHERE workspace_id = <doc's workspace>` → role-derived principals, joined to `role_permissions` for the action.
3. `group_members WHERE group_id IN (…)` → expand group principals to users.
Every returned principal carries the `policy_version` its row was stamped with. If any row's `policy_version` exceeds the version the caller pinned, the call **fails closed** rather than returning a partial list as complete — exactly the seam-02 requirement.

### policyVersion / cache invalidation (residual risks #2, #3)
- `policy_versions` is a monotonic sequence. Every grant/role/ACL/group/visibility write inserts one row **in the same transaction as the change** and stamps the changed row.
- `documentFilter()` embeds `MAX(version)` for the actor's scope keys at build time.
- Vector drivers reject a filter whose `policyVersion` is older than the driver's last-seen version for that org — **staleness is defined as "a newer version exists", not a TTL.** Cache TTL becomes a performance knob (proposed 30 s), never a correctness one.
- Invalidation event: `policy.changed {scopeKeys, version}` published on the **P0-6 event bus** in the transaction's commit hook. Cache subscribers drop by scope key. This is the missing trigger from residual risk #3; it is why T-3 lists P0-6 as a hard dependency.

---

## 3. Task split — 9 issues after the §5c review (T-4 split into T-4a/T-4b), each ≤1 week, disjoint file sets

Merge order is strict: **schema → engine → route migration → vector ACL → admin duties → diagnostics UI**. T-6 and T-7 may run parallel to each other.

| ID | Title | Owner files (disjoint) | Depends on | Est |
|---|---|---|---|---|
| **T-1** | Schema + migration + seed vocabulary | `server/prisma/schema.prisma`, `server/prisma/migrations/*`, `server/prisma/seeds/permissions.js` | P0-2, P0-4 | 4d |
| **T-2** | Authorization engine core (`authorize`/`assertAuthorized`/`authorizeMany`) + `policy_versions` clock | `server/utils/authorization/**` (new) | T-1 | 5d |
| **T-3** | `documentFilter()` + cache + `policy.changed` bus subscriber | `server/utils/authorization/documentFilter.js`, `server/utils/authorization/cache.js` | T-2, P0-6 | 4d |
| **T-4** | Route migration: delete `flexUserRoleValid`/`strictMultiUserRoleValid` (189 invocations, 24 files), replace 244 `ROLES.` sites (29 files) + literals, remove model-layer bypasses | `server/utils/middleware/multiUserProtected.js` (deleted), `server/endpoints/**`, `server/models/{workspace,user,browserExtensionApiKey}.js`, `server/utils/chats/commands/img.js` | T-2 | 5d |
| **T-5** | Vector ACL: `queryAuthorized` on base + LanceDB, metadata backfill, provider capability gate | `server/utils/vectorDbProviders/base.js`, `.../lance/**`, `server/utils/chats/**` call sites | T-3 | 5d |
| **T-6** | Remaining 8 vector providers OR explicit `VectorAclUnsupportedError` gate — **does not block the Phase 0 gate (R3)** | `server/utils/vectorDbProviders/{astra,chroma,chromacloud,milvus,pgvector,pinecone,qdrant,weaviate,zilliz}/**` | T-5 | 5d |
| **T-7** | Admin duties, privacy posture, view-as-user, document access diagnostics | `server/endpoints/admin/authorization.js` (new), `frontend/src/pages/Admin/Access/**` (new), `server/utils/middleware/chatHistoryViewable.js` (deleted) | T-2, T-3 | 5d |
| **T-8** | Frontend: replace role-string gates with a server-supplied capability list | `frontend/src/**` | T-4 (**must ship in the same release**) | 3d |

**File-collision check**: T-8 is the only issue touching `frontend/src/**`. T-4 owns every `server/endpoints/*` file; T-7 creates only *new* endpoint files under `server/endpoints/admin/`. T-5 owns `server/utils/chats/**` (the search call sites); T-4 does not touch them. T-1 is the only issue that edits `schema.prisma`. No two issues write the same file.

### Per-task detail

**T-1 — Schema.** Add the 8 new models + 3 column additions above. Seed `permissions` with the seam-02 action vocabulary and the 5 system roles (`super_admin`, `member`, `owner`, `editor`, `viewer`). Write the **legacy-role backfill** as an explicit migration step per R4, with a printed report of which managers lost global read.
*DoD*: `prisma migrate deploy` clean on empty Postgres · `workspaces.created_by` backfilled, workspaces with no membership row listed in the report · backfill migration produces the manager-downgrade report · every legacy user has ≥1 `principal_role_grants` row · `users.role` values unchanged (frozen, not dropped).

**T-2 — Engine core.** `DatabaseAuthorizationEngine` implementing seam 02's `authorize`, `assertAuthorized`, `authorizeMany`, `explainAccess`. Deny-wins evaluation, default-deny on missing actor / unknown action / store error. `AuthorizationDeniedError` / `AuthorizationContractError` / `AuthorizationUnavailableError`. Impersonation: `impersonatedBy` present → every non-read action denied before policy lookup.
**R5 — single-user mode (A-1) is closed here, not in T-4.** The engine resolves an explicit single-user principal carrying a full role; there is no code path where absence of multi-user mode skips a check. T-4 then has no bypass left to delete, only call sites to rewrite.
*DoD*: full role × action matrix test green · `authorizeMany` fails the whole call closed on partial store failure · engine imports nothing from `server/endpoints/**` (import-graph assertion, residual risk #4) · **single-user deployment denies an unknown action** (proves deny-by-default, not skip).

**T-3 — documentFilter + cache.** Builds `DocumentAclFilter` from `document_acl` + `principal_role_grants` + `group_members`. Deny-list + indexed attributes in normal operation; `allowedDocumentIds` **only** for embed/service scopes and capped (proposed 500) — never an org-wide IN-list, per seam 07. `matchNone:true` when scope is empty. Cache keyed on `(actorId, action, orgId, workspaceIds, policyVersion)`; invalidated by `policy.changed`.
*DoD*: revoking a grant makes the next search miss the document within one bus round-trip (timed test) · empty scope returns a valid match-none filter, never `null` · no code path returns an unfiltered fallback (assert by grepping for early-return on error).

**T-4 — Route migration.** Delete both middlewares outright (R3). Every route gets `assertAuthorized({actor, action, resource})`. Remove the model-layer bypasses at `workspace.js:298`, `workspace.js:424`, `browserExtensionApiKey.js:148`, `user.js:366`, `websocket.js:22`. Close the single-user-mode hole: single-user gets a real `super_admin` actor, not a `next()`.
*DoD*: `grep -rn "ROLES\." server/ --include="*.js" | grep -v "utils/authorization/"` → **0** · the literal grep `grep -rnE 'role (===|!==) "(admin|manager|default)"' server/` → **0** (catches `img.js:55`, which imports no `ROLES`) · `flexUserRoleValid` and `strictMultiUserRoleValid` do not exist · every P0-3 route test still green.

**T-5 — Vector ACL (LanceDB).** Add `queryAuthorized({namespaces, queryVector, topN, similarityThreshold, aclFilter, metadataFilters, signal})` to `base.js` — ACL filter **required, non-nullable**, throws `VectorAclRequiredError` when absent/malformed/stale. LanceDB implementation uses `.where(<sql predicate>)` with **prefilter enabled**, not post-filter — this is the load-bearing line of the whole task. Requires the metadata backfill from A-5: add `workspaceId`, `orgId`, `hidden`, `aclKey[]` to vector payloads. Backfill runs as a **metadata-only rewrite job** (P0-6 queue) — no re-embedding, because `setDocumentVisibility` must take effect before the call returns per seam 07. Multi-namespace merge: per-namespace over-fetch, normalize to `[0,1]`, stable global sort by score desc then `namespace+chunkId`, global `topN` — not `topN` per namespace. Migrate all 8 call sites; delete `performSimilaritySearch` from the base class.
*DoD*: **the vector-leak test (§4 S-3) is green** · `performSimilaritySearch` gone from `base.js` · a filter with a stale `policyVersion` throws before the provider is touched · `setDocumentVisibility` changes results on the very next query.

**T-6 — Remaining providers.** Each provider either implements `queryAuthorized` with native prefilter (Chroma `where`, Pinecone `filter`, Qdrant `filter`, Milvus/Zilliz `expr`, Weaviate `where`, Astra `filter`, pgvector SQL `WHERE`) **or** throws `VectorAclUnsupportedError` from `validateConnection` so the deployment cannot boot unfiltered (R3). Boot-refuse is mandatory even though the issue itself is off the gate critical path.
*DoD*: for each of the 9 providers, either the leak test passes against it or boot is refused with a named error · no provider silently ignores `aclFilter`.

**T-7 — Admin duties + diagnostics.** Split `super_admin` into `setup_admin` / `super_admin` / `content_moderator`. Replace `DISABLE_VIEW_CHAT_HISTORY` with the `chat.read_others` permission and `document.bulk_export` as separate grantable permissions (env var read once at migration to set the initial value, then deleted). "View as user" builds an `Actor` with `impersonatedBy` — read-only by construction, enforced in T-2, not in the UI. Document access diagnostics page calls `explainAccess`, gated on `access.diagnose`.
*DoD*: an admin without `chat.read_others` gets 403 on other users' chats and the denial is audited · view-as-user session cannot mutate anything (test attempts one write of each type) · diagnostics page answers "who can see doc X and why" for a doc with user + group + workspace-inherited grants · `explainAccess` denied for a plain document reader.

**T-8 — Frontend capability gates.** Replace every `user?.role === "admin"` / `roles.includes(user?.role)` with a capability list the server returns on session (derived from the engine, so the UI and the server can never disagree). Removes `PrivateRoute/index.jsx:89`'s `|| !multiUserMode` client-side twin of A-1. Ships in the **same release** as T-4 — separately, real admins lose the admin UI the moment legacy roles stop matching.
*DoD*: no role-string literal gates a component (`grep -rE '"(admin|manager|default)"' frontend/src` → only in tests/fixtures) · single-user mode renders the admin UI via a granted capability, not via `!multiUserMode` · an admin whose `chat.read_others` is revoked loses the UI entry point as well as the route.

---

## 4. Security attack tests — 26 cases (the acceptance bar, not extras)

**This section is the canonical S-number registry.** Every other document — the harness plan, task DoDs, issue bodies — refers to these numbers and must not assign, renumber, or invent one. A new case is added here first.

Test file layout: `server/__tests__/security/authorization/*.test.js`. Every test must be shown **RED before green** (a P0-3 discipline), by reverting the specific guard.

### IDOR / tenant crossing
- **S-1** `manager` (post-migration `member`) requests a workspace they are not a member of by slug → 404 (not 403 — no existence leak, per seam 02 failure semantics). *Directly targets `workspace.js:298`.*
- **S-2** Same for list: `whereWithUser` returns only member workspaces for every role except `super_admin`. *Targets `workspace.js:424`.*
- **S-3** Thread/document/chat IDs from workspace A used against workspace B's endpoints → denied for all 4 verbs.
- **S-4** Single-user-mode deployment: every route that used `flexUserRoleValid` now resolves a real actor; no route reachable with a null actor. *Targets the `:69-73` bypass.*

### Privilege escalation
- **S-5** A user with `role.grant` on workspace W cannot grant a role carrying permissions they do not themselves hold (the P0-4 service-account escalation trap, applied to roles).
- **S-6** A user cannot grant themselves a role, nor edit a `isSystem` role's permissions.
- **S-7** Impersonated session (`impersonatedBy` set) attempts create / update / delete / export / API-key-management / admin-mutation → **all six denied**, denials audited, regardless of the impersonated user's own scope.
- **S-8** Expired `principal_role_grants` row (`expires_at` in the past) grants nothing.
- **S-9** A P0-4 scoped API key cannot exceed its creator's permissions even if the role attached to it is broader.

### Vector ACL leak — **the most important test in Phase 0**
- **S-10 (canonical leak test)** Two users, one workspace, two documents. Doc A readable only by user 1, doc B only by user 2. Each doc contains a unique fact answerable from that doc alone. User 1 asks the question answerable only from doc B → **zero chunks from doc B in `contextTexts`, `sources`, and the raw provider response**. Assert on the provider's returned rows, not the final answer — a post-filter would pass an answer-level assertion and still be a leak.
- **S-11** Same via the `/v1/workspace/:slug/vector-search` endpoint (`endpoints/api/workspace/index.js:998`) — this path returns chunk text directly, so it is the highest-value leak surface.
- **S-12** Same via the embed path (`utils/chats/embed.js:116`) with an embed key whose scope is absent → `matchNone`, zero results. *Targets A-4's anonymous-actor gap.*
- **S-13** Same via agent memory (`agents/aibitat/plugins/memory.js:94`) and the Telegram channel (`telegramBot/chat/stream.js:226`) — non-HTTP entry points must not have their own door.
- **S-14** `queryAuthorized` called with `aclFilter: null` / `{}` / a filter with an old `policyVersion` → throws, never queries.
- **S-15** Emergency hide: `setDocumentVisibility({hidden:true})` → the very next query excludes the document, with no re-embed and with the embeddings still on disk.
- **S-16** Revocation timing: revoke a `document_acl` row, then query → excluded. Asserts the T-3 invalidation path end-to-end.
- **S-17** Cross-namespace merge: query 3 namespaces where the actor may read only 1; assert global `topN` semantics and that no forbidden candidate appears at any rank.

### Second retrieval path (from §5c — these do not overlap S-10..S-17)
- **S-21** User A pins a document A cannot read; user B asks a question answerable only from it → chunk absent from `contextTexts` **and** `sources`. Repeat for a parsed attachment via `WorkspaceParsedFiles.getContextFiles`. *Targets G17; S-10 cannot catch this because the pinned path never reaches the provider.*
- **S-22** Ask a question, get a citation, revoke the document, ask a follow-up in the same thread → the revoked citation must not be rehydrated from history. *Targets G1 `fillSourceWindow`.*
- **S-23** `DELETE /workspace/:slug/remove-and-unembed` with a `documentLocation` belonging to another workspace → denied, document still present. *Targets G11.*
- **S-24** `GET`/`DELETE /embed/:embedId/:sessionId` with another visitor's session id → denied. *Targets G12.*

### Vector ACL enforcement invariants (registry additions, 2026-09-02 — requested by `anything-llm-cc`)
- **S-25** Vector count and namespace-stat endpoints (`api/system/index.js:97-98`, `endpoints/system.js:449-452`, `api/workspace/index.js:970-972`) must not report cardinality beyond the actor's authorized scope. *Targets G2; already in T-5's DoD but had no S-number.* Blocked by T-5.
- **S-26** A vector row lacking ACL metadata is denied, never passed through — assert against a namespace deliberately left half-backfilled, and assert `queryAuthorized` refuses to go live while the backfill job is incomplete. *Targets G4's fail-closed gate; already in T-5's DoD but had no S-number.* Blocked by T-5.

### Diagnostics / privacy posture
- **S-18** `explainAccess` denied without `access.diagnose`; the denial does not reveal whether the document exists.
- **S-19** `explainAccess` on a document whose grants changed mid-call (bump `policy_versions` between reads) → fails closed, never returns a partial principal list as complete.
- **S-20** Admin without `chat.read_others` cannot read another user's chats through **any** route, including admin exports and the `/v1` API.

---

## 5. Open questions — RESOLVED by PMO 2026-09-02

All four are closed; see §0. Recorded here for the audit trail:

1. **Manager mapping** → R1: add `workspaces.created_by`, backfill from earliest `workspace_users` row. (Recommended option (a); accepted.)
2. **Org scope** → R2: seed `orgId = 1`, no `organizations` model in Phase 0, column ships everywhere.
3. **T-6 sequencing** → R3: off the gate critical path, but boot-refuse mandatory; LanceDB must land in T-5.
4. **`users.role` drop** → R4: not in Phase 0. Frozen only; drop after fan-out.

## 5b. P0-4 handoff points (confirmed with `anything-llm-e5`, 2026-09-02)

P0-4 recon: `docs/superpowers/design/p0-4-security-recon.md @ 8b49f5c3` (207 lines).

- **Actor hand-off is direct.** P0-4 Step 2 places a seam-02 `Actor` (`type:"service"`, `scopedKeyId`, `orgId`, `workspaceIds`) on `response.locals`. T-2's engine consumes it unchanged — no adapter, no second shape.
- **One vocabulary.** P0-4's R3 (scope strings are seam-02 action names verbatim) is the same ruling as A-R2. P0-4's DoD greps `SCOPE_MAP|scopeAlias|translateScope` → 0; T-2 inherits that constraint rather than restating it.
- **`validApiKey` is 62 call sites in 9 files**, not the 30 first reported — e5's original grep was truncated by `head`. Recounted here for the same reason (see A-1 table): trust a fresh grep over any number carried in a plan.
- **Impersonation chain — CLOSED out-of-band, T-2 does not carry it.** The chain (any API key → temp token for an admin → session JWT) was split into hotfixes ahead of the P0-4 dependency chain: **issue #8 / PR-0** landed `ssoIssuanceLock` as the first middleware on `/v1/users/:id/issue-auth-token` (403 by default, reopened only via `SIMPLE_SSO_ISSUE_UNSAFE_ALLOW`) at `3bbbea76`, under QA by `anything-llm-5f`; **issue #10 / PR-0b** covers an unauthenticated `GET /v1/system/env-dump` plus a route-auth sweep of `api/`. Neither waits on P0-4 steps A/B or #4. T-2 therefore scopes to denying impersonated *mutations* per seam 02 and does not attempt to gate token issuance.

## 5c. Adversarial review by `anything-llm-cc` — 17 gaps, architect triage (2026-09-02)

`anything-llm-cc` ran three independent sweeps (auth surface / vector providers / attack paths) against this note and returned 17 gaps. Every one I spot-checked reproduced. Triage below; **G15 and the T-4 split need a PMO ruling before T-1 is written.**

### Accepted into scope — verified against code

| # | Gap | Verification | Lands in |
|---|---|---|---|
| **G17** | Pinned documents and parsed attachments are pushed straight into `contextTexts` **before** vector search runs (`utils/chats/stream.js:156-183`) | Confirmed. **T-5's DoD must enumerate every context-injection path as a checklist, not fix them one at a time** (PMO ruling). 9 entry points: `stream.js:155,170`, `embed.js:102`, `apiChatHandler.js:297,685`, `openaiCompatible.js:83,327`, `agents/index.js:799,804`, `agents/ephemeral.js:444,445`, `router/index.js:361`. **This is a second retrieval path that `queryAuthorized` does not sit on** — T-5 could close all 9 providers and this would still leak. | **T-5** (scope increase) |
| **G1** | `fillSourceWindow` (`utils/helpers/chat/index.js:382-439`) rehydrates citations out of stored chat-history JSON with no ACL re-check | Confirmed — it filters on pins, `score`, `text`, and dedupe only. A revoked document's text returns from history. | **T-5** |
| **G11** | `DELETE /workspace/:slug/remove-and-unembed` (`endpoints/workspaces.js:861-882`) passes caller-supplied `documentLocation` to the global `purgeDocument` after checking only workspace membership | Confirmed — path is never constrained to the workspace. Destructive cross-workspace IDOR, live today. | **T-4a** + S-test |
| **G14** | `Workspace.updateUsers` (`models/workspace.js:501-509`) is delete-then-create with no transaction, and `workspaceUsers.js:26-43` swallows errors | Confirmed. A failed create after a successful delete silently empties a workspace's membership. | **T-1** (transactional replace + version bump) |
| **G3** | Writes, deletes and jobs carry no actor. Worst case `jobs/sync-watched-documents.js:157-193`: on sync it **fans the new content out to every other workspace holding a file of the same name** | Confirmed, and worse than an actor gap: `filename` is the **basename** (`models/documents.js:123`), so two unrelated documents sharing a name are treated as one — workspace B's vectors are deleted and replaced with workspace A's content. Split out as hotfix **PR-0e** (`pr-0e-sync-watched-bloom.md`); the actor half stays here. | **PR-0e** + **T-4b** |
| **G12** | `GET`/`DELETE /embed/:embedId/:sessionId` (`endpoints/embed/index.js:69-105`) gate on `validEmbedConfig` only; `sessionId` comes from the URL | Confirmed — read and delete another visitor's chat by guessing a session id. | **T-4b** |
| **G13** | JWT carries `{id, username}` only (`utils/http/index.js:25-28`), `validatedRequest` reloads the user (`middleware/validatedRequest.js:74-99`) — no `impersonatedBy`/`onBehalfOf` field exists anywhere | Confirmed. S-7 tests a property the substrate cannot yet express. | **T-2** (actor envelope at ingress) |
| **G16** | Six live identity types need one resolver: JWT user, P0-4 service key, browser-extension key (`validBrowserExtensionApiKey.js:20-48`), mobile device token (`mobile/middleware/index.js:12-37`), embed anonymous, SSO temp token | Confirmed. Missing actor = deny. | **T-2** |
| **G8** | `/v1` resolves resources unscoped: 18 `Workspace.get(` and 4 `WorkspaceThread.get(` across `endpoints/api/`, over **63 route definitions** | Confirmed by count. | **T-4b** |
| **G7** | A-2's bypass list was incomplete: add `utils/chats/commands/img.js:55`, `utils/helpers/admin/index.js:10-44`, `endpoints/browserExtension.js:203-211`, `endpoints/admin.js:368,473` | Confirmed. | **T-4a** |
| **G2** | Vector counts and namespace stats leak cardinality (`api/system/index.js:97-98`, `endpoints/system.js:449-452`, `api/workspace/index.js:970-972`) | Confirmed. Low severity, cheap to fix. | **T-5** DoD |
| **G10** | Jobs, Telegram and agents resolve resources with no actor (`handle-telegram-chat.js:32,43`, `extract-memories.js:66,83`, `chat-history.js:178-182`, `agents/index.js:505`, `purgeDocument.js:18,61`, `helpers/search.js:36`) | Confirmed. | **T-4b** |
| **G4** | Pre-backfill vector rows have undefined ACL semantics | Accepted as stated: **a row without ACL metadata is denied**, and backfill completion gates `queryAuthorized` going live. Fail-closed. | **T-5** |
| **G5** | Namespace-slug stability | Accepted into **T-6** DoD as written. | T-6 |

### G15 — canonical document identity: **agreed, but scope it narrowly** (PMO ruling)

The defect is real and worse than "missing a table": `Documents.addDocuments` mints `docId = uuidv4()` **per workspace** (`models/documents.js:119`) while `docpath` is the shared identity. The same file in three workspaces is three `docId`s. An ACL keyed on `docId` therefore protects **one copy**; revoking access to a document does not revoke its siblings. Meanwhile `Documents.contentByDocPath` (`models/documents.js:297-301`) reads a bare path with no ownership check at all, and `viewLocalFiles` (`api/document/index.js:638-641`) walks the whole tree.

Architect position: **accept the canonical `documents` table (orgId, stableId, ownerId).** The table is load-bearing — without a stable id, `document_acl` cannot express "this document", and `explainAccess` answers per-copy, which is exactly the support question it exists to answer. Concretely for T-1: `documents(id, orgId, stable_id, owner_id, docpath, filename, mime)`, `workspace_documents.document_id` FK, `document_acl.document_id` → `documents.stable_id`, backfilled by grouping existing rows on `docpath`.

**I initially argued the CRUD vocabulary was scope creep and was wrong.** Judging it from the retrieval side only, `document.read`/`document.search` looked sufficient. G11 disproves that: `remove-and-unembed` is a *destructive* action, and if no action name exists for it, T-4a has nothing to pass to `assertAuthorized`. Agreed vocabulary is 9 actions — `document.create/read/search/update/delete/share/pin/watch/export`. Dropped from cc's proposal: `document.embed`/`document.unembed`, which are side effects of add/remove rather than separately grantable rights.

**Dedupe key is `docpath`, and `checksum` does not ship in T-1.** `docpath` has no unique constraint (`schema.prisma:31`); only `docId` does (`:29`). `Documents.addDocuments` writes the same `docpath` with a fresh `uuidv4()` per workspace (`models/documents.js:119,124`), and `removeDocuments` queries on `{docpath, workspaceId}` together (`:208-211`) — it would not need the workspace if paths were unique. So duplicate `docpath` rows already exist; backfill must `GROUP BY docpath` and handle N rows per group rather than expecting one. A `checksum` column is rejected for Phase 0: hashing every file makes migration time unbounded in corpus size, nothing would read the column so it would rot silently on edit, and `watched` documents change content by design, so a hash is not their identity.

**`pinned` and `watched` stay on `workspace_documents`.** They are genuine per-workspace state (`endpoints/workspaces.js:626` sets pin per document row); only `filename`/`mime`/`metadata` merge into the canonical row. Conflicts resolve to the lowest workspace id, with a printed report.

**`inherited_workspace` backfill grants.** T-1 writes a `document_acl` row with `source="inherited_workspace"` per existing (workspace, document) pair so list/read does not break on day one. These use `principal_type="workspace"`, so they never collide with manual `user`/`group` grants under the existing unique constraint. **T-7's diagnostics must surface `source`** — otherwise `explainAccess` answers "this principal has a grant" when the truth is "the migration created one", which is a different answer for whoever is debugging the ticket.

**`document_vectors` re-keying** runs as a batched job on the P0-6 queue, never as an inline migration. It and T-5's vector-metadata backfill must be the same job or explicitly ordered — not two jobs racing on one table. The G4 gate still holds: `queryAuthorized` does not go live until backfill completes, and any row without ACL metadata is denied.

**Cost**: +1.5d on T-1 (4d → 5.5d, still inside one week; the canonical table and the 9-action vocabulary land together). Deferring it means `document_acl` is written against a per-copy key and rewritten later — a migration on the table the whole task is built on.

### T-4 split — **agreed, evidence supports it**

My own recount put T-4 at 189 middleware invocations + 244 `ROLES.` references. cc's sweep adds 63 `/v1` route definitions, the job/channel/agent actor work (G3, G10), and G11. That is not 5 days.

**T-4a** — internal routes, models, bypasses (incl. G7, G11). Owns `server/endpoints/*.js`, `server/models/*.js`, `server/utils/middleware/multiUserProtected.js` (deleted). 5d.
**T-4b** — `/v1` (G8), jobs (G3), channels (G12), agents (G10). Owns `server/endpoints/api/**`, `server/endpoints/embed/**`, `server/jobs/**`, `server/utils/telegramBot/**`, `server/utils/agents/**`. 5d.

Order: **T-4a → T-4b → T-5.** File sets stay disjoint. T-5 still owns `server/utils/chats/**`.

### Note on G17's severity

G17 is the most important finding in this review. The recon note framed the vector ACL as *the* retrieval boundary; G17 shows there are **two** — pinned documents and parsed attachments enter context without passing retrieval at all. A T-5 that ships `queryAuthorized` on every provider and stops there would pass S-10 and still leak, because S-10 asks a question answered from an *embedded* chunk. **S-21 is therefore not optional**: pin a document as user A, ask as user B, assert the chunk is absent from `contextTexts` — and the same for a parsed attachment.

## 6. Residual risks resolved / carried

| Risk | Disposition |
|---|---|
| #2 policyVersion staleness undefined | **Resolved** — §2 monotonic `policy_versions`; staleness = "a newer version exists", not a TTL. |
| #3 documentFilter cache invalidation has no event trigger | **Resolved** — `policy.changed` on the P0-6 bus, emitted in the write transaction. Makes P0-6 a hard dependency of T-3. |
| #7 explainAccess needs a reverse-queryable policy store | **Resolved** — §2 dual-indexed `principal_role_grants` + `document_acl`; same rows serve both directions. |
| #4 no mechanism enforces seams | **Carried** — T-2 DoD adds one import-graph assertion for the authorization seam only; the general mechanism stays with P0-3/P0-6. |
| #9 group→workspace/role onboarding mapping has no tested diagram | **Carried to S4** — `groups`/`group_members` land here so S4 has a target, but the mapping diagram is not P0-5 scope. |

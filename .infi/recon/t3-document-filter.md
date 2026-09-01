# Recon T-3 (#22): documentFilter + cache + policy.changed bus

Base: T-2 `d686a6b1` (engine + actorResolver + policyRepository) · deps P0-6 bus (merged) · owner files `server/utils/authorization/{documentFilter,cache}.js` + bus subscriber · rebase on `approof/main` after #20 merges · migration slot (if any) = 020000 series.
Contract: seam 02 `documentFilter()` → `DocumentAclFilter{orgId, principalType, actorId, workspaceIds, deniedDocumentIds, attributes, allowedDocumentIds?, matchNone, policyVersion}`; seam 07 consumes it inside `queryAuthorized` (T-5).

## 1. documentFilter() — build order is binding

1. **Actor null / empty scope → `matchNone: true`** filter object. Never `null`, never an unfiltered fallback (seam 02 failure semantics).
2. **Visibility FIRST, hard override** (T-1 ledger commitment, e5 review): `document_visibility.hidden = true` document ids enter `deniedDocumentIds` **before** any ACL evaluation, and the driver additionally pushes `hidden = false` as a predicate. No grant can re-allow a hidden document, and no path evaluates ACL first then filters hidden afterwards.
3. **ACL**: principals for the actor are `{user: id}`, `{group: *}` via `group_members` (indexed `[user_id]`), and `{workspace: *}` for each workspace where the actor holds `document.read` / `document.search` (`principal_role_grants` × `role_permissions`, expired grants excluded — same rules as `engine.evaluate`). `document_acl` rows with `effect = deny` go to `deniedDocumentIds`; deny wins. Allow rows are **not** materialized into `allowedDocumentIds` for user actors — the normal filter is workspace scope + deny list + indexed attributes (seam 07 forbids an org-wide IN-list).
4. **`allowedDocumentIds` only for `embed` / `service` actors**, capped at 500. Over the cap → `matchNone` plus a logged `AuthorizationContractError`, never a silently truncated list.
5. **`policyVersion`** is read from `policyRepository.currentPolicyVersion()` in the same snapshot as the grant reads — never fetched separately afterwards (that would stamp a version newer than the rows it describes).
6. `attributes` are derived only (workspace ids, group ids). No persisted attribute table — deferred to V3 document sets (T-1 ledger).

## 2. Cache

Key: `(actor.type, actor.id, action, orgId, sorted workspaceIds, policyVersion)`.
**Staleness = "a newer `policy_versions` row exists for a scope key this actor touches"**, not a TTL. The TTL (proposed 30s) is a memory bound only, never a correctness knob.
Invalidation: subscribe to `policy.changed {scopeKeys, version}` on the P0-6 bus and drop every entry whose scope keys intersect. Fail-closed: if the subscription is down, the cache is disabled (every call rebuilds) rather than served stale.

## 3. Bus subscriber

`subscriberId = "authorization-cache"`, `eventTypes = ["policy.changed"]`, `versions = [1]`. Handler invalidates by scope key, then acks. Dead-letter → cache disabled until process restart plus an audit event; never silent.

## 4. policyRepository additions (T-3 also edits this file — it is T-2-owned until #20 merges)

- `grantRole` / `revokeGrant` / `setDocumentVisibility` publish `policy.changed` **inside the same transaction** as the `policy_versions` insert, via P0-6 `publishOperationalEvent(event, tx)` (outbox). T-2 shipped the version bump without the publish — T-3 adds it.
- New `grantDocumentAcl` / `revokeDocumentAcl` for runtime `document_acl` writes (T-1's backfill wrote inherited rows directly; runtime writes go through the gateway only).
- **G14 closes here**: `Workspace.updateUsersPerWorkspace` (delete-then-create at `models/workspace.js:495-509`, errors swallowed in `models/workspaceUsers.js:26-43`) is rewritten as one transaction through the repository with a single version bump.

## 5. Legacy-uuid call sites the canonicalize job is gated on (11) — T-4b/T-5, listed for the flag owner

Eight providers calling `DocumentVectors.where({ docId })`: `utils/vectorDbProviders/astra/index.js:299`, `chroma/index.js:359`, `lance/index.js:303`, `milvus/index.js:296`, `pgvector/index.js:688`, `pinecone/index.js:223`, `qdrant/index.js:337`, `weaviate/index.js:370`.
Plus `models/documents.js:204-214` (`removeDocuments` → `deleteDocumentFromNamespace(uuid)`), the `DocumentVectors.deleteForWorkspace` callers `endpoints/admin.js:313`, `endpoints/api/workspace/index.js:260`, `endpoints/workspaces.js:313,355`, and `jobs/sync-watched-documents.js:131,179`.
Rule (T-1 ledger): `ENABLE_DOC_VECTORS_CANONICALIZE` is set only once the last of these resolves ids through `workspace_documents.documentId` / `legacy_docid_map`. **T-3 does not touch them.**

## 6. Retrieval call sites the filter must reach (T-5 wiring; T-3 only provides the function)

`performSimilaritySearch` ×9: `endpoints/api/workspace/index.js:998`, `utils/chats/stream.js:187`, `utils/chats/apiChatHandler.js:329,717`, `utils/chats/openaiCompatible.js:100,344`, `utils/chats/embed.js:116`, `utils/telegramBot/chat/stream.js:226`, `utils/agents/aibitat/plugins/memory.js:94`.
`fillSourceWindow` ×6 callers (`utils/helpers/chat/index.js:382-439`), and the pinned-document path at `utils/chats/stream.js:149-165` (G17).

## 7. Tests (S-registry mapping)

- **S-16** revocation timing: revoke a `document_acl` row, next filter excludes the document within one bus round-trip — timed on the event, never a sleep.
- **S-14** stale `policyVersion` rejected — driver-side in T-5; T-3 provides `isStale(filter)`.
- **S-22** needs T-5.
- New: hidden document with a fresh explicit allow grant still lands in `deniedDocumentIds` (visibility-before-ACL); `allowedDocumentIds` at 501 entries → `matchNone`; empty scope returns a valid match-none filter, never `null`; cache disabled while the bus subscription is down.

## 8. Rulings to record at implementation time

- Publish `policy.changed` inside `$transaction` through the outbox, not after commit — a crash between commit and publish would leave caches stale forever.
- `matchNone` for an embed actor with no document-set or workspace scope, rather than a deny at ingress (T-2 ruling).

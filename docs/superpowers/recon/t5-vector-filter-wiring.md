# T-5 recon — vector ACL wiring (`documentFilter` → retrieval)

Author: Dev 2 (Authorization Architect). Date: 2026-09-02. **Read-only recon — no runtime code written.**
Base: `main 731e4c1d`. Deps: **T-3 #22** (`documentFilter` + cache + `policy.changed`), T-2 `323b2256`, T-1.
Sources: recon §3 (T-5), §4 (S-10..S-17, S-21..S-26), §5c G17/G1/G2/G4 · seam `07-vector-acl.md`.

---

## 1. Retrieval sites — recounted on `731e4c1d`

**Path 1 — provider search (`performSimilaritySearch`), 9 runtime callers:**

| # | Site |
|---|---|
| 1 | `endpoints/api/workspace/index.js:999` — `/v1/.../vector-search`, returns chunk text directly (**highest-value leak surface**, S-11) |
| 2 | `utils/chats/stream.js:187` |
| 3 | `utils/chats/embed.js:116` |
| 4-5 | `utils/chats/apiChatHandler.js:329`, `:717` |
| 6-7 | `utils/chats/openaiCompatible.js:100`, `:344` |
| 8 | `utils/agents/aibitat/plugins/memory.js:94` |
| 9 | `utils/telegramBot/chat/stream.js:226` |

Implementations: `base.js:127` + 8 providers (`astra:314`, `chroma:370`, `lance:417`, `milvus:316`, `pgvector:720`, `pinecone:263`, `qdrant:351`, `weaviate:386`). T-5 lands `queryAuthorized` on `base` + `lance`; the other 7 are T-6 (boot-refuse per R3).

**Path 2 — context injection that never reaches a provider (G17). 14 sites, not 6:**

`pinnedDocs()` × 10 — `stream.js:155`, `embed.js:102`, `apiChatHandler.js:297`, `:685`, `openaiCompatible.js:83`, `:327`, `agents/index.js:804`, `agents/ephemeral.js:445`, `router/index.js:360`, `telegramBot/chat/stream.js:195`.
`WorkspaceParsedFiles.getContextFiles()` × 4 — `stream.js:170`, `agents/index.js:799`, `agents/ephemeral.js:444`, `router/index.js:361`.

Single choke point: **`utils/DocumentManager/index.js:29-68`** (`pinnedDocs()` builds the array). Filtering there covers all 10 pin sites in one place; `getContextFiles` needs its own filter. **Recommendation: filter in `DocumentManager.pinnedDocs()` + `WorkspaceParsedFiles.getContextFiles()`, not at the 14 call sites** — 2 edits instead of 14, and a future 15th caller is filtered by construction.

**Path 3 — history rehydration (G1).** `fillSourceWindow` (`utils/helpers/chat`, used at `telegramBot/chat/stream.js:245` and the chat handlers) re-reads citations from stored history. A revoked document's citation must not come back (S-22). This is a **third** boundary — neither Path 1 nor Path 2 covers it.

**Path 4 — cardinality (G2).** `namespaceCount` / `hasNamespace` at `endpoints/api/workspace/index.js:971-972`, `endpoints/system.js:449-452`, `api/system/index.js:97-98` report counts outside the actor's scope (S-25).

## 2. Owner files

`server/utils/vectorDbProviders/base.js`, `.../lance/**`, `server/utils/chats/**`, `server/utils/DocumentManager/index.js`, `server/models/workspaceParsedFiles.js`, `server/utils/helpers/chat/**` (fillSourceWindow), the 3 count endpoints, `server/utils/telegramBot/chat/stream.js`, `server/utils/router/index.js`, `server/utils/agents/{index,ephemeral}.js`, `server/utils/agents/aibitat/plugins/memory.js`.

**Collisions to write into both issues:**
- `utils/chats/commands/img.js:55` — **T-4a** owns it (role literal), T-5 owns the rest of `utils/chats/**`. Already agreed.
- `utils/agents/**` and `utils/telegramBot/**` are **T-4b's** file set (§3:378) but hold retrieval sites 8, 9 and pin sites. **Unresolved — needs a PMO ruling.** Proposal: T-4b does actor plumbing only; T-5 does the filter argument, and the two must not be in flight simultaneously on those four files. Sequence T-4b → T-5 (already the merge order) makes this safe.
- `endpoints/api/workspace/index.js:999` is **T-4b's** (`endpoints/api/**`) but is S-11's target. Same resolution: T-4b first.

## 3. Canonicalize — 11 legacy `docId` call sites, all must move before `ENABLE_DOC_VECTORS_CANONICALIZE`

`docVectorsCanonicalize.js:19` names T-5 as the enabler. The guard refuses until then (`CanonicalizeNotEnabledError`, test at `t1-authz-migration.test.js:232`). Sites reading vectors by the **legacy uuid**:

| # | Site | Owner |
|---|---|---|
| 1-8 | `DocumentVectors.where({docId})` in all 8 providers — `astra:299`, `chroma:359`, `lance:303`, `milvus:296`, `pgvector:688`, `pinecone:223`, `qdrant:337`, `weaviate:370` | T-5 (lance) / **T-6 (other 7)** |
| 9 | `models/documents.js:224` (`where: { docId: document.docId }`) + `:288` lookup | T-4b |
| 10 | `models/vectors.js:14`, `:47` (`docId: { in: docIds }`) | T-5 |
| 11 | `jobs/embedding-worker.js:89-110` (mints a fresh uuid) and `jobs/sync-watched-documents.js:133-188` (5 sites) | T-4b / PR-0e |

**Blocker C-1: T-5 cannot flip the flag.** 7 of the 11 sites live in providers T-6 owns, and T-6 is explicitly **off the Phase 0 gate** (R3). Enabling canonicalize while those 7 still read legacy uuids means deleted documents leave vectors behind in every non-Lance deployment. **Recommendation: the flag flips in T-6, not T-5** — amend `docVectorsCanonicalize.js:19-20`'s comment accordingly. T-5's DoD becomes "its own 4 sites moved", not "flag enabled".

## 4. RED tests (DoD)

- **S-10** canonical leak test — assert on the **provider's returned rows**, not the answer text. A post-filter passes an answer-level assertion and is still a leak.
- **S-11** same via `/v1/.../vector-search` (returns chunks directly).
- **S-12** embed path with an absent scope → `matchNone`, zero results.
- **S-13** agent memory (`memory.js:94`) + Telegram (`telegramBot/chat/stream.js:226`) — non-HTTP entry points get no private door.
- **S-14** `aclFilter` null / `{}` / stale `policyVersion` → **throws before the provider is touched**.
- **S-15** `setDocumentVisibility({hidden:true})` → excluded on the very next query, no re-embed, embeddings still on disk.
- **S-16** revoke a `document_acl` row → next query excludes it (T-3 invalidation, end to end).
- **S-17** 3 namespaces, 1 readable → global `topN` semantics, no forbidden candidate at any rank.
- **S-21** (G17, **not optional**) user A pins a doc A cannot read; user B asks → chunk absent from `contextTexts` **and** `sources`. Repeat for a parsed attachment. S-10 cannot catch this — the pinned path never reaches the provider.
- **S-22** (G1) cite → revoke → follow-up in the same thread → citation not rehydrated by `fillSourceWindow`.
- **S-25** (G2) count/namespace-stat endpoints do not report cardinality beyond scope.
- **S-26** (G4) a vector row lacking ACL metadata is **denied, never passed through**; `queryAuthorized` refuses to go live while the backfill is incomplete. Test against a deliberately half-backfilled namespace.
- **grep gates**: `performSimilaritySearch` gone from `base.js`; no call site passes `aclFilter: null`.

## 5. Metadata backfill

Adds `workspaceId`, `orgId`, `hidden`, `aclKey[]` to vector payloads — **metadata-only rewrite** on the P0-6 queue, no re-embedding (S-15 requires visibility to take effect before the call returns). Ordering is a single chain: **`doc-vectors-canonicalize` → metadata backfill**, never parallel (`docVectorsCanonicalize.js:3-4`). Given C-1, that chain now starts in T-6.

## 6. Estimate

5d as planned, **assuming C-1 is resolved by moving the flag to T-6**. If T-5 must also flip it, T-5 absorbs T-6's 7 providers and becomes ~8d — which is the whole reason T-6 exists as a separate issue.

## §PMO rulings
- C-1: ENABLE_DOC_VECTORS_CANONICALIZE flips in T-6 (owns 7 provider sites). T-5 DoD = migrate its own 4 sites + fix comment docVectorsCanonicalize.js:19-20. Flag stays off at end of T-5.
- Filter at DocumentManager/index.js:29-68 single choke point (covers 10 pin + getContextFiles); 9 provider search sites wired individually; fillSourceWindow (S-22) + namespaceCount (S-25) in scope.
- Collisions: utils/agents/**, utils/telegramBot/**, endpoints/api/workspace/index.js:999 owned by T-4b → merge order T-4b → T-5, never in flight together. img.js:55 with T-4a.
- Note from T-4a: `utils/helpers/search.js:35` calls `Workspace.whereWithUser`; after W-2 (bypass removed at workspace.js:299,425) managers stop seeing non-member workspaces in search with no diff in search.js. Intended; T-5 must not "fix" it back.
- DoD (from T-3, not follow-up): `policy.changed` subscriber `authorization-cache` → FilterCache.invalidateScopes/disable must land in the same change that wires FilterCache into retrieval. Without it, ACL revoke is invisible until TTL (30s). Version-stamp backstop is a DB round-trip, not a substitute.

# T-4b recon — `/v1`, jobs, channels, agents

Author: Dev 2 (Authorization Architect). Date: 2026-09-02. **Read-only recon — no runtime code written.**
Base: `main 3c0048b1`. Deps: T-2 `323b2256`, **T-3 #22** (resolver derives workspace scope), T-4a #25.
Sources: recon §3 (T-4b, :378), §5c G3/G8/G10/G12 · `.infi/recon/t4a-route-wiring.md` §3 W-5 (moved here by PMO) · `.infi/recon/t5-vector-filter-wiring.md` §2.
Order: **T-4a → T-4b → T-5.**

---

## 1. Scope, recounted on `3c0048b1`

| Surface | Count |
|---|---|
| `/v1` route definitions (`endpoints/api/**`) | **63** |
| Unscoped resolves in `/v1` (G8) | `Workspace.get(` **18**, `WorkspaceThread.get(` **4** |
| `validApiKey` route files | **10** (+2 middleware, +5 test) |
| Job files (`server/jobs/*.js`) | **9** |

## 2. Owner files

`server/endpoints/api/**`, `server/endpoints/embed/**`, `server/jobs/**`, `server/utils/telegramBot/**`, `server/utils/agents/**`, `server/utils/jobs/{ActorIdentityStore.js (deleted), JobRuntime.js, CoreJobWorker.js}`, `server/utils/authorization/actorResolver.js` (W-5 merge — after T-3's B-2 edit lands).

## 3. Work items

**W-5 (moved from T-4a) — merge `ActorIdentityStore.resolveActor` into `actorResolver`.**
`utils/jobs/ActorIdentityStore.js:4` is the second Actor construction site. It spreads the whole `user` row into the Actor (leaking `pfpFilename`, `seen_recovery_codes`, and any future column into an object the engine reads), hardcodes `workspaceIds: []` — **now wrong**, since T-3's `60155631` made the HTTP resolver derive membership, so a job acting as a user gets an empty scope while the same user over HTTP gets a real one — and **never stamps `impersonatedBy`**. Callers: `JobRuntime.js:4,12`, `CoreJobWorker.js:14`, and a test double at `coreServices.test.js:63`.
Proposal: export `resolveActorRef(actorRef, {db})` from `actorResolver`, reusing `workspaceIdsForUser` that T-3 already added. Delete the class. The test double keeps working if the shape is preserved.

**W-8 — scope-vs-grant on `/v1`.** PR-4a's `validApiKey(action, binding)` already does scope 403 and stays raw-only (ruling upheld). T-4b adds the grant half: `assertAuthorized` with the Actor from `resolveActor`. Effective permission = **grants(creator) ∩ scopes(key)**, per PMO's B-1 ruling.
**Carried blocker B-1 is now T-4b's, not T-4a's** (T-4a's file set no longer includes `/v1`): `actorResolver.js:39` mints `api-key:<keyId>`, no grant exists for that principal, so `engine.evaluate` returns `no_grants`. The derivation from `api_keys.createdBy` must land here or every `/v1` route 403s. `createdBy` is nullable (`schema.prisma:20`) → boot report **and** deny, never silent.

**W-9 — G8 unscoped resolves.** 18 `Workspace.get(` + 4 `WorkspaceThread.get(` in `/v1` resolve by id/slug with no relation to the key's workspace binding. `validApiKey`'s `binding` covers only routes that declare one. Every resolve authorizes against the **resolved row's** `workspaceId`.

**W-10 — G12 embed sessions.** `GET`/`DELETE /embed/:embedId/:sessionId` (`endpoints/embed/index.js:73,96`). **PR-0d already landed `embedHistoryAccess`** (`embedMiddleware.js:200-232`): UUID format check, `enabled` check, origin allowlist. What it does **not** do is bind the session to its owner — anyone who learns a valid session UUID from the same allowed origin still reads and deletes that history. The recon's "bearer-by-UUID" phrasing is the right fix: the session id must be proven, not merely well-formed (signed session cookie or an HMAC token issued at session start). **This is a design decision, not wiring — flag for PMO.** Minimum non-breaking step: `assertAuthorized` with the embed Actor + a stored session→embed binding; the unguessability upgrade can be a follow-up.

**W-11 — G10/G3 actorless jobs and channels.** `jobs/handle-telegram-chat.js`, `jobs/extract-memories.js`, `utils/agents/index.js:505`, `utils/helpers/search.js:36`, `purgeDocument.js` resolve resources with no actor. Each gets an explicit service principal (`SERVICE_PRINCIPALS.coreJobs`) or the originating user's Actor via `resolveActorRef`. **Never a null actor** — the engine denies, which is correct but would break the jobs silently rather than loudly; each site needs a chosen principal, not a default.

**W-12 — canonicalize call sites owned by T-4b.** Of the 11 legacy-`docId` sites (T-5 recon §3): `models/documents.js:224,288`, `jobs/embedding-worker.js:89-110`, `jobs/sync-watched-documents.js:133,140,149,181,188`. **T-4b does not flip `ENABLE_DOC_VECTORS_CANONICALIZE`** — per the C-1 ruling the flag flips in T-6, after the 7 non-Lance providers move. `sync-watched-documents.js` also carries PR-0e's `docpath` fix; if PR-0e has not merged, sequence it first — both touch the same lines.

## 4. RED tests (DoD)

- **S-3** (shared with T-4a) cross-workspace ids against `/v1` endpoints → denied for all 4 verbs.
- **S-9** ingress half: a key whose creator lacks the permission is denied even when the key's scope string allows it, and vice versa. (Repository half green at `engine.test.js:181`.)
- **B-1 regression** a valid key whose creator holds the grant → **allowed**. Proves `/v1` is not universally 403'd.
- **W-9** each of the 22 resolve sites: id from another workspace → denied, and the denial does not leak existence.
- **S-24 / W-10** another visitor's session id, from an allowed origin, with the embed enabled → denied. Must be RED on `3c0048b1`: PR-0d's gates all pass in that scenario.
- **W-5** a job acting as user U gets the same `workspaceIds` as U over HTTP (asserts the two Actor paths agree); `ActorIdentityStore` has no references; the Actor carries no user-row columns beyond the seam-02 shape.
- **W-11** every job/channel entry point resolves a named principal; a null actor never reaches the engine.
- **grep gates**: `grep -rn "ActorIdentityStore" server --include='*.js' | grep -v node_modules` → 0; no `Workspace.get(`/`WorkspaceThread.get(` in `endpoints/api/**` without an adjacent `assertAuthorized`.

## 5. Collisions

- **`utils/agents/**` and `utils/telegramBot/**`** — T-4b's files, but hold T-5's retrieval sites (`memory.js:94`, `telegramBot/chat/stream.js:226`) and pin sites (`agents/index.js:804`, `ephemeral.js:445`, `telegramBot/chat/stream.js:195`). PMO ruling: **not in flight simultaneously**; T-4b does actor plumbing, T-5 adds the filter argument. Sequence covers it.
- **`endpoints/api/workspace/index.js:999`** — T-4b's file, S-11's target. Same resolution.
- **`actorResolver.js`** — T-3 owns the B-2 edit; W-5 lands after it. Not concurrent.
- **`jobs/sync-watched-documents.js`** — PR-0e's line 162 vs W-12's docId sites. Sequence PR-0e first.

## 6. Estimate

5d, **assuming W-10 stays at the binding step and the unguessable-session-token upgrade is a separate issue**. B-1's derivation is ~1d and was originally scoped into T-4a; it moved here with `/v1`. If 5d must hold, W-12 is the movable piece — it has no dependents until T-6.

## §PMO rulings
- B-1 (api-key grants = grants(createdBy) ∩ scopes, createdBy null → boot report + deny) is owned by T-4b, not #25.
- W-5 urgent: ActorIdentityStore must be replaced by actorResolver; DoD test: same user via HTTP and via job yields identical workspaceIds; no user-row spread into Actor.
- W-10/G12: T-4b does session→owner binding + assertAuthorized only; unguessable embed session token (signed cookie/HMAC) = separate issue. S-24 RED must run with allowed origin + embed enabled.
- Order: PR-0e before sync-watched; T-4b → T-5; W-12 no flag flip (C-1 → T-6).
- Carry from T-3: policy.changed subscriber "authorization-cache" must land with cache wiring in T-5.
- W-8 ruling (b): grant check goes INSIDE validApiKey.js after the scope check (Dev4 owns the file from cfa3388a on; no in-flight branch touches it). Deny = 403 + `auth.grant_denied` audit event; `auth.key_used` still emitted once before. No router-level middleware. Wildcard routes (no action) skip grant check, ledgered.

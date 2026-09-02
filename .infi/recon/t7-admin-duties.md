# T-7 recon — admin duty split, view-as-user, diagnostics

Author: Dev 2 (Authorization Architect). Date: 2026-09-02. **Read-only recon — no runtime code written.**
Base: `main 731e4c1d`. Deps: T-2 `323b2256`, T-3 #22. Runs parallel to T-6.
Sources: recon §3 (T-7), §4 (S-18..S-20) · seam `02-authorization-engine.md`.

---

## 1. Duty split

`super_admin` splits into **`setup_admin`** (install/config/env/keys), **`super_admin`** (grants + org), **`content_moderator`** (other users' chats + exports). Seeded in `prisma/seeds/permissions.js` — that file is the single source for the vocabulary and the migration's step-7a INSERT is generated from it, so the split is a seed edit plus a re-generation, **not** a hand-edited migration.

**Blocker D-1 — `chat.read_others` needs re-deciding, not just moving.** The seed already has `chat.read_others` (`permissions.js:24`) *and* `chat.read` (API namespace, `:42`). Today the gate is an env var, `DISABLE_VIEW_CHAT_HISTORY`, checked by `chatHistoryViewable` at 3 route sites (`endpoints/system.js:72`, `:1188`, `:1232`; `endpoints/embedManagement.js:95`) — an **all-or-nothing kill switch**, not a per-principal permission. Its value is also mirrored into `systemSettings.js:616` and the frontend reads it from there. So the migration is: read the env var **once** to set the initial grant, delete the middleware, delete the env var from `updateENV.js:1503`, **and** replace the `systemSettings` field with a capability the UI reads — otherwise the admin UI keeps hiding a feature the engine now allows. The `systemSettings` half is not in §3's DoD; adding it here.

**Blocker D-2 — `document.bulk_export` has no route to deny.** The seed carries the action but the actual export path is `/system/export-chats` (`endpoints/system.js:1230-1241`, `exportChatsAsType`) — that is *chat* export, not document export, and it is currently gated by `chatHistoryViewable` + role. Meanwhile `document.export` exists in the seed and is deliberately excluded from `READ_ACTIONS` (`engine.js:20-22`: exporting is exfiltration, not reading). Proposal: `/system/export-chats` authorizes **`chat.read_others` AND `document.bulk_export`** — reading others' chats and bulk-extracting them are separately grantable, and the export route needs both. Confirm before the issue opens.

## 2. View-as-user

**Blocker D-3 — nothing stamps `impersonatedBy` end to end.** `actorResolver.js:56` reads `locals.impersonatedBy`; **no code writes it** (verified repo-wide). The engine's blanket deny (`engine.js:65-68`, before any policy lookup) is therefore dead code in production today — correct, tested, unreachable. T-7 owns the write side: the view-as-user session sets `locals.impersonatedBy` and the S-tests must exercise the **HTTP path**, not construct the Actor directly. A unit test that passes `{impersonatedBy}` into `authorize()` proves the engine, not the feature.

Read-only is enforced by construction in T-2 — the UI must not re-implement it.

**D-4 — `revokeGrant` has no actor guard.** `grantRole` (`policyRepository.js:79-85`) refuses a missing actor explicitly and runs the escalation guard. `revokeGrant` (`:125-138`) accepts `actor` but **never validates it and never checks permissions** — `actor: null` bumps the clock and deletes the grant. Revocation is fail-safe in direction (removing access), so this is not an escalation, but it is: an unauthenticated denial-of-service on any principal's access, and an audit gap (`granted_by` has no revoke counterpart). Once T-7 exposes grant management over HTTP this becomes reachable. **Fix in T-7: same explicit-actor requirement as `grantRole`, plus a `role.revoke` permission check.** The seed already has `role.grant` / `role.revoke` (`permissions.js:28-29`) and neither is checked anywhere today.

## 3. Owner files

`server/endpoints/admin/authorization.js` (**new**), `frontend/src/pages/Admin/Access/**` (**new**), `server/utils/middleware/chatHistoryViewable.js` (**deleted**), `server/prisma/seeds/permissions.js` (+ regenerated migration block), `server/utils/authorization/policyRepository.js` (D-4), `server/models/systemSettings.js:616` (D-1), `server/utils/helpers/updateENV.js:1503` (D-1).

Collisions: `policyRepository.js` is T-2's file — T-2 is **merged** (`323b2256`), so this is a normal edit, not a concurrent one. `endpoints/system.js` is **T-4a's** — T-7 must not edit it; the 3 `chatHistoryViewable` removals there belong to T-4a's middleware sweep. **Split: T-4a deletes the usages, T-7 deletes the middleware file and the env var.** Write this into both issues. `seeds/permissions.js` is T-1's, merged.

## 4. RED tests (DoD)

- **S-18** `explainAccess` denied without `access.diagnose`; the denial does not reveal whether the document exists.
- **S-19** `explainAccess` with `policy_versions` bumped mid-call → **fails closed**, never returns a partial principal list as complete.
- **S-20** an admin without `chat.read_others` cannot read another user's chats through **any** route — admin UI, `/system/export-chats`, and the `/v1` API.
- **D-3 e2e** a view-as-user session over HTTP attempts one write of each type (chat send, document delete, grant, settings write) → all denied with `impersonated_mutation_denied`, and the deny is audited. Must go through the real login/impersonate route.
- **D-4** `revokeGrant({actor: null, ...})` throws `AuthorizationContractError`; a principal without `role.revoke` is denied; the clock is **not** bumped on either refusal.
- **D-1** an admin with `chat.read_others` sees chat history with `DISABLE_VIEW_CHAT_HISTORY` unset **and** with the env var removed entirely; the frontend capability flips with the grant, not with the env.
- diagnostics answers "who can see doc X and why" for a doc carrying user + group + workspace-inherited grants, and is denied for a plain document reader.

## 5. Estimate

5d holds if D-1/D-2 are decided before the issue opens. D-4 is ~2h. D-3's e2e harness (a real impersonation route) is the largest unknown — if no such route exists yet, T-7 builds it, and 5d is tight.

## §PMO rulings
- D-1: chat.read_others becomes per-principal permission; DISABLE_VIEW_CHAT_HISTORY env stays as a global kill switch (deny wins) during transition; systemSettings.js:616 mirror replaced by capability from engine so UI follows policy. Impersonated: allowed only if impersonator ALSO holds chat.read_others (no privilege borrowing).
- D-2: /system/export-chats requires chat.read_others AND document.bulk_export; impersonated → deny (bulk_export in deny set).
- D-3: T-7 owns the write side of impersonatedBy (view-as-user route + locals stamp); S-tests must go through HTTP, unit-only does not count.
- D-4: revokeGrant gets the same actor guard as grantRole (null → ContractError) + revoked_by audit column via T-7 migration slot 020000 series.
- Collision: T-4a removes chatHistoryViewable usage in endpoints/system.js (3 sites); T-7 deletes middleware + env var.

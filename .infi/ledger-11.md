# Ledger — issue #11 · PR-0c cross-workspace purge IDOR (G11)

Branch: `approof/pr0c-purge-idor` · Worktree: `.claude/worktrees/pr0c`
Date: 2026-09-02 · Owner: Dev 3/4

## What

`DELETE /workspace/:slug/remove-and-unembed` (endpoints/workspaces.js:861) took a
caller-supplied `documentLocation` and passed it straight to `purgeDocument()`,
which deletes the document **system-wide**: source file, vector cache, and the
embedding in every workspace (`Workspace.where()` loop in
utils/files/purgeDocument.js). `flexUserRoleValid([admin, manager])` gates the
route, but a manager of workspace A could purge documents embedded only in
workspace B — cross-workspace IDOR with destructive effect.

New guard `canPurgeDocumentFromWorkspace` runs before the purge:
1. Document must actually be embedded in the addressed workspace (else 403).
2. Admin, or single-user mode (user null): allowed — system-wide document
   management is their role.
3. Anyone else: allowed only if the document's embeddings are confined to the
   addressed workspace; embeddings elsewhere → 403.

## Rulings

- **Ruling:** No schema change (per PMO constraint) — guard reads existing
  `workspace_documents` rows. Real ownership lives in P0-5's document ACL; this is
  the minimal pre-P0-5 containment. `ponytail:` ceiling: guard is per-route, not a
  central policy; P0-5's engine replaces it.
- **Ruling:** Admin bypass kept deliberately — matches `Workspace.getWithUser`
  (models/workspace.js:298) treating admin/manager as unscoped, and admins own
  system-wide document management. Managers lose only the cross-workspace reach.
- **Ruling:** Single-user mode (`user == null`) treated as admin-equivalent —
  there is exactly one operator; blocking them would brick document deletion.
- **Ruling:** Other `purgeDocument` call sites left alone: `/system/remove-documents`
  and `/v1/system/remove-documents` are admin/API surfaces already scoped to
  system-wide management (and get scopes in PR-4x); the embed IDOR is #12.

## Files

- `server/utils/helpers/documentPurgeGuard.js` (new)
- `server/endpoints/workspaces.js` (guard call + 403 before purge)
- `server/__tests__/endpoints/removeAndUnembedIdor.test.js` (new, 6 tests)

## Evidence

```
cd server && npx jest → Tests: 623 passed (617 baseline + 6 new)
```

Initial RED: suite failed to run — guard module absent.

### RED proofs (3 mutations, restored after each)

1. **`if (!embeddedHere)` → `if (false)`** (not-embedded check off) → 1 failed.
2. **`if (otherWorkspaces.length > 0)` → `if (false)`** (cross-workspace check off)
   → 1 failed.
3. **403 gate line removed from endpoint** → initially SURVIVED (wiring test only
   checked call order) — test strengthened to assert the verdict gates the purge
   (regex on the gate region); mutation then → 1 failed. Lesson recorded: wiring
   tests must assert consequence, not presence.

Final: 6/6 green, full suite 623/623.

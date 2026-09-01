# Ledger — issue #13 · PR-0e sync-watched bloom matches on basename (G3)

Branch: `approof/pr0e-sync-docpath` · Worktree: `.claude/worktrees/pr0e`
Date: 2026-09-02 · Owner: Dev 3/4 · Spec: docs/superpowers/design/pr-0e-sync-watched-bloom.md @ 0484b0a5 (+ PMO update 22285944)

## What

`jobs/sync-watched-documents.js` bloom query matched
`filename: document.filename` — a **basename** — across the whole instance.
Unrelated documents sharing a basename (report.json etc.) in other workspaces
had their vectors deleted and replaced with the synced document's content:
cross-tenant corruption + disclosure every sync cycle.

Fix per spec: match key `filename` → `docpath` (the identity of the physical
file `updateSourceDocument` actually rewrote). Two-line diff plus comment.

## Rulings

- **Ruling (architect, binding):** Do NOT scope by workspaceId — fan-out is
  correct because one on-disk file serves every workspace referencing the same
  docpath; dropping it reintroduces pinned-document drift. Only the match key
  changes.
- **Ruling (PMO 22285944):** `document.filename` at :94/:116/:208 untouched —
  those are DocumentSyncQueue.saveRun log/report fields where basename is
  correct. Only the `Document.where` clause (was :162) changed.
- **Ruling:** Job still writes cross-workspace with no actor (failure 2 of the
  spec) — explicitly NOT fixed here; belongs to P0-5 T-4b. This hotfix only
  guarantees the *right* document is written.
- **Ruling (test):** Replaced the static `Document.where` mock with a
  clause-aware one (generic field filter incl. `{not}`), added the attack
  fixture (same basename, docpath `connector-abc/...`, foreign-workspace).
  Attack asserts foreign namespace never receives a write and total
  addDocumentToNamespace calls = 2. Regression test now also asserts the bloom
  targets `other-workspace`'s namespace (mutation 3 exposed that gap).

## Files

- `server/jobs/sync-watched-documents.js` (match clause)
- `server/__tests__/jobs/sync-watched-documents.test.js` (clause-aware mock,
  attack case, strengthened regression assert)

## Evidence

```
cd server && npx jest → Tests: 618 passed (617 baseline + 1 new; 2 existing re-pointed)
```

RED before fix: attack case failed — bloomedSlugs contained "foreign-workspace"
(job called addDocumentToNamespace 3× including the foreign namespace).

### RED proofs (3 mutations, restored after each)

1. **Revert clause to `filename`** → 1 failed (attack case).
2. **Kill fan-out (impossible clause)** → initially SURVIVED with the
   hand-rolled per-field mock (ignored unknown keys) — mock made generic over
   all clause fields → 2 failed (both bloom tests). Same lesson as #11: mocks
   must honor the full contract, not the fields you expected.
3. **Bloom writes to source slug instead of matched row's** → initially
   SURVIVED (regression test checked payload, not namespace) — assert
   `bloomedSlug === "other-workspace"` added → 1 failed.

Final: 3/3 green, full suite 618/618.

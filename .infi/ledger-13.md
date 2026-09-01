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

## QA-2 round 2 — documentSyncQueue keyed by basename (fixed)

QA-2 ran the real exploit against `models/documentSyncQueue.js`: tenant A calls
`unwatch(docA)` → tenant B's queue was **deleted** and B's `watched` flag
**cleared** — pure basename collision, cross-tenant DoS. Symmetrically, `watch`
threw "already has a queue" for tenant B's own file because A's same-basename
file was watched. Four selection keys (:99, :116 watch; :138, :142 unwatch)
changed `filename` → `docpath`, same rationale and identity as the job fix.

DB-level proof added (`documentSyncQueueSelection.dbtest.js`): real prisma
client on a pushed temp SQLite schema, real model code, no mocks. Cases: A's
unwatch touches only A (B's queue + watched flag intact); B can watch its own
file while A's same-basename file is watched. Mutation reverting one selection
key to `filename` → 1 DB test fails.

### Rulings (round 2)

- **Ruling (PMO team rule, adopted):** model-finder mocks used in
  selection-sensitive tests must filter on the clause — static
  `mockResolvedValue` is banned there. This suite avoids the question by using
  a real DB.
- **Ruling:** temp-schema-copy + `prisma db push` per suite run (schema's
  datasource url is a hardcoded sqlite path, so the copy re-points it). ~1s;
  teardown removes the tmpdir.

### Evidence (round 2)

Full suite **620/620** (617 baseline + 1 job test + 2 DB tests).

- **DoD (e5 round-3 rule):** `filename` is display-only, never a where clause:
  `grep -rn "where.*filename" server/models server/jobs` → **0 matches** on this
  branch (verified; the only schema-sanctioned exception is
  `workspace_parsed_files.filename`, which is `@unique` by design). New code
  keeping this invariant is reviewed against the same grep.
- **Confirmed to e5:** `sync-watched-documents.js:158-163` (the bloom clause)
  was fixed in the FIRST commit of this branch (5b67aa50, `docpath` key); the
  round-2 commit (6871ec01) added documentSyncQueue + the DB suite. e5 read a
  stale branch.

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

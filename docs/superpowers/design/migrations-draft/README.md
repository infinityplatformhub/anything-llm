# T-1 migration drafts — ready to copy into the T-1 worktree when #5 merges

Status: **draft, reviewed by architect before any runtime commit.** Source of truth for content: `p0-5-t1-schema-detail.md` (7-step binding order) + `p0-5-authorization-recon.md` §2.

Files:
- `01_ddl.sql` — step 1 (all DDL, additive only)
- `02_backfill.sql` — steps 2–6 (created_by, canonical dedupe, inherited ACL, legacy roles, workspace_users.role_id) + inline RAISE NOTICE reports
- `03_reports.sql` — the three standalone reports (manager downgrades, dedupe groups, created_by nulls)
- `seed-permissions.js` — vocabulary + system roles + matrix + single-user service principal
- `job-doc-vectors-canonicalize.js` — post-migration batched rewrite (runs via P0-6 queue, after #5)
- `vocabulary-diff.test.js` — seed ↔ live `requireScope()` call sites diff, works regardless of P0-4 merge order

## Rollback plan (per step)

| Step | Reversible? | Rollback |
|---|---|---|
| 1 DDL (new tables/columns) | yes | `DROP TABLE`×8, `DROP COLUMN`×4 — nothing reads them yet (T-2+ not shipped) |
| 2 created_by backfill | yes | `UPDATE workspaces SET created_by = NULL` — column is additive, no consumer until T-4 |
| 3 canonical dedupe | **partially** | `documents` rows deletable + `workspace_documents.documentId = NULL` — BUT only before step 4 writes ACL rows referencing them; after step 4, must cascade delete `document_acl` first |
| 4 inherited ACL rows | yes | `DELETE FROM document_acl WHERE source = 'inherited_workspace'` — identifiable by source, never mixed with manual grants (unique constraint keeps them in the workspace-principal namespace) |
| 5 legacy role grants | **one-way by design (A-R4)** | no rollback migration — recovery = manual re-grant. This is why the downgrade report (03) is a migration artifact, not console output |
| 6 workspace_users.role_id | yes | `UPDATE workspace_users SET role_id = NULL` |
| 7 seeds | yes | `DELETE` by `isSystem` flag / known ids |
| vectors canonicalize job | **no** once `document_vectors.docId` is rewritten | job keeps a `legacy_docid_map` audit table so the rewrite is traceable; recovery from map, not from migration rollback |

**Mid-flight failure rule**: steps run inside one transaction each; a failed step leaves prior steps committed but never a half-step. Prisma applies each migration file atomically. Step 5 prints its report *before* writing grants (RAISE NOTICE inside the same transaction) so a failed run still surfaces who would be downgraded.

## Conventions & deliberate deviations

- **`SERIAL` PKs, not `GENERATED ... AS IDENTITY`** (deviates from infi-stack `prefer-identity`): the entire existing schema is Prisma-generated `SERIAL` (verified: `20260902000000_init/migration.sql`). Hand-writing identity columns here makes `prisma migrate` see every new table as drifted from `schema.prisma`. Consistency with the migration toolchain outranks the standalone-DB rule; revisit only if the repo later moves off Prisma migrations.
- **`INTEGER` PKs/FKs, not `bigint`** (deviates from infi-stack `prefer-bigint-over-int`): matches the approved schema (recon §2 / t1-detail, all `Int`) and every existing table. Org-scoped grant/document volumes are far below the int ceiling; `policy_versions.version` IS bigint.
- `timestamptz(3)` everywhere (P0-2 already standardized this — `ad67f8fe`).
- **`documents.dedupe_key TEXT UNIQUE NOT NULL`** — not just a migration helper: runtime ingest (T-2+) resolves canonical-by-docpath on every `addDocuments`, so the uniqueness has to live in the schema, not in a migration-time temp table.
- FK actions explicit; every FK column indexed (see `01_ddl.sql`); `principal_id` is TEXT (string namespace — the single-user principal is `'single-user'`, never integer `0`).

## Vocabulary diff contract with P0-4

P0-4's route→scope table does not exist in `approof/main` yet (P0-4 unmerged). The diff test therefore reads **live source**: it greps every `requireScope("…")` call in `server/` and diffs against the seeded `permissions.action` set. Empty diff = pass, regardless of which of P0-4/T-1 merges first. New scope without a seeded permission fails CI with the exact missing string.

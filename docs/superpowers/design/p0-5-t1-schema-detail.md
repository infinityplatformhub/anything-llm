# P0-5 T-1 — Schema + migration detail

Status: **dispatch-ready detail — awaiting #4 (P0-2) / #5 (P0-4) merge before any migration is written.**
Author: implementation owner (Dev 4). Sign-off: architect (anything-llm-8b) 2026-09-02 — 4 amendments applied: dedupe key = `docpath` GROUP BY (not 1:1 location), **no `checksum` column**, `pinned`/`watched` stay on `workspace_documents`, vocabulary = 9 document actions (no `document.embed`/`document.unembed`).
Source plan: `p0-5-authorization-recon.md` §2 + PMO rulings R1–R5 + G14/G15 rulings.

## 1. Schema additions (Prisma, additive only)

### Canonical document (G15)

```prisma
model documents {
  id        Int      @id @default(autoincrement())
  orgId     Int      @default(1)          // R2: singleton org, no organizations model
  ownerId   Int?
  filename  String
  mime      String?
  metadata  String   @default("{}")       // merged from lowest workspace id on conflict; per-workspace state NOT merged
  createdAt DateTime @default(now())

  workspace_documents workspace_documents[]
  document_acl        document_acl[]
}

model workspace_documents {
  // existing columns unchanged, including docId (frozen: document_vectors still references it until backfill job completes)
  documentId Int?
  documents  documents? @relation(fields: [documentId], references: [id])
  // pinned/watched/docPath/metadata/workspaceId stay here — per-workspace state (architect ruling)
}
```

### Policy store (unchanged from recon §2 except FK retarget)

- `permissions`, `roles`, `role_permissions`, `principal_role_grants`, `groups`, `group_members`, `policy_versions` — exactly as recon §2.
- `document_acl.document_id` → **canonical `documents.id`** (not `workspace_documents.docId`).
- `document_visibility.document_id` → canonical `documents.id`.

### Column additions on existing models

- `workspaces.created_by Int?` (R1).
- `workspace_users.role_id Int?` (FK `roles`).
- `users.role` — **frozen, not dropped, not renamed** (R4). Read only by the backfill below.

### G14 — transactional membership/grant writes

Schema-level only in T-1: no constraint can enforce atomicity of the delete-then-create in `Workspace.updateUsersPerWorkspace` — that code path is rewritten in T-3 (policy_version bump inside one transaction). T-1 ships the `policy_versions` table the transaction stamps.

## 2. Vocabulary seed (`server/prisma/seeds/permissions.js`)

Scope strings are seam 02 action names verbatim (P0-4 R3 — the same namespace P0-4 uses for API-key scopes; seed every name P0-4 Step 2 uses so no second mapping layer can appear).

**Document (9)**: `document.create`, `document.read`, `document.search`, `document.update`, `document.delete`, `document.share`, `document.pin`, `document.watch`, `document.export`.

**Workspace**: `workspace.read`, `workspace.write`, `workspace.delete`, `workspace.members.manage`.

**Chat/admin**: `chat.read_others`, `chat.send`, `document.bulk_export`, `access.diagnose`, `role.grant`, `role.revoke`, `sso.issue`, `key.manage`, `settings.write`, `user.manage`.

Final list cross-checked against P0-4 Step 2 route-scope table at implementation time; any name P0-4 already shipped must exist here unchanged.

**System roles (5)**: `super_admin` (org), `setup_admin` (org), `content_moderator` (org), `member` (org), and workspace-scope `owner`/`editor`/`viewer`. `role_permissions` seeded per matrix in T-2 tests.

## 3. Migration steps (order is binding)

1. **org default**: every new table ships `orgId Int @default(1)` (R2). No row-level backfill needed.
2. **`workspaces.created_by`**: per workspace, earliest `workspace_users` row (lowest id, tie-break createdAt) → that `user_id`. No membership row → null + workspace slug in report.
3. **Canonical dedupe**: `GROUP BY docpath` over `workspace_documents`. Per group: insert one `documents` row taking `filename`/`mime`/`metadata` from the lowest workspace id; set `documentId` on every member row. Never merge `pinned`/`watched`. Report: groups with N>1 members, and groups whose metadata differed across workspaces. **Pre-check**: report any row with null/empty `docpath` before grouping — each such row becomes its own canonical document (never grouped), listed in the report; verify whether any exist on real data.
4. **`document_acl` inherited grants**: for every (workspace, canonical document) relation, insert `action="document.read"` and `action="document.search"`, `principal_type="workspace"`, `principal_id=<workspaceId>`, `source="inherited_workspace"`, stamped with current `policy_versions` head. Unique constraint `[document_id, principal_type, principal_id, action]` does not collide with future manual grants (`"user"`/`"group"` principals). **Batch inserts only** — row count is 2 × workspace_documents count (a 10k-document instance inserts ~100k rows); never a per-row loop.
5. **Legacy role backfill (R4, one-way)**: `users.role="admin"` → org grant `super_admin`; `"manager"` → workspace grant `owner` on workspaces where `created_by = user`, plus org `member`; `"default"` → org `member`. Report every manager losing global read (name + workspace count kept vs lost).
6. **`workspace_users.role_id`**: `owner` where `created_by` matches; else `member`.
7. **Seeds** from §2.

All steps idempotent (re-runnable — meaning the seed/backfill statements: ON CONFLICT inserts, COALESCE updates, and the step-6 `policy_versions` marker guard; the DDL itself is applied exactly once by Prisma); each writes a `policy_versions` row per change_type.

## 4. Post-migration backfill job (P0-6 queue, NOT inline)

Single ordered chain — two jobs sharing one table surface must not run in parallel (architect condition):

1. `doc-vectors-canonicalize`: batched rewrite `document_vectors.docId` → canonical `documents.id` (via `workspace_documents.docpath → documentId` mapping).
2. `vector-metadata-backfill` (T-5): adds `orgId/workspaceId/hidden/aclKey` to vector rows in the provider.

Gate: `queryAuthorized` is not live until job 1 completes (and T-5's job 2 for each provider); any vector row lacking ACL metadata is **denied, fail-closed** (G4) — the gate is enforced by the provider capability check, not by trust in backfill completeness.

## 5. DoD

- [ ] `prisma migrate deploy` clean on empty Postgres; the **seed/backfill block** is re-runnable without error (all writes are ON CONFLICT/COALESCE/marker-guarded). The DDL block is NOT re-runnable at bare-psql level (`ADD COLUMN already exists`, no IF NOT EXISTS) — Prisma never re-runs an applied migration, so this is by design, not an omission (QA-1 minor a, ruled 2026-09-02).
- [ ] Reports from steps 2/3/5 committed as migration artifacts (created_by nulls, dedupe groups, manager downgrades).
- [ ] Every legacy user has ≥1 `principal_role_grants` row; `users.role` values byte-identical before/after (frozen).
- [ ] Every `workspace_documents` row has `documentId` set; count of `documents` rows = distinct `docpath` count.
- [ ] Every (workspace, document) relation has exactly 2 `inherited_workspace` ACL rows (read+search).
- [ ] Vocabulary seed covers every scope string P0-4 shipped — diff test against P0-4's scope table = empty.
- [ ] `document_vectors` canonicalize job processes a sample corpus and is idempotent on re-run.
- [ ] No runtime code paths changed — this task touches schema, migrations, seeds, and the queue job only. Route/model code lands in T-2+.

-- T-1 migration 0001 — DDL only (step 1 of the binding order). Additive; nothing reads these until T-2+.
-- Conventions verified against server/prisma/migrations/20260902000000_init/migration.sql (P0-2):
--   every identifier quoted, SERIAL PKs, CURRENT_TIMESTAMP defaults (not now()), timestamptz(3).

-- ---- policy vocabulary ----
CREATE TABLE "permissions" (
  "id" SERIAL NOT NULL,
  "action" TEXT NOT NULL UNIQUE,
  "description" TEXT NOT NULL DEFAULT '',
  "category" TEXT NOT NULL DEFAULT '',
  CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "roles" (
  "id" SERIAL NOT NULL,
  "name" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "orgId" INTEGER NOT NULL DEFAULT 1,
  "isSystem" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "roles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "roles_org_scope_name_key" UNIQUE ("orgId", "scope", "name")
);

CREATE TABLE "role_permissions" (
  "role_id" INTEGER NOT NULL,
  "permission_id" INTEGER NOT NULL,
  "effect" TEXT NOT NULL DEFAULT 'allow',
  CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id", "permission_id"),
  CONSTRAINT "role_permissions_effect_check" CHECK ("effect" IN ('allow','deny'))
);
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");

-- ---- THE reverse-queryable grant table ----
CREATE TABLE "principal_role_grants" (
  "id" SERIAL NOT NULL,
  "orgId" INTEGER NOT NULL DEFAULT 1,
  "principal_type" TEXT NOT NULL,
  "principal_id" TEXT NOT NULL,
  "role_id" INTEGER NOT NULL,
  "workspace_id" INTEGER,
  "granted_by" INTEGER,
  "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3),
  "policy_version" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "principal_role_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "prg_unique" UNIQUE ("orgId", "principal_type", "principal_id", "role_id", "workspace_id")
);
CREATE INDEX "prg_forward" ON "principal_role_grants"("principal_type", "principal_id", "workspace_id");
CREATE INDEX "prg_reverse" ON "principal_role_grants"("workspace_id", "role_id");
CREATE INDEX "prg_role_id_idx" ON "principal_role_grants"("role_id");

-- ---- groups ----
CREATE TABLE "groups" (
  "id" SERIAL NOT NULL,
  "orgId" INTEGER NOT NULL DEFAULT 1,
  "name" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'local',
  "externalId" TEXT,
  CONSTRAINT "groups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "groups_org_name_key" UNIQUE ("orgId", "name")
);

CREATE TABLE "group_members" (
  "group_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  CONSTRAINT "group_members_pkey" PRIMARY KEY ("group_id", "user_id")
);
CREATE INDEX "gm_user_reverse" ON "group_members"("user_id");

-- ---- canonical document (G15) ----
CREATE TABLE "documents" (
  "id" SERIAL NOT NULL,
  "orgId" INTEGER NOT NULL DEFAULT 1,
  "owner_id" INTEGER,
  "filename" TEXT NOT NULL,
  "dedupe_key" TEXT NOT NULL UNIQUE,
  "metadata" TEXT NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "workspace_documents" ADD COLUMN "documentId" INTEGER;
CREATE INDEX "wd_document_fk" ON "workspace_documents"("documentId");

-- ---- document ACL + visibility ----
CREATE TABLE "document_acl" (
  "id" SERIAL NOT NULL,
  "orgId" INTEGER NOT NULL DEFAULT 1,
  "document_id" INTEGER NOT NULL,
  "principal_type" TEXT NOT NULL,
  "principal_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "effect" TEXT NOT NULL DEFAULT 'allow',
  "source" TEXT NOT NULL DEFAULT 'manual',
  "granted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "policy_version" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "document_acl_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "document_acl_unique" UNIQUE ("document_id", "principal_type", "principal_id", "action")
);
CREATE INDEX "dacl_forward" ON "document_acl"("principal_type", "principal_id", "action");
CREATE INDEX "dacl_reverse" ON "document_acl"("document_id");
CREATE INDEX "dacl_source" ON "document_acl"("orgId", "source");

CREATE TABLE "document_visibility" (
  "document_id" INTEGER NOT NULL,
  "hidden" BOOLEAN NOT NULL DEFAULT false,
  "hidden_by" INTEGER,
  "hidden_at" TIMESTAMPTZ(3),
  "reason" TEXT,
  CONSTRAINT "document_visibility_pkey" PRIMARY KEY ("document_id")
);

-- ---- monotonic policy clock (residual risks #2/#3) ----
CREATE TABLE "policy_versions" (
  "version" BIGSERIAL NOT NULL,
  "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "change_type" TEXT NOT NULL,
  "scope_key" TEXT NOT NULL,
  "actor_id" INTEGER,
  CONSTRAINT "policy_versions_pkey" PRIMARY KEY ("version")
);

-- ---- additions to existing models ----
ALTER TABLE "workspaces" ADD COLUMN "created_by" INTEGER;
ALTER TABLE "workspace_users" ADD COLUMN "role_id" INTEGER;
CREATE INDEX "workspace_users_role_id_idx" ON "workspace_users"("role_id");
-- users.role: frozen per R4 — no DDL change.

-- ---- FKs declared after all tables exist (matching Prisma's declaration shape) ----
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey"
  FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey"
  FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "principal_role_grants" ADD CONSTRAINT "prg_role_fkey"
  FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- groups.orgId: no FK — org singleton, column is constant 1 per R2 until an organizations table exists.
ALTER TABLE "group_members" ADD CONSTRAINT "gm_group_fkey"
  FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "group_members" ADD CONSTRAINT "gm_user_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_documents" ADD CONSTRAINT "wd_document_fkey"
  FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "document_acl" ADD CONSTRAINT "dacl_document_fkey"
  FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_acl" ADD CONSTRAINT "dacl_action_fkey"
  FOREIGN KEY ("action") REFERENCES "permissions"("action") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "document_visibility" ADD CONSTRAINT "dvis_document_fkey"
  FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workspace_users" ADD CONSTRAINT "wu_role_fkey"
  FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- audit map for the doc-vectors canonicalize job (ships with the job, not referenced by runtime reads)
CREATE TABLE "legacy_docid_map" (
  "id" SERIAL NOT NULL,
  "legacy_doc_id" TEXT NOT NULL UNIQUE,
  "canonical_id" INTEGER NOT NULL,
  "mapped_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "legacy_docid_map_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ldm_canonical_fkey" FOREIGN KEY ("canonical_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

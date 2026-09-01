-- AlterTable
ALTER TABLE "workspace_documents" ADD COLUMN     "documentId" INTEGER;

-- AlterTable
ALTER TABLE "workspace_users" ADD COLUMN     "role_id" INTEGER;

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "created_by" INTEGER;

-- CreateTable
CREATE TABLE "permissions" (
    "id" SERIAL NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "orgId" INTEGER NOT NULL DEFAULT 1,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" INTEGER NOT NULL,
    "permission_id" INTEGER NOT NULL,
    "effect" TEXT NOT NULL DEFAULT 'allow',

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
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

    CONSTRAINT "principal_role_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" SERIAL NOT NULL,
    "orgId" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'local',
    "externalId" TEXT,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "group_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("group_id","user_id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" SERIAL NOT NULL,
    "orgId" INTEGER NOT NULL DEFAULT 1,
    "owner_id" INTEGER,
    "filename" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
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

    CONSTRAINT "document_acl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_visibility" (
    "document_id" INTEGER NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "hidden_by" INTEGER,
    "hidden_at" TIMESTAMPTZ(3),
    "reason" TEXT,

    CONSTRAINT "document_visibility_pkey" PRIMARY KEY ("document_id")
);

-- CreateTable
CREATE TABLE "policy_versions" (
    "version" BIGSERIAL NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "change_type" TEXT NOT NULL,
    "scope_key" TEXT NOT NULL,
    "actor_id" INTEGER,

    CONSTRAINT "policy_versions_pkey" PRIMARY KEY ("version")
);

-- CreateTable
CREATE TABLE "legacy_docid_map" (
    "id" SERIAL NOT NULL,
    "legacy_doc_id" TEXT NOT NULL,
    "canonical_id" INTEGER NOT NULL,
    "mapped_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legacy_docid_map_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "permissions_action_key" ON "permissions"("action");

-- CreateIndex
CREATE INDEX "permissions_category_idx" ON "permissions"("category");

-- CreateIndex
CREATE UNIQUE INDEX "roles_orgId_scope_name_key" ON "roles"("orgId", "scope", "name");

-- CreateIndex
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");

-- CreateIndex
CREATE INDEX "principal_role_grants_principal_type_principal_id_workspace_idx" ON "principal_role_grants"("principal_type", "principal_id", "workspace_id");

-- CreateIndex
CREATE INDEX "principal_role_grants_workspace_id_role_id_idx" ON "principal_role_grants"("workspace_id", "role_id");

-- CreateIndex
-- T-1: NULLS NOT DISTINCT (PG15+) — org-wide grants have workspace_id NULL and a plain
-- unique index lets them duplicate on re-runs (found by 8b live run). Prisma cannot express it.
CREATE UNIQUE INDEX "principal_role_grants_orgId_principal_type_principal_id_rol_key" ON "principal_role_grants"("orgId", "principal_type", "principal_id", "role_id", "workspace_id") NULLS NOT DISTINCT;

-- CreateIndex
CREATE UNIQUE INDEX "groups_orgId_name_key" ON "groups"("orgId", "name");

-- CreateIndex
CREATE INDEX "group_members_user_id_idx" ON "group_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "documents_dedupe_key_key" ON "documents"("dedupe_key");

-- CreateIndex
CREATE INDEX "documents_orgId_idx" ON "documents"("orgId");

-- CreateIndex
CREATE INDEX "document_acl_principal_type_principal_id_action_idx" ON "document_acl"("principal_type", "principal_id", "action");

-- CreateIndex
CREATE INDEX "document_acl_document_id_idx" ON "document_acl"("document_id");

-- CreateIndex
CREATE INDEX "document_acl_orgId_source_idx" ON "document_acl"("orgId", "source");

-- CreateIndex
CREATE UNIQUE INDEX "document_acl_document_id_principal_type_principal_id_action_key" ON "document_acl"("document_id", "principal_type", "principal_id", "action");

-- CreateIndex
CREATE INDEX "policy_versions_scope_key_idx" ON "policy_versions"("scope_key");

-- CreateIndex
CREATE UNIQUE INDEX "legacy_docid_map_legacy_doc_id_key" ON "legacy_docid_map"("legacy_doc_id");

-- AddForeignKey
ALTER TABLE "workspace_documents" ADD CONSTRAINT "workspace_documents_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workspace_users" ADD CONSTRAINT "workspace_users_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "principal_role_grants" ADD CONSTRAINT "principal_role_grants_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_acl" ADD CONSTRAINT "document_acl_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_acl" ADD CONSTRAINT "document_acl_action_fkey" FOREIGN KEY ("action") REFERENCES "permissions"("action") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_visibility" ADD CONSTRAINT "document_visibility_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legacy_docid_map" ADD CONSTRAINT "legacy_docid_map_canonical_id_fkey" FOREIGN KEY ("canonical_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ===== T-1 seed + backfill (steps 2–7, architect-signed; live-verified 3 re-runs on PG17) =====

-- ---- step 7a
-- vocabulary + system roles (generated from server/prisma/seeds/permissions.js —
-- do not hand-edit; regenerate from the seed file) ----
INSERT INTO "permissions" ("action", "description", "category") VALUES
  ('access.diagnose', 'Access.diagnose', 'access'),
  ('agent-flow.read', 'Agent-flow.read', 'agentFlow'),
  ('agent-flow.write', 'Agent-flow.write', 'agentFlow'),
  ('browser-extension.read', 'Browser-extension.read', 'browserExtension'),
  ('browser-extension.write', 'Browser-extension.write', 'browserExtension'),
  ('chat.read', 'Chat.read', 'chat'),
  ('chat.read_others', 'Chat.read_others', 'chat'),
  ('chat.send', 'Chat.send', 'chat'),
  ('chat.write', 'Chat.write', 'chat'),
  ('document.bulk_export', 'Document.bulk_export', 'document'),
  ('document.create', 'Document.create', 'document'),
  ('document.delete', 'Document.delete', 'document'),
  ('document.export', 'Document.export', 'document'),
  ('document.pin', 'Document.pin', 'document'),
  ('document.read', 'Document.read', 'document'),
  ('document.search', 'Document.search', 'document'),
  ('document.share', 'Document.share', 'document'),
  ('document.update', 'Document.update', 'document'),
  ('document.watch', 'Document.watch', 'document'),
  ('document.write', 'Document.write', 'document'),
  ('embed.delete', 'Embed.delete', 'embed'),
  ('embed.read', 'Embed.read', 'embed'),
  ('embed.write', 'Embed.write', 'embed'),
  ('invite.create', 'Invite.create', 'invite'),
  ('invite.delete', 'Invite.delete', 'invite'),
  ('invite.read', 'Invite.read', 'invite'),
  ('key.manage', 'Key.manage', 'key'),
  ('mcp-server.read', 'Mcp-server.read', 'mcpServer'),
  ('mcp-server.write', 'Mcp-server.write', 'mcpServer'),
  ('memory.read', 'Memory.read', 'memory'),
  ('memory.write', 'Memory.write', 'memory'),
  ('model-router.read', 'Model-router.read', 'modelRouter'),
  ('model-router.write', 'Model-router.write', 'modelRouter'),
  ('role.grant', 'Role.grant', 'role'),
  ('role.revoke', 'Role.revoke', 'role'),
  ('scheduled-job.read', 'Scheduled-job.read', 'scheduledJob'),
  ('scheduled-job.write', 'Scheduled-job.write', 'scheduledJob'),
  ('settings.write', 'Settings.write', 'settings'),
  ('sso.issue', 'Sso.issue', 'sso'),
  ('system.read', 'System.read', 'system'),
  ('system.write', 'System.write', 'system'),
  ('telegram.read', 'Telegram.read', 'telegram'),
  ('telegram.write', 'Telegram.write', 'telegram'),
  ('user.manage', 'User.manage', 'user'),
  ('user.read', 'User.read', 'user'),
  ('user.write', 'User.write', 'user'),
  ('workspace.delete', 'Workspace.delete', 'workspace'),
  ('workspace.members.manage', 'Workspace.members.manage', 'workspace'),
  ('workspace.read', 'Workspace.read', 'workspace'),
  ('workspace.write', 'Workspace.write', 'workspace')
ON CONFLICT ("action") DO NOTHING;

INSERT INTO "roles" ("name", "scope", "orgId", "isSystem") VALUES
  ('super_admin','org',1,true),
  ('setup_admin','org',1,true),
  ('content_moderator','org',1,true),
  ('member','org',1,true),
  ('owner','workspace',1,true),
  ('editor','workspace',1,true),
  ('viewer','workspace',1,true)
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r CROSS JOIN "permissions" p
WHERE r."name" = 'super_admin' AND r."scope" = 'org'
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r JOIN "permissions" p ON p."action" IN
  ('settings.write','user.manage','key.manage','sso.issue','workspace.read','access.diagnose','role.grant','role.revoke')
WHERE r."name" = 'setup_admin' AND r."scope" = 'org'
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r JOIN "permissions" p ON p."action" IN
  ('chat.read_others','document.read','document.search','document.update','document.delete','document.bulk_export','access.diagnose')
WHERE r."name" = 'content_moderator' AND r."scope" = 'org'
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r JOIN "permissions" p ON p."action" IN
  ('workspace.read','workspace.write','chat.send','document.create','document.read','document.search',
   'document.update','document.pin','document.watch','document.share')
WHERE r."name" = 'member' AND r."scope" = 'org'
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r JOIN "permissions" p ON p."action" IN
  ('workspace.read','workspace.write','workspace.delete','workspace.members.manage','chat.send',
   'document.create','document.read','document.search','document.update','document.delete',
   'document.share','document.pin','document.watch','document.export')
WHERE r."name" = 'owner' AND r."scope" = 'workspace'
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r JOIN "permissions" p ON p."action" IN
  ('workspace.read','workspace.write','chat.send','document.create','document.read','document.search',
   'document.update','document.delete','document.pin','document.watch')
WHERE r."name" = 'editor' AND r."scope" = 'workspace'
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r JOIN "permissions" p ON p."action" IN
  ('workspace.read','document.read','document.search','chat.send')
WHERE r."name" = 'viewer' AND r."scope" = 'workspace'
ON CONFLICT DO NOTHING;

-- ---- step 2: workspaces.created_by (R1) — earliest workspace_users row ----
UPDATE "workspaces" w
SET "created_by" = sub.user_id
FROM (
  SELECT workspace_id, user_id,
         ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY id) AS rn
  FROM "workspace_users"
) sub
WHERE w."id" = sub.workspace_id AND sub.rn = 1 AND w."created_by" IS NULL;

DO $$ DECLARE n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM "workspaces" WHERE "created_by" IS NULL;
  RAISE NOTICE 'T-1 report [created_by_nulls]: % workspaces without membership rows (no owner assigned)', n;
END $$;

-- ---- step 3: canonical documents — GROUP BY docpath (TWO SEPARATE STATEMENTS on purpose:
-- a data-modifying CTE is invisible to other sub-statements in the same statement) ----
DO $$ DECLARE n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM "workspace_documents" WHERE docpath = ''; -- column is NOT NULL; only '' is possible
  RAISE NOTICE 'T-1 pre-check [docpath_empty]: % rows with empty docpath — each becomes its own canonical document', n;
END $$;

WITH "firsts" AS (
  SELECT DISTINCT ON (COALESCE(NULLIF(docpath, ''), 'orphan:' || "docId")) filename, metadata,
         COALESCE(NULLIF(docpath, ''), 'orphan:' || "docId") AS dedupe_key
  FROM "workspace_documents"
  ORDER BY COALESCE(NULLIF(docpath, ''), 'orphan:' || "docId"), "workspaceId", "id"
)
INSERT INTO "documents" ("orgId", "filename", "dedupe_key", "metadata")
SELECT 1, filename, dedupe_key, COALESCE(metadata, '{}') FROM "firsts"
ON CONFLICT ("dedupe_key") DO NOTHING;

UPDATE "workspace_documents" wd
SET "documentId" = d."id"
FROM "documents" d
WHERE d."dedupe_key" = COALESCE(NULLIF(wd.docpath, ''), 'orphan:' || wd."docId")
  AND wd."documentId" IS NULL;

DO $$ DECLARE groups_n INTEGER; BEGIN
  SELECT count(DISTINCT COALESCE(NULLIF(docpath, ''), 'orphan:' || "docId")) INTO groups_n FROM "workspace_documents";
  RAISE NOTICE 'T-1 report [dedupe_groups]: % canonical document groups', groups_n;
END $$;

-- ---- step 4: inherited_workspace ACL grants — batch inserts only ----
WITH pv AS (INSERT INTO "policy_versions" ("change_type", "scope_key") VALUES ('document_acl','org:1') RETURNING "version")
INSERT INTO "document_acl" ("orgId", "document_id", "principal_type", "principal_id", "action", "source", "policy_version")
SELECT 1, wd."documentId", 'workspace', wd."workspaceId"::text, p.action, 'inherited_workspace', pv."version"
FROM "workspace_documents" wd
CROSS JOIN (SELECT unnest(ARRAY['document.read','document.search']) AS action) p
CROSS JOIN pv
WHERE wd."documentId" IS NOT NULL
ON CONFLICT DO NOTHING;

-- ---- step 5: legacy role backfill (R4 — one-way, report BEFORE grants) ----
DO $$ DECLARE n INTEGER; BEGIN
  SELECT count(*) INTO n FROM "users" WHERE "role" = 'manager';
  RAISE NOTICE 'T-1 report [manager_downgrade]: % managers lose global read; keep owner grants on workspaces they created', n;
END $$;

WITH pv AS (INSERT INTO "policy_versions" ("change_type", "scope_key") VALUES ('grant','org:1') RETURNING "version")
INSERT INTO "principal_role_grants" ("orgId", "principal_type", "principal_id", "role_id", "workspace_id", "policy_version")
SELECT 1, 'user', u."id"::text, (SELECT "id" FROM "roles" WHERE "name"='super_admin' AND "scope"='org'), NULL, pv."version"
FROM "users" u CROSS JOIN pv WHERE u."role" = 'admin'
ON CONFLICT DO NOTHING;

WITH pv AS (INSERT INTO "policy_versions" ("change_type", "scope_key") VALUES ('grant','org:1') RETURNING "version")
INSERT INTO "principal_role_grants" ("orgId", "principal_type", "principal_id", "role_id", "workspace_id", "policy_version")
SELECT 1, 'user', u."id"::text, (SELECT "id" FROM "roles" WHERE "name"='member' AND "scope"='org'), NULL, pv."version"
FROM "users" u CROSS JOIN pv WHERE u."role" IN ('manager','default')
ON CONFLICT DO NOTHING;

WITH pv AS (INSERT INTO "policy_versions" ("change_type", "scope_key") VALUES ('grant','org:1') RETURNING "version")
INSERT INTO "principal_role_grants" ("orgId", "principal_type", "principal_id", "role_id", "workspace_id", "policy_version")
SELECT 1, 'user', w."created_by"::text, (SELECT "id" FROM "roles" WHERE "name"='owner' AND "scope"='workspace'), w."id", pv."version"
FROM "workspaces" w CROSS JOIN pv WHERE w."created_by" IS NOT NULL
ON CONFLICT DO NOTHING;

-- single-user service principal (T-2 resolver): always seeded, consumed only in single-user mode
WITH pv AS (INSERT INTO "policy_versions" ("change_type", "scope_key") VALUES ('grant','org:1') RETURNING "version")
INSERT INTO "principal_role_grants" ("orgId", "principal_type", "principal_id", "role_id", "workspace_id", "policy_version")
SELECT 1, 'service', 'single-user', (SELECT "id" FROM "roles" WHERE "name"='super_admin' AND "scope"='org'), NULL, pv."version"
FROM pv
ON CONFLICT DO NOTHING;

-- ---- step 6: workspace_users.role_id (workspace-scope roles only) ----
-- Guarded by a policy_versions marker: without it, a bare COALESCE re-run would resurrect
-- any row an admin deliberately set back to NULL after the migration (QA-1 finding 3).
UPDATE "workspace_users" wu
SET "role_id" = (SELECT "id" FROM "roles" WHERE "name"='owner' AND "scope"='workspace')
WHERE EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = wu.workspace_id AND w."created_by" = wu.user_id)
  AND NOT EXISTS (SELECT 1 FROM "policy_versions" WHERE change_type = 'workspace_role_backfill');

-- Default members get workspace role 'editor', NOT 'viewer': legacy default users could upload,
-- update and delete documents in workspaces they belong to — editor is the closest behavioral
-- match; viewer (read+chat only) would silently revoke upload on migration day.
UPDATE "workspace_users" wu
SET "role_id" = COALESCE(wu."role_id", (SELECT "id" FROM "roles" WHERE "name"='editor' AND "scope"='workspace'))
WHERE wu."role_id" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "policy_versions" WHERE change_type = 'workspace_role_backfill');

INSERT INTO "policy_versions" ("change_type", "scope_key")
SELECT 'workspace_role_backfill', 'org:1'
WHERE NOT EXISTS (SELECT 1 FROM "policy_versions" WHERE change_type = 'workspace_role_backfill');

-- T-1 migration 0002 — seed + backfill, steps 2–7 of the binding order.
-- Every step is one transaction (Prisma applies the file atomically per migration; split into
-- numbered sub-migrations at authoring time so each step commits independently — see README rollback table).
-- Idempotent: re-runnable without error. Reports print via RAISE NOTICE before writes that need them.

BEGIN;

-- ============ step 7a (pre-step-5 requirement): vocabulary + system roles ============
-- Single source of truth is seed-permissions.js; this block is generated from it at T-1 authoring
-- time (do not hand-edit the action list here — regenerate).

INSERT INTO permissions (action, description, category) VALUES
  ('document.create','Create documents','document'),
  ('document.read','Read document content/metadata','document'),
  ('document.search','Vector/text search over documents','document'),
  ('document.update','Update documents','document'),
  ('document.delete','Delete/purge documents','document'),
  ('document.share','Share documents with principals','document'),
  ('document.pin','Pin documents to context','document'),
  ('document.watch','Watch documents for re-sync','document'),
  ('document.export','Export document content','document'),
  ('workspace.read','Read workspace data','workspace'),
  ('workspace.write','Create/modify workspace data','workspace'),
  ('workspace.delete','Delete workspaces','workspace'),
  ('workspace.members.manage','Manage workspace membership/roles','workspace'),
  ('chat.read_others','Read other users'' chats','admin'),
  ('chat.send','Send chat messages','chat'),
  ('document.bulk_export','Bulk export chats/documents','admin'),
  ('access.diagnose','Use explainAccess diagnostics','admin'),
  ('role.grant','Grant roles','admin'),
  ('role.revoke','Revoke roles','admin'),
  ('sso.issue','Issue SSO temp tokens','admin'),
  ('key.manage','Manage API keys','admin'),
  ('settings.write','Write system settings','admin'),
  ('user.manage','Manage users','admin')
ON CONFLICT (action) DO NOTHING;

INSERT INTO roles (name, scope, "orgId", "isSystem") VALUES
  ('super_admin','org',1,true),
  ('setup_admin','org',1,true),
  ('content_moderator','org',1,true),
  ('member','org',1,true),
  ('owner','workspace',1,true),
  ('editor','workspace',1,true),
  ('viewer','workspace',1,true)
ON CONFLICT DO NOTHING;

-- role_permissions matrix — generated from seed-permissions.js; refined in T-2 conformance.
-- super_admin: every permission.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name = 'super_admin' AND r.scope = 'org'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.action IN
  ('settings.write','user.manage','key.manage','sso.issue','workspace.read','access.diagnose','role.grant','role.revoke')
WHERE r.name = 'setup_admin' AND r.scope = 'org'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.action IN
  ('chat.read_others','document.read','document.search','document.update','document.delete','document.bulk_export','access.diagnose')
WHERE r.name = 'content_moderator' AND r.scope = 'org'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.action IN
  ('workspace.read','workspace.write','chat.send','document.create','document.read','document.search',
   'document.update','document.pin','document.watch','document.share')
WHERE r.name = 'member' AND r.scope = 'org'
ON CONFLICT DO NOTHING;

-- workspace-scope roles
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.action IN
  ('workspace.read','workspace.write','workspace.delete','workspace.members.manage','chat.send',
   'document.create','document.read','document.search','document.update','document.delete',
   'document.share','document.pin','document.watch','document.export')
WHERE r.name = 'owner' AND r.scope = 'workspace'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.action IN
  ('workspace.read','workspace.write','chat.send','document.create','document.read','document.search',
   'document.update','document.delete','document.pin','document.watch')
WHERE r.name = 'editor' AND r.scope = 'workspace'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.action IN
  ('workspace.read','document.read','document.search','chat.send')
WHERE r.name = 'viewer' AND r.scope = 'workspace'
ON CONFLICT DO NOTHING;

-- ============ step 2: workspaces.created_by (R1) — earliest workspace_users row ============
UPDATE workspaces w
SET created_by = sub.user_id
FROM (
  SELECT workspace_id, user_id,
         ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY id) AS rn
  FROM workspace_users
) sub
WHERE w.id = sub.workspace_id AND sub.rn = 1 AND w.created_by IS NULL;

DO $$ DECLARE n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM workspaces WHERE created_by IS NULL;
  RAISE NOTICE 'T-1 report [created_by_nulls]: % workspaces without membership rows (no owner assigned)', n;
END $$;

-- ============ step 3: canonical documents — GROUP BY docpath (no checksum, architect ruling) ============
DO $$ DECLARE n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM workspace_documents WHERE docpath IS NULL OR docpath = '';
  RAISE NOTICE 'T-1 pre-check [docpath_empty]: % rows with empty docpath — each becomes its own canonical document', n;
END $$;

-- One canonical per distinct non-empty docpath; filename/metadata from lowest (workspaceId, id) member.
-- pinned/watched stay per-workspace. Empty-docpath rows: one canonical each ('orphan:<docId>' key).
-- TWO SEPARATE STATEMENTS on purpose: a data-modifying CTE is invisible to other sub-statements in
-- the same statement (same snapshot), so the UPDATE must be its own statement to see the INSERTs.
WITH firsts AS (
  SELECT DISTINCT ON (COALESCE(NULLIF(docpath, ''), 'orphan:' || "docId")) filename, metadata,
         COALESCE(NULLIF(docpath, ''), 'orphan:' || "docId") AS dedupe_key
  FROM workspace_documents
  ORDER BY COALESCE(NULLIF(docpath, ''), 'orphan:' || "docId"), "workspaceId", id
)
INSERT INTO documents ("orgId", "filename", "dedupe_key", "metadata")
SELECT 1, filename, dedupe_key, COALESCE(metadata, '{}') FROM firsts
ON CONFLICT ("dedupe_key") DO NOTHING;

UPDATE workspace_documents wd
SET "documentId" = d.id
FROM documents d
WHERE d."dedupe_key" = COALESCE(NULLIF(wd.docpath, ''), 'orphan:' || wd."docId")
  AND wd."documentId" IS NULL;

DO $$ DECLARE groups_n INTEGER; BEGIN
  SELECT count(DISTINCT COALESCE(NULLIF(docpath, ''), 'orphan:' || "docId")) INTO groups_n FROM workspace_documents;
  RAISE NOTICE 'T-1 report [dedupe_groups]: % canonical document groups', groups_n;
END $$;

-- ============ step 4: inherited_workspace ACL grants — batch inserts only ============
WITH pv AS (INSERT INTO policy_versions (change_type, scope_key) VALUES ('document_acl','org:1') RETURNING version)
INSERT INTO document_acl ("orgId", document_id, principal_type, principal_id, action, source, policy_version)
SELECT 1, wd."documentId", 'workspace', wd."workspaceId"::text, p.action, 'inherited_workspace', pv.version
FROM workspace_documents wd
CROSS JOIN (SELECT unnest(ARRAY['document.read','document.search']) AS action) p
CROSS JOIN pv
WHERE wd."documentId" IS NOT NULL
ON CONFLICT DO NOTHING;

-- ============ step 5: legacy role backfill (R4 — one-way, report BEFORE grants) ============
DO $$ DECLARE n INTEGER; BEGIN
  SELECT count(*) INTO n FROM users WHERE role = 'manager';
  RAISE NOTICE 'T-1 report [manager_downgrade]: % managers lose global read; keep owner grants on workspaces they created (see 03_reports.sql for the full list)', n;
END $$;

WITH pv AS (INSERT INTO policy_versions (change_type, scope_key) VALUES ('grant','org:1') RETURNING version)
INSERT INTO principal_role_grants ("orgId", principal_type, principal_id, role_id, workspace_id, policy_version)
SELECT 1, 'user', u.id::text, (SELECT id FROM roles WHERE name='super_admin' AND scope='org'), NULL, pv.version
FROM users u CROSS JOIN pv WHERE u.role = 'admin'
ON CONFLICT DO NOTHING;

WITH pv AS (INSERT INTO policy_versions (change_type, scope_key) VALUES ('grant','org:1') RETURNING version)
INSERT INTO principal_role_grants ("orgId", principal_type, principal_id, role_id, workspace_id, policy_version)
SELECT 1, 'user', u.id::text, (SELECT id FROM roles WHERE name='member' AND scope='org'), NULL, pv.version
FROM users u CROSS JOIN pv WHERE u.role IN ('manager','default')
ON CONFLICT DO NOTHING;

WITH pv AS (INSERT INTO policy_versions (change_type, scope_key) VALUES ('grant','org:1') RETURNING version)
INSERT INTO principal_role_grants ("orgId", principal_type, principal_id, role_id, workspace_id, policy_version)
SELECT 1, 'user', w.created_by::text, (SELECT id FROM roles WHERE name='owner' AND scope='workspace'), w.id, pv.version
FROM workspaces w CROSS JOIN pv WHERE w.created_by IS NOT NULL
ON CONFLICT DO NOTHING;

-- single-user service principal (T-2 resolver): always seeded, consumed only in single-user mode
WITH pv AS (INSERT INTO policy_versions (change_type, scope_key) VALUES ('grant','org:1') RETURNING version)
INSERT INTO principal_role_grants ("orgId", principal_type, principal_id, role_id, workspace_id, policy_version)
SELECT 1, 'service', 'single-user', (SELECT id FROM roles WHERE name='super_admin' AND scope='org'), NULL, pv.version
FROM pv
ON CONFLICT DO NOTHING;

-- ============ step 6: workspace_users.role_id (workspace-scope roles only) ============
UPDATE workspace_users wu
SET role_id = (SELECT id FROM roles WHERE name='owner' AND scope='workspace')
WHERE EXISTS (SELECT 1 FROM workspaces w WHERE w.id = wu.workspace_id AND w.created_by = wu.user_id);

-- Default members get workspace role 'editor', NOT 'viewer': legacy default users could upload,
-- update and delete documents in workspaces they belong to — editor is the closest behavioral
-- match; viewer (read+chat only) would silently revoke upload on migration day.
UPDATE workspace_users wu
SET role_id = COALESCE(wu.role_id, (SELECT id FROM roles WHERE name='editor' AND scope='workspace'));

COMMIT;

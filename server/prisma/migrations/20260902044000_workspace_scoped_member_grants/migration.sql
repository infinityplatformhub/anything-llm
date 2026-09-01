-- T-4a (#25): make workspace access come from workspace membership, not from an
-- org-wide grant.
--
-- ROOT CAUSE. Migration 20260902020000 lines 407-410 granted the org role
-- `member` (workspace_id NULL) to every legacy 'manager' and 'default' user.
-- That role carried workspace.read/workspace.write and the document actions,
-- and the engine reads a NULL-workspace grant as covering EVERY workspace while
-- never consulting workspace_users. Every ordinary user could therefore read and
-- write every workspace in the instance. It was invisible while
-- Workspace.getWithUser still filtered by membership; removing that role bypass
-- (T-4a W-2) exposed it, and P0-3's regression suite caught it.
--
-- This migration is idempotent: every statement is ON CONFLICT DO NOTHING or a
-- guarded DELETE, so re-running it changes nothing.

-- ---- step 1: workspace-scoped grants from membership ----
-- workspace_users.role_id was backfilled by 20260902020000 step 6 but nothing
-- ever read it. Turn each membership row into a real grant carrying its
-- workspace, defaulting to `editor` for rows the backfill left NULL (a member
-- with no explicit role can use the workspace, not administer it).
WITH pv AS (
  INSERT INTO "policy_versions" ("change_type", "scope_key")
  VALUES ('grant', 'org:1') RETURNING "version"
)
INSERT INTO "principal_role_grants"
  ("orgId", "principal_type", "principal_id", "role_id", "workspace_id", "policy_version")
SELECT
  1,
  'user',
  wu."user_id"::text,
  COALESCE(
    wu."role_id",
    (SELECT "id" FROM "roles" WHERE "name" = 'editor' AND "scope" = 'workspace')
  ),
  wu."workspace_id",
  pv."version"
FROM "workspace_users" wu CROSS JOIN pv
WHERE EXISTS (SELECT 1 FROM "workspaces" w WHERE w."id" = wu."workspace_id")
ON CONFLICT DO NOTHING;

-- ---- step 2: drop the over-broad org-wide member permissions ----
-- The role keeps existing and keeps its org-wide grants; only the permissions
-- that should never have been org-wide are removed from it. Deleting the GRANTS
-- instead would strip chat.send from every user.
DELETE FROM "role_permissions" rp
USING "roles" r, "permissions" p
WHERE rp."role_id" = r."id"
  AND rp."permission_id" = p."id"
  AND r."name" = 'member'
  AND r."scope" = 'org'
  AND p."action" IN (
    'workspace.read', 'workspace.write',
    'document.create', 'document.read', 'document.search',
    'document.update', 'document.pin', 'document.watch', 'document.share'
  );

-- ---- step 3: report ----
DO $$
DECLARE granted INTEGER; orphaned INTEGER;
BEGIN
  SELECT count(*) INTO granted
  FROM "principal_role_grants" WHERE "workspace_id" IS NOT NULL;
  SELECT count(*) INTO orphaned
  FROM "users" u
  WHERE NOT EXISTS (SELECT 1 FROM "workspace_users" wu WHERE wu."user_id" = u."id")
    AND NOT EXISTS (
      SELECT 1 FROM "principal_role_grants" g
      JOIN "roles" r ON r."id" = g."role_id"
      WHERE g."principal_type" = 'user' AND g."principal_id" = u."id"::text
        AND r."name" IN ('super_admin', 'setup_admin')
    );
  RAISE NOTICE 'T-4a report [workspace_grants]: % workspace-scoped grants', granted;
  RAISE NOTICE 'T-4a report [no_workspace_access]: % users now belong to no workspace and hold no admin role', orphaned;
END $$;

-- policy clock: one bump so every cached filter rebuilds.
INSERT INTO "policy_versions" ("change_type", "scope_key") VALUES ('grant', 'org:1');

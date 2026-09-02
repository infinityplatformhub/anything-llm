-- #53: the `org.member` action, and the permission-scope column that makes it safe.
--
-- One migration, because the two halves are not independent: `org.member` is only
-- safe BECAUSE the engine refuses to answer it about a workspace, and the column
-- is what the engine reads to know that. Splitting them would land an action that
-- is briefly the migration-044000 vulnerability again.
--
-- The problem: seven routes gate on `chat.send` while asking "is the caller a
-- principal of this org" — the handler then filters by membership. `chat.send`
-- became the proxy in T-4a only because it was the sole permission the org
-- `member` role still held. Since T-7's R5 blanket deny it is also a live bug:
-- `chat.send` is not a read, so a view-as-user session cannot list workspaces.
--
-- Why NOT the obvious fix (seeding `workspace.read` onto org `member`), measured
-- on a fresh database during #52:
--
--   workspace.read on a workspace they belong to:      allowed=true
--   workspace.read on a workspace they do NOT:         allowed=true
--   workspace_users rows for that user:                0
--
-- Every user holds an org-wide (`workspace_id NULL`) `member` grant, and
-- evaluate() reads a NULL-workspace grant as matching EVERY resource workspace
-- without ever consulting workspace_users. Any permission on that role is a
-- permission on every workspace. That is verbatim what migration 044000 closed.

-- 1. The scope column. DEFAULT 'any' is the existing behaviour, so every action
--    already seeded keeps answering exactly as it does today; only rows named
--    below opt into a restriction.
ALTER TABLE "permissions"
  ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'any';

-- A CHECK rather than an enum: three fixed values, and a typo in a later seed
-- should fail at write time instead of silently becoming a scope the engine
-- does not recognise and therefore does not enforce.
ALTER TABLE "permissions"
  ADD CONSTRAINT "permissions_scope_check"
  CHECK ("scope" IN ('org', 'workspace', 'any'));

-- 2. The action itself. Idempotent: a fresh database gets it from the seed file
--    (prisma/seeds/permissions.js) and this statement is then a no-op.
INSERT INTO "permissions" ("action", "description", "category", "scope")
VALUES (
  'org.member',
  'Is a principal of this organization. Carries no authority; handlers still filter by membership.',
  'org',
  'org'
)
ON CONFLICT ("action") DO UPDATE SET "scope" = 'org';

-- 3. Grant it to every ORG-scoped role. Everyone holds it, which is the point:
--    a permission everyone has confers nothing, which is why it is also
--    authority-free and belongs in BASELINE_GRANTABLE.
--
--    Workspace-scoped roles (owner/editor/viewer) deliberately do NOT get it:
--    they are granted per workspace, and an action that may only be asked at org
--    scope would be unreachable through them.
INSERT INTO "role_permissions" ("role_id", "permission_id", "effect")
SELECT r."id", p."id", 'allow'
  FROM "roles" r
 CROSS JOIN "permissions" p
 WHERE p."action" = 'org.member'
   AND r."scope" = 'org'
   AND r."name" IN ('super_admin', 'setup_admin', 'content_moderator', 'member')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- 4. Assert the org `member` role did not pick up authority along the way.
--    §3 of the recon: this migration must not merely AVOID seeding workspace
--    actions onto the org-wide role, it must prove it did not — the failure it
--    guards against is silent and reintroduces 044000.
DO $$
DECLARE
  extra TEXT;
BEGIN
  SELECT STRING_AGG(p."action", ', ' ORDER BY p."action")
    INTO extra
    FROM "role_permissions" rp
    JOIN "roles" r ON r."id" = rp."role_id"
    JOIN "permissions" p ON p."id" = rp."permission_id"
   WHERE r."name" = 'member'
     AND r."scope" = 'org'
     AND p."action" NOT IN ('chat.send', 'org.member');

  IF extra IS NOT NULL THEN
    RAISE EXCEPTION
      'org member role carries unexpected permissions: %. An org-wide grant matches EVERY workspace (see migration 044000) — this migration refuses to leave that state.',
      extra;
  END IF;
END $$;

-- 5. Say what happened. The scope column changes how the engine answers, and an
--    operator reading migration output should see that without diffing a table.
DO $$
DECLARE
  scoped_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO scoped_count FROM "permissions" WHERE "scope" <> 'any';
  RAISE NOTICE '[#53] org.member seeded; % permission(s) now carry a scope restriction. The engine refuses an org-scoped action asked about a workspace resource.', scoped_count;
END $$;

-- 6. The vocabulary changed, so the policy clock moves: a decision cached under
--    the old vocabulary must not be trusted after it.
INSERT INTO "policy_versions" ("change_type", "scope_key") VALUES ('grant', 'org:1');

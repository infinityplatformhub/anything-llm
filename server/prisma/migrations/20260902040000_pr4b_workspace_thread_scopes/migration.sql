-- PR-4b(1): five new API scope actions for the workspace and thread routes.
--
-- Generated from server/prisma/seeds/permissions.js — do not hand-edit; regenerate
-- from the seed file (same rule as the step-7a block in 20260902020000).
--
-- The step-7a CROSS JOIN granted super_admin every permission that existed *then*.
-- Rows added later are not covered by it, so the grant is repeated here for the new
-- actions only. Without this, super_admin silently lacks them.

INSERT INTO "permissions" ("action", "description", "category") VALUES
  ('thread.create', 'Thread.create', 'thread'),
  ('thread.delete', 'Thread.delete', 'thread'),
  ('thread.write', 'Thread.write', 'thread'),
  ('workspace.create', 'Workspace.create', 'workspace'),
  ('workspace.embeddings.manage', 'Workspace.embeddings.manage', 'workspace')
ON CONFLICT ("action") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r JOIN "permissions" p ON p."action" IN
  ('thread.create','thread.delete','thread.write','workspace.create','workspace.embeddings.manage')
WHERE r."name" = 'super_admin' AND r."scope" = 'org'
ON CONFLICT DO NOTHING;

-- owner/editor already manage their workspace's content; threads and embeddings are
-- part of that. workspace.create stays org-level (super_admin only) — a workspace role
-- cannot mint new workspaces.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r JOIN "permissions" p ON p."action" IN
  ('thread.create','thread.delete','thread.write','workspace.embeddings.manage')
WHERE r."name" IN ('owner','editor') AND r."scope" = 'workspace'
ON CONFLICT DO NOTHING;

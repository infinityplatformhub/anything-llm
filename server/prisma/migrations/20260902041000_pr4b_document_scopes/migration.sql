-- PR-4b(2): one new API scope action for the document folder routes.
--
-- Generated from server/prisma/seeds/permissions.js — do not hand-edit; regenerate
-- from the seed file (same rule as the step-7a block in 20260902020000).
--
-- The step-7a CROSS JOIN granted super_admin every permission that existed *then*,
-- so a row added later needs its own grant. Same reason as 20260902040000.

INSERT INTO "permissions" ("action", "description", "category") VALUES
  ('document.folder.manage', 'Document.folder.manage', 'document')
ON CONFLICT ("action") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "permissions" p JOIN "roles" r ON TRUE
WHERE p."action" = 'document.folder.manage'
  AND r."scope" = 'org' AND r."name" = 'super_admin'
ON CONFLICT DO NOTHING;

-- owner and editor already create and delete documents in their workspace; the
-- folders those documents sit in are part of that. viewer stays read-only.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "permissions" p JOIN "roles" r ON TRUE
WHERE p."action" = 'document.folder.manage'
  AND r."scope" = 'workspace' AND r."name" IN ('owner','editor')
ON CONFLICT DO NOTHING;

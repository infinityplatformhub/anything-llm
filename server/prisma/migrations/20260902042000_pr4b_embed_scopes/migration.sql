-- PR-4b(3): two new API scope actions for the embed routes.
--
-- Generated from server/prisma/seeds/permissions.js — do not hand-edit; regenerate
-- from the seed file (same rule as the step-7a block in 20260902020000).
--
-- The step-7a CROSS JOIN granted super_admin every permission that existed *then*,
-- so rows added later need their own grant. Same reason as 20260902040000/041000.
--
-- No browser-extension actions are added here: the extension's fixed grant reuses
-- browser-extension.read / .write, which step-7a already seeded.

INSERT INTO "permissions" ("action", "description", "category") VALUES
  ('embed.chat.read', 'Embed.chat.read', 'embed'),
  ('embed.create', 'Embed.create', 'embed')
ON CONFLICT ("action") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "permissions" p JOIN "roles" r ON TRUE
WHERE p."action" IN ('embed.chat.read','embed.create')
  AND r."scope" = 'org' AND r."name" = 'super_admin'
ON CONFLICT DO NOTHING;

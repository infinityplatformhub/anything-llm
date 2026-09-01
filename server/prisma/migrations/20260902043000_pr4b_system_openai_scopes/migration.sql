-- PR-4b(4): three new API scope actions for the system and openai-compatibility routes.
--
-- Generated from server/prisma/seeds/permissions.js — do not hand-edit; regenerate
-- from the seed file (same rule as the step-7a block in 20260902020000).
--
-- The step-7a CROSS JOIN granted super_admin every permission that existed *then*,
-- so rows added later need their own grant. Same reason as 20260902040000/041000/042000.
--
-- export-chats reuses document.bulk_export and remove-documents reuses document.delete;
-- both were seeded by step-7a and are not re-inserted here.

INSERT INTO "permissions" ("action", "description", "category") VALUES
  ('embedding.compute', 'Embedding.compute', 'embedding'),
  ('image.generate', 'Image.generate', 'image'),
  ('system.env.read', 'System.env.read', 'system')
ON CONFLICT ("action") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "permissions" p JOIN "roles" r ON TRUE
WHERE p."action" IN ('embedding.compute','image.generate','system.env.read')
  AND r."scope" = 'org' AND r."name" = 'super_admin'
ON CONFLICT DO NOTHING;

-- system.env.read stays super_admin only: it reads the provider credentials, which no
-- other system role has a reason to see. image.generate and embedding.compute are
-- likewise not granted to workspace roles here — they spend money per call and should
-- be granted deliberately rather than inherited by every editor.

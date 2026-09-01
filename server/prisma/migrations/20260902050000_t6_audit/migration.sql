-- T-6 Phase A (#28): the `audit.read` action for the audit export endpoint.
--
-- Generated from server/prisma/seeds/permissions.js — do not hand-edit; regenerate
-- from the seed file (same rule as the step-7a block in 20260902020000).
--
-- The step-7a CROSS JOIN granted super_admin every permission that existed *then*,
-- so a row added later needs its own grant. Same reason as 20260902040000..043000.
--
-- super_admin ONLY, deliberately. The audit log is the record of what everyone did,
-- including the people who administer the system; an export of it is bulk egress of
-- exactly the data most worth stealing. content_moderator reads chats and
-- setup_admin manages access, and neither needs the trail of the other.

INSERT INTO "permissions" ("action", "description", "category") VALUES
  ('audit.read', 'Audit.read', 'audit')
ON CONFLICT ("action") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "permissions" p JOIN "roles" r ON TRUE
WHERE p."action" = 'audit.read'
  AND r."scope" = 'org' AND r."name" = 'super_admin'
ON CONFLICT DO NOTHING;

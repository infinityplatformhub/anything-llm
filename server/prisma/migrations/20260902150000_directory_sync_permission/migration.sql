-- #138 (S4b slice 3): `directory.sync` — the action that fires a directory run.
--
-- The route that triggers a sync calls `applyDirectoryPlan`, which creates users
-- and groups, rewrites membership, and DEACTIVATES every user absent from the
-- provider snapshot. Lark has no delta API, so absence is the only departure
-- signal (utils/identity/applyDirectoryPlan.js:8-12): a misconfigured directory
-- app yields a snapshot that is confidently wrong about the whole organisation,
-- and applying it suspends everyone. That is why this is its own action rather
-- than a use of `user.manage`.
--
-- Granted to super_admin ONLY. Deliberately not setup_admin: #137
-- (20260902140000) widened that role into system.write/system.read/user.read so
-- it can finish an installation, which includes configuring the directory
-- provider. Giving it directory.sync as well would let the role that configures
-- the provider also fire the run that deactivates the organisation — the duty
-- split TL-1 ruled on (38287c1cf).
--
-- The super_admin grant needs its own INSERT below. The CROSS JOIN in
-- 20260902020000:295 hands super_admin every permission that existed WHEN IT
-- RAN; a permission created by a later migration is not covered by it. Omitting
-- this is bug #63's exact shape: `chat.read` was seeded as a permission, granted
-- to nobody, and four routes answered 404 to every user asking for their own
-- chat history.

INSERT INTO "permissions" ("action", "description")
VALUES (
  'directory.sync',
  'Trigger a directory synchronisation run (creates, updates and deactivates users in bulk)'
)
ON CONFLICT ("action") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."action" = 'directory.sync'
WHERE r."name" = 'super_admin'
  AND r."scope" = 'org'
ON CONFLICT DO NOTHING;

-- Bump the policy version so a RUNNING process rebuilds its filter rather than
-- serving a pre-grant decision until its TTL expires. FilterCache.get reads
-- currentPolicyVersion on every call (utils/authorization/cache.js), so without
-- this row the grant works on a fresh boot and not on a live instance.
INSERT INTO "policy_versions" ("change_type", "scope_key")
VALUES ('grant', 'org:1');

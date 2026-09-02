-- #63 hotfix: `chat.read` was seeded as a permission and granted to nobody.
--
-- 20260902020000:238 inserts the permission row. The role_permissions inserts
-- that follow (:300-338) hand out `chat.send` to the workspace roles and to org
-- `member`, and never mention `chat.read`. The only principal holding it is
-- `super_admin`, which gets every permission through the CROSS JOIN at :295.
--
-- Four routes gate on it — GET /workspace/:slug/chats,
-- GET /workspace/:slug/thread/:threadSlug/chats, and their two /v1 twins
-- (utils/apiKeySecurity/scopes.js:29,40). `no_permission_in_roles` is in
-- NON_DISCLOSING, so the denial conceals as 404: an ordinary user asking for
-- their OWN chat history is told it does not exist.
--
-- The shape of the bug is why nothing caught it. routeWiring.test.js exercises
-- these routes with a `manager` fixture, and managers carry an org grant, so the
-- gate passed there for a reason that does not generalise to the users who
-- actually use the product.
--
-- PMO ruling (option กâ²): the three WORKSPACE roles — owner, editor, viewer —
-- and deliberately NOT the org `member` role.
--
-- The first cut of this migration did include org `member`, and the regression
-- suite caught it: an org-scope grant carries workspace_id NULL, the engine
-- reads a NULL-workspace grant as EVERY workspace, and a user who had joined no
-- workspace at all got 200 with someone else's chat history. That is the same
-- shape T-4a already removed from this role for workspace.read/write (see the
-- comment on `member` in prisma/seeds/permissions.js) — being a member of the
-- org is not being a member of a workspace. Every real user reaches chat.read
-- through their workspace membership grant instead, which is what makes
-- dropping the org half cost nothing.
--
-- Viewer is included deliberately: a viewer already holds `chat.send`, so
-- excluding it would leave a role that can write a chat and not read the one it
-- just wrote.
--
-- `chat.read` is the caller's OWN history. Reading other users' chats is
-- `chat.read_others`, which stays where it is (super_admin, content_moderator)
-- and is untouched here. There is no implication between them in the engine, so
-- content_moderator reaches its own history the same way everyone else does —
-- through workspace membership, not through its org role.

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."action" = 'chat.read'
WHERE r."name" IN ('owner', 'editor', 'viewer')
   AND r."scope" = 'workspace'
ON CONFLICT DO NOTHING;

-- Bump the policy version so any process holding a built filter rebuilds rather
-- than serving a pre-grant decision until its TTL expires. FilterCache.get reads
-- currentPolicyVersion on every call (utils/authorization/cache.js), so this row
-- is what makes the new grant take effect without a restart.
INSERT INTO "policy_versions" ("change_type", "scope_key")
VALUES ('grant', 'org:1');

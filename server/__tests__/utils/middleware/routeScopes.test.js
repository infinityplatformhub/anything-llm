const { ALL_ACTIONS } = require("../../../prisma/seeds/permissions");
const { ROUTE_SCOPES } = require("../../../utils/apiKeySecurity/scopes");
const { workspaceBindingMatches } = require("../../../utils/middleware/validApiKey");

const EXPECTED = {
  "GET /v1/admin/is-multi-user-mode": "system.read",
  "GET /v1/admin/users": "user.read",
  "POST /v1/admin/users/new": "user.write",
  "POST /v1/admin/users/:id": "user.write",
  "DELETE /v1/admin/users/:id": "user.write",
  "GET /v1/admin/invites": "invite.read",
  "POST /v1/admin/invite/new": "invite.create",
  "DELETE /v1/admin/invite/:id": "invite.delete",
  "GET /v1/admin/workspaces/:workspaceId/users": "workspace.read",
  "POST /v1/admin/workspaces/:workspaceId/update-users": "workspace.members.manage",
  "POST /v1/admin/workspaces/:workspaceSlug/manage-users": "workspace.members.manage",
  "POST /v1/admin/workspace-chats": "chat.read",
  "POST /v1/admin/preferences": "system.write",
  "GET /v1/users": "user.read",
  "GET /v1/users/:id/issue-auth-token": "sso.issue",
  "GET /v1/auth": "system.read",

  // PR-4b(1) workspace
  "POST /v1/workspace/new": "workspace.create",
  "GET /v1/workspaces": "workspace.read",
  "GET /v1/workspace/:slug": "workspace.read",
  "DELETE /v1/workspace/:slug": "workspace.delete",
  "POST /v1/workspace/:slug/update": "workspace.write",
  "GET /v1/workspace/:slug/chats": "chat.read",
  "POST /v1/workspace/:slug/update-embeddings": "workspace.embeddings.manage",
  "POST /v1/workspace/:slug/update-pin": "document.pin",
  "POST /v1/workspace/:slug/chat": "chat.write",
  "POST /v1/workspace/:slug/stream-chat": "chat.write",
  "POST /v1/workspace/:slug/vector-search": "document.search",

  // PR-4b(1) threads
  "POST /v1/workspace/:slug/thread/new": "thread.create",
  "POST /v1/workspace/:slug/thread/:threadSlug/update": "thread.write",
  "DELETE /v1/workspace/:slug/thread/:threadSlug": "thread.delete",
  "GET /v1/workspace/:slug/thread/:threadSlug/chats": "chat.read",
  "POST /v1/workspace/:slug/thread/:threadSlug/chat": "chat.write",
  "POST /v1/workspace/:slug/thread/:threadSlug/stream-chat": "chat.write",
};

test("route scope table is complete and verbatim vocabulary", () => {
  expect(ROUTE_SCOPES).toEqual(EXPECTED);
  expect(Object.values(ROUTE_SCOPES).every((action) => ALL_ACTIONS.includes(action))).toBe(true);
});

test("workspace binding denies mismatched direct workspace id", async () => {
  await expect(workspaceBindingMatches({ workspaceId: "7" }, { params: { workspaceId: "8" } }, { workspaceParam: "workspaceId" }, {})).resolves.toBe(false);
});

test("workspace binding resolves slug before comparing", async () => {
  const db = { workspaces: { findUnique: jest.fn().mockResolvedValue({ id: 7 }) } };
  await expect(workspaceBindingMatches({ workspaceId: "7" }, { params: { workspaceSlug: "alpha" } }, { workspaceSlugParam: "workspaceSlug" }, db)).resolves.toBe(true);
  expect(db.workspaces.findUnique).toHaveBeenCalledWith({ where: { slug: "alpha" }, select: { id: true } });
});

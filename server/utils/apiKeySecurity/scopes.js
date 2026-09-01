const API_KEY_SCOPES = Object.freeze({
  TEMPORARY_ALL: "*",
});

const ROUTE_SCOPES = Object.freeze({
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
});

const scopeFor = (method, path) => ROUTE_SCOPES[`${method} ${path}`];

module.exports = { API_KEY_SCOPES, ROUTE_SCOPES, scopeFor };

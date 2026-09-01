const { ALL_ACTIONS } = require("../../../prisma/seeds/permissions");
const {
  ROUTE_SCOPES,
  EXTENSION_SCOPES,
  EXTENSION_ROUTE_SCOPES,
} = require("../../../utils/apiKeySecurity/scopes");
const {
  workspaceBindingMatches,
  addressedWorkspaceId,
} = require("../../../utils/middleware/validApiKey");

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

  // PR-4b(2) document — no workspace binding: documents live in a global store and
  // workspace attachment happens later, so there is no workspace in the path to bind
  // against. Per-actor document scoping is T-3's documentFilter, not this middleware.
  "POST /v1/document/upload": "document.write",
  "POST /v1/document/upload/:folderName": "document.write",
  "POST /v1/document/upload-link": "document.write",
  "POST /v1/document/raw-text": "document.write",
  "GET /v1/documents": "document.read",
  "GET /v1/documents/folder/:folderName": "document.read",
  "GET /v1/document/accepted-file-types": "system.read",
  "GET /v1/document/metadata-schema": "system.read",
  "GET /v1/document/:docName": "document.read",
  "POST /v1/document/create-folder": "document.folder.manage",
  "DELETE /v1/document/remove-folder": "document.folder.manage",
  "POST /v1/document/move-files": "document.folder.manage",
  "GET /v1/document/generated-files/:filename": "document.read",

  // PR-4b(3) embed
  "GET /v1/embed": "embed.read",
  "GET /v1/embed/:embedUuid/chats": "embed.chat.read",
  "GET /v1/embed/:embedUuid/chats/:sessionUuid": "embed.chat.read",
  "POST /v1/embed/new": "embed.create",
  "POST /v1/embed/:embedUuid": "embed.write",
  "DELETE /v1/embed/:embedUuid": "embed.delete",

  // PR-4b(4) system
  "GET /v1/system/env-dump": "system.env.read",
  "GET /v1/system": "system.read",
  "GET /v1/system/vector-count": "system.read",
  "POST /v1/system/update-env": "system.write",
  "GET /v1/system/export-chats": "document.bulk_export",
  "DELETE /v1/system/remove-documents": "document.delete",

  // PR-4b(4) openai compatibility
  "GET /v1/openai/models": "system.read",
  "POST /v1/openai/chat/completions": "chat.write",
  "POST /v1/openai/images/generations": "image.generate",
  "POST /v1/openai/embeddings": "embedding.compute",
  "GET /v1/openai/vector_stores": "workspace.read",
};

test("route scope table is complete and verbatim vocabulary", () => {
  expect(ROUTE_SCOPES).toEqual(EXPECTED);
  expect(Object.values(ROUTE_SCOPES).every((action) => ALL_ACTIONS.includes(action))).toBe(true);
});

// T-4b W-9: resolving the addressed workspace and comparing it to the key's binding are
// now two steps — the grant check authorizes against the same resolved id, and resolving
// twice would be two chances for the halves to disagree.
test("workspace binding denies mismatched direct workspace id", async () => {
  const addressed = await addressedWorkspaceId({ params: { workspaceId: "8" } }, { workspaceParam: "workspaceId" }, {});
  expect(addressed).toBe(8);
  expect(workspaceBindingMatches({ workspaceId: "7" }, { workspaceParam: "workspaceId" }, addressed)).toBe(false);
});

test("workspace binding resolves slug before comparing", async () => {
  const db = { workspaces: { findUnique: jest.fn().mockResolvedValue({ id: 7 }) } };
  const addressed = await addressedWorkspaceId({ params: { workspaceSlug: "alpha" } }, { workspaceSlugParam: "workspaceSlug" }, db);
  expect(workspaceBindingMatches({ workspaceId: "7" }, { workspaceSlugParam: "workspaceSlug" }, addressed)).toBe(true);
  expect(db.workspaces.findUnique).toHaveBeenCalledWith({ where: { slug: "alpha" }, select: { id: true } });
});

test("a bound key is denied when the addressed workspace does not resolve", async () => {
  const db = { workspaces: { findUnique: jest.fn().mockResolvedValue(null) } };
  const addressed = await addressedWorkspaceId({ params: { workspaceSlug: "ghost" } }, { workspaceSlugParam: "workspaceSlug" }, db);
  expect(addressed).toBeNull();
  expect(workspaceBindingMatches({ workspaceId: "7" }, { workspaceSlugParam: "workspaceSlug" }, addressed)).toBe(false);
});

test("a route with no binding addresses no workspace, and an unbound key is unaffected", async () => {
  expect(await addressedWorkspaceId({ params: { slug: "x" } }, null, {})).toBeUndefined();
  expect(workspaceBindingMatches({ workspaceId: null }, null, undefined)).toBe(true);
});

test("the browser extension holds a fixed grant, not a wildcard, and only what its routes need", () => {
  expect(EXTENSION_SCOPES).not.toContain("*");
  expect(EXTENSION_SCOPES.every((action) => ALL_ACTIONS.includes(action))).toBe(true);
  // No route may need a scope the extension does not hold, and the extension may not
  // hold a scope no route needs -- either way the grant stops describing the client.
  expect([...new Set(Object.values(EXTENSION_ROUTE_SCOPES))].sort()).toEqual(
    [...EXTENSION_SCOPES].sort()
  );
});

test("extension routes stay out of the API key table so one table means one credential type", () => {
  const extensionRoutes = Object.keys(ROUTE_SCOPES).filter((entry) =>
    entry.includes("/browser-extension")
  );
  expect(extensionRoutes).toEqual([]);
});

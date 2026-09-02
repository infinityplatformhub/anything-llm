// PR-4c: API_KEY_SCOPES.TEMPORARY_ALL ("*") is gone. Every route names its scope and
// every key is minted with an explicit list, so nothing has a wildcard left to match.

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
  // #64: reading EVERY user's chats is `chat.read_others` by definition, not `chat.read`.
  // These three routes have no per-user filter — the session routes narrow to the caller
  // via `forWorkspaceByUser`, and there is no equivalent "self" for an API key, which is
  // a bearer credential for its creator rather than an identity. Naming the wider action
  // is what makes the ingress check refuse a key whose creator holds only `chat.read`.
  "POST /v1/admin/workspace-chats": "chat.read_others",
  "POST /v1/admin/preferences": "system.write",
  "GET /v1/users": "user.read",
  "GET /v1/auth": "system.read",

  // PR-4b(1) workspace — every route below is slug-bound, so a workspace-scoped
  // key reaches only the workspace it was issued for.
  "POST /v1/workspace/new": "workspace.create",
  "GET /v1/workspaces": "workspace.read",
  "GET /v1/workspace/:slug": "workspace.read",
  "DELETE /v1/workspace/:slug": "workspace.delete",
  "POST /v1/workspace/:slug/update": "workspace.write",
  "GET /v1/workspace/:slug/chats": "chat.read_others",
  "POST /v1/workspace/:slug/update-embeddings": "workspace.embeddings.manage",
  "POST /v1/workspace/:slug/update-pin": "document.pin",
  "POST /v1/workspace/:slug/chat": "chat.write",
  "POST /v1/workspace/:slug/stream-chat": "chat.write",
  "POST /v1/workspace/:slug/vector-search": "document.search",

  // PR-4b(1) threads
  "POST /v1/workspace/:slug/thread/new": "thread.create",
  "POST /v1/workspace/:slug/thread/:threadSlug/update": "thread.write",
  "DELETE /v1/workspace/:slug/thread/:threadSlug": "thread.delete",
  "GET /v1/workspace/:slug/thread/:threadSlug/chats": "chat.read_others",
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
});

const scopeFor = (method, path) => ROUTE_SCOPES[`${method} ${path}`];

// PR-4b(3) ruling (a): the browser extension is a single-purpose client authenticated
// by a different credential type (apw-brx-, browser_extension_api_keys) than the API
// keys ROUTE_SCOPES describes. Its grant is fixed in code rather than issued per key,
// so its routes are deliberately NOT in ROUTE_SCOPES: one table holding scopes for two
// credential types cannot answer "which scope applies to which kind of key" during an
// audit. The extension holds exactly what its five routes need and nothing else --
// notably not the wildcard it carried before.
const EXTENSION_SCOPES = Object.freeze([
  "browser-extension.read",
  "browser-extension.write",
  "workspace.read",
  "document.write",
]);

const EXTENSION_ROUTE_SCOPES = Object.freeze({
  "GET /browser-extension/check": "browser-extension.read",
  "DELETE /browser-extension/disconnect": "browser-extension.write",
  "GET /browser-extension/workspaces": "workspace.read",
  "POST /browser-extension/embed-content": "document.write",
  "POST /browser-extension/upload-content": "document.write",
});

const extensionScopeFor = (method, path) => EXTENSION_ROUTE_SCOPES[`${method} ${path}`];

// PR-4c: what an admin-minted key gets when the caller names no scopes. Every scope any
// route asks for, minus system.env.read -- reading the provider credentials is not part
// of "an admin key", and a deployment that wants it must say so.
//
// PR-4d (#35): this is a DEFAULT, not a ceiling. What a key may actually hold is bounded
// by the creator's own grants, read through the engine in scopeCeiling.js — a caller who
// names no scopes gets this list narrowed to what they hold.
const ADMIN_DEFAULT_SCOPES = Object.freeze(
  [...new Set(Object.values(ROUTE_SCOPES))]
    .filter((action) => action !== "system.env.read")
    .sort()
);

// A single-user deployment has one operator who is already the administrator; the key
// they mint for themselves is the same grant, including env access.
const SINGLE_USER_KEY_SCOPES = Object.freeze(
  [...new Set(Object.values(ROUTE_SCOPES))].sort()
);

const KNOWN_SCOPES = Object.freeze(
  [...new Set([...Object.values(ROUTE_SCOPES), ...Object.values(EXTENSION_ROUTE_SCOPES)])].sort()
);

module.exports = {
  ROUTE_SCOPES,
  scopeFor,
  EXTENSION_SCOPES,
  EXTENSION_ROUTE_SCOPES,
  extensionScopeFor,
  ADMIN_DEFAULT_SCOPES,
  SINGLE_USER_KEY_SCOPES,
  KNOWN_SCOPES,
};

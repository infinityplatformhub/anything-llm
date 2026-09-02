// T-1 seed — vocabulary + system roles + matrix. SINGLE SOURCE for the vocabulary:
// the migration's step-7a INSERT block is generated from this file (regenerate, don't hand-edit).
// Also consumed by __tests__/security/authorization/vocabulary-diff.test.js to diff against
// live requireScope() call sites (P0-4 R3: one namespace, no translation layer).

const DOCUMENT_ACTIONS = [
  "document.create",
  "document.read",
  "document.search",
  "document.update",
  "document.delete",
  "document.share",
  "document.pin",
  "document.watch",
  "document.export",
];

// Engine actions (authorization engine vocabulary) + API scope strings (P0-4 PR-3/PR-4,
// PMO-approved list 2026-09-02). One namespace per R3 — no translation layer.
const ENGINE_ACTIONS = [
  ...DOCUMENT_ACTIONS,
  "workspace.members.manage",
  "chat.read_others",
  "chat.send",
  "document.bulk_export",
  "access.diagnose",
  "role.grant",
  "role.revoke",
  "key.manage",
  "settings.write",
  "user.manage",
];

const API_ACTIONS = [
  "workspace.read",
  "workspace.write",
  "workspace.delete",
  // PR-4b(1): creating a workspace is not writing to one — a key scoped to edit
  // the workspaces it was given must not be able to mint new ones.
  "workspace.create",
  // Attaching and detaching documents rewrites what the workspace retrieves from.
  // It is neither document.write (the document is unchanged) nor workspace.write
  // (settings are unchanged), so it is grantable on its own.
  "workspace.embeddings.manage",
  "thread.create",
  "thread.write",
  "thread.delete",
  // PR-4b(2): folders are the document store's containers. Creating, removing and
  // moving between them rearranges what other keys can reach by path, which neither
  // document.write (contents) nor document.delete (one document) covers.
  "document.folder.manage",
  // PR-4b(3): embed chat transcripts are visitor conversations, not the operator's
  // own chats -- a key that may read embed configs must not thereby read what the
  // public typed into them.
  "embed.chat.read",
  "embed.create",
  // PR-4b(4): env-dump is the highest-value target on the API surface. A key that may
  // read system status must not thereby read the provider credentials in the env file.
  "system.env.read",
  // Image generation and embedding computation spend money per call; they are
  // grantable apart from chat so a key can be given one without the others.
  "image.generate",
  "embedding.compute",
  "document.read",
  "document.write",
  "document.delete",
  "chat.read",
  "chat.write",
  "user.read",
  "user.write",
  "system.read",
  "system.write",
  "invite.read",
  "invite.create",
  "invite.delete",
  "embed.read",
  "embed.write",
  "embed.delete",
  "agent-flow.read",
  "agent-flow.write",
  "mcp-server.read",
  "mcp-server.write",
  "memory.read",
  "memory.write",
  "telegram.read",
  "telegram.write",
  "scheduled-job.read",
  "scheduled-job.write",
  "browser-extension.read",
  "browser-extension.write",
  "model-router.read",
  "model-router.write",
];

// T-6 (#28). Reading the audit log is not a system read: `system.read` is held by
// keys that report status, and the audit trail is the record of what every actor
// did, including the administrators. It is granted to super_admin alone
// (migration 20260902050000) — export is bulk egress of the highest-value data on
// the instance, which is the same reason T-2 flagged chat export.
const AUDIT_ACTIONS = ["audit.read"];

// #138 (S4b slice 3). Triggering a directory sync is not a user-management action
// and deliberately does not live in ENGINE_ACTIONS beside `user.manage`.
//
// The reason is what the sync DOES rather than what it is called: a run invokes
// `applyDirectoryPlan`, which creates users, creates groups, rewrites group
// membership and DEACTIVATES every user absent from the snapshot. Lark has no
// delta API, so absence from a snapshot is the only departure signal
// (applyDirectoryPlan.js:8-12) — a misconfigured directory app produces a
// snapshot that is confidently wrong about the whole organisation, and applying
// it is a bulk suspend of everyone.
//
// So it is its own action, held by super_admin alone. In particular NOT
// setup_admin: that role exists to finish an installation, and #137 widened it
// into system.write/system.read/user.read for exactly that. Handing it
// directory.sync would let the role that configures the provider also fire the
// run that suspends the organisation — the two duties this split exists to keep
// apart (TL-1 38287c1cf).
const DIRECTORY_ACTIONS = ["directory.sync"];

// #53: "is the caller a real, unsuspended principal of this org" — and nothing
// more. It carries NO authority: every route that asks it still filters by
// membership in the handler. It exists because seven routes were asking
// `chat.send` to mean this, which is both the wrong word and (since T-7's R5
// blanket deny) a live bug: `chat.send` is not a read, so a view-as-user session
// could not list its own workspaces.
//
// It is scoped 'org' in the permissions table, and the engine refuses to answer
// it against a resource that names a workspace. That is not decoration: every
// user holds an org-wide `member` grant, and the engine reads a NULL-workspace
// grant as matching EVERY workspace, so a workspace-scoped question answered by
// this action would be the migration-044000 vulnerability again.
const ORG_MEMBERSHIP_ACTIONS = ["org.member"];

const ALL_ACTIONS = [
  ...new Set([
    ...ENGINE_ACTIONS,
    ...API_ACTIONS,
    ...AUDIT_ACTIONS,
    ...DIRECTORY_ACTIONS,
    ...ORG_MEMBERSHIP_ACTIONS,
    "workspace.read",
    "workspace.write",
    "workspace.delete",
  ]),
].sort();

const SYSTEM_ROLES = [
  { name: "super_admin", scope: "org", permissions: ALL_ACTIONS },
  {
    name: "setup_admin",
    scope: "org",
    permissions: [
      "settings.write", "user.manage", "key.manage",
      "workspace.read", "access.diagnose", "role.grant", "role.revoke",
      "org.member",
    ],
  },
  {
    name: "content_moderator",
    scope: "org",
    permissions: [
      "chat.read_others", "document.read", "document.search",
      "document.update", "document.delete", "document.bulk_export", "access.diagnose",
      "org.member",
    ],
  },
  {
    name: "member",
    scope: "org",
    // T-4a (#25): workspace and document actions REMOVED from the org-wide role.
    //
    // The T-1 backfill granted this role org-wide (workspace_id NULL) to every
    // legacy `manager` and `default` user (migration 20260902020000, lines
    // 407-410). The engine reads a NULL-workspace grant as "every workspace" and
    // never consults workspace_users, so while this role carried workspace.read
    // and workspace.write, every ordinary user could read and write EVERY
    // workspace. That was masked by Workspace.getWithUser's membership filter
    // until T-4a removed the role bypass living beside it.
    //
    // Being a member of the org is not being a member of a workspace. What is
    // left here is what a person may do as themselves, anywhere; access to a
    // particular workspace now comes from a workspace-scoped grant derived from
    // workspace_users.role_id.
    //
    // #63 adds chat.read to the three WORKSPACE roles and deliberately not
    // here, for exactly the reason above: an org-wide chat.read would let a
    // user read the chat history of every workspace, including ones they have
    // never joined. Proven, not assumed — the first cut of that migration did
    // grant it here, and chatReadGrant.test.js caught an outsider reading a
    // workspace's history with a 200.
    //
    // #53 adds `org.member` here, and it is the exception that shows the rule:
    // it is safe on this org-wide role for the one reason chat.read and the
    // workspace actions are not — it is never asked ABOUT a workspace. The
    // permissions table scopes it 'org' and the engine throws rather than
    // answering it against a workspace resource, so the org-wide grant every
    // user holds cannot reach a workspace through it.
    permissions: ["chat.send", "org.member"],
  },
  {
    name: "owner",
    scope: "workspace",
    permissions: [
      "workspace.read", "workspace.write", "workspace.delete", "workspace.members.manage",
      "chat.send", "chat.read", ...DOCUMENT_ACTIONS,
    ],
  },
  {
    name: "editor",
    scope: "workspace",
    permissions: [
      "workspace.read", "workspace.write", "chat.send", "chat.read",
      "document.create", "document.read", "document.search",
      "document.update", "document.delete", "document.pin", "document.watch",
    ],
  },
  {
    name: "viewer",
    scope: "workspace",
    permissions: [
      "workspace.read", "document.read", "document.search", "chat.send",
      // #63: a viewer that can send a chat and not read the one it just sent is
      // not a coherent role. chat.read is the caller's OWN history; reading
      // other people's is chat.read_others, which stays org-scoped.
      "chat.read",
    ],
  },
];

// Seeded service principal for single-user deployments (T-2 resolver; architect ruling:
// never an integer sentinel in the user-id namespace — string namespace only).
const SINGLE_USER_PRINCIPAL = {
  principal_type: "service",
  principal_id: "single-user",
  role: "super_admin",
};

// #53: the scope an action may be asked at. Anything absent is 'any' — the
// existing behaviour, and the default the column carries. Only actions that
// would be UNSAFE at another scope belong here.
const ACTION_SCOPES = Object.freeze({ "org.member": "org" });

module.exports = {
  DOCUMENT_ACTIONS,
  AUDIT_ACTIONS,
  DIRECTORY_ACTIONS,
  ALL_ACTIONS,
  ACTION_SCOPES,
  SYSTEM_ROLES,
  SINGLE_USER_PRINCIPAL,
};

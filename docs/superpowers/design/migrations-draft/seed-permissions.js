// T-1 seed — vocabulary + system roles + matrix. Single source of truth: the SQL in
// migrations-draft/02_backfill.sql step 7a is GENERATED from this file at T-1 authoring time.
// Runtime home: server/prisma/seeds/permissions.js (run via `prisma db seed`, idempotent upserts).

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

const ALL_ACTIONS = [
  ...DOCUMENT_ACTIONS,
  "workspace.read",
  "workspace.write",
  "workspace.delete",
  "workspace.members.manage",
  "chat.read_others",
  "chat.send",
  "document.bulk_export",
  "access.diagnose",
  "role.grant",
  "role.revoke",
  "sso.issue",
  "key.manage",
  "settings.write",
  "user.manage",
];

const SYSTEM_ROLES = [
  { name: "super_admin", scope: "org", permissions: ALL_ACTIONS },
  {
    name: "setup_admin",
    scope: "org",
    permissions: [
      "settings.write", "user.manage", "key.manage", "sso.issue",
      "workspace.read", "access.diagnose", "role.grant", "role.revoke",
    ],
  },
  {
    name: "content_moderator",
    scope: "org",
    permissions: [
      "chat.read_others", "document.read", "document.search",
      "document.update", "document.delete", "document.bulk_export", "access.diagnose",
    ],
  },
  {
    name: "member",
    scope: "org",
    permissions: [
      "workspace.read", "workspace.write", "chat.send",
      "document.create", "document.read", "document.search",
      "document.update", "document.pin", "document.watch", "document.share",
    ],
  },
  {
    name: "owner",
    scope: "workspace",
    permissions: [
      "workspace.read", "workspace.write", "workspace.delete", "workspace.members.manage",
      "chat.send", ...DOCUMENT_ACTIONS,
    ],
  },
  {
    name: "editor",
    scope: "workspace",
    permissions: [
      "workspace.read", "workspace.write", "chat.send",
      "document.create", "document.read", "document.search",
      "document.update", "document.delete", "document.pin", "document.watch",
    ],
  },
  {
    name: "viewer",
    scope: "workspace",
    permissions: ["workspace.read", "document.read", "document.search", "chat.send"],
  },
];

// Seeded service principal for single-user deployments (T-2 resolver, architect ruling:
// never an integer sentinel in the user-id namespace).
const SINGLE_USER_PRINCIPAL = {
  principal_type: "service",
  principal_id: "single-user",
  role: "super_admin",
};

// Matrix is refined in T-2 conformance tests (generated from role_permissions seed).
// Any change here regenerates 02_backfill.sql step 7a — never hand-edit one side.
module.exports = { DOCUMENT_ACTIONS, ALL_ACTIONS, SYSTEM_ROLES, SINGLE_USER_PRINCIPAL };

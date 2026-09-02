// T-4b (#29) W-9 — the resolved row's workspace is what gets authorized.
//
// PR-4a's `binding` narrows a key that HAS a workspace binding. It says nothing about an
// unbound key: `validApiKey` authorizes against the binding (null → an org-wide check), and
// the route then resolves any workspace by slug. So a key whose creator holds grants on
// workspace A reaches workspace B — the creator's org-wide role covers the action, and
// nothing ever compares the action to the workspace actually addressed (G8, 22 sites).
//
// The fix is in the middleware, not at 22 call sites: when a route declares a slug/id
// binding, resolve that workspace first and authorize against IT.
// RED on main: the cross-workspace case is allowed.

process.env.API_KEY_PEPPER = process.env.API_KEY_PEPPER || "t4b-ws-api-key-pepper-32-bytes!!";

jest.mock("../models/systemSettings", () => ({
  SystemSettings: { isMultiUserMode: jest.fn().mockResolvedValue(true) },
}));
jest.mock("../models/apiKeys", () => ({ ApiKey: { resolve: jest.fn(), touch: jest.fn() } }));
jest.mock("../utils/events", () => ({ emitAuditEvent: jest.fn().mockResolvedValue({}) }));
jest.mock("../utils/prisma", () => ({
  $transaction: async (fn) => fn({ api_keys: { update: jest.fn() } }),
  workspaces: { findUnique: jest.fn() },
  api_keys: { findUnique: jest.fn().mockResolvedValue({ createdBy: 5 }) },
  workspace_users: { findMany: jest.fn().mockResolvedValue([]) },
  // S12 (#136): the resolver reads the key creator's row to refuse a SUSPENDED
  // one, and an unreadable users table denies. Active creator by default.
  users: {
    count: jest.fn().mockResolvedValue(3),
    findUnique: jest.fn().mockResolvedValue({ suspended: 0 }),
  },
  permissions: { findUnique: jest.fn() },
  principal_role_grants: { findMany: jest.fn() },
  role_permissions: { findMany: jest.fn() },
}));

const express = require("express");
const request = require("supertest");
const { ApiKey } = require("../models/apiKeys");
const prisma = require("../utils/prisma");
const { validApiKey } = require("../utils/middleware/validApiKey");

const WORKSPACE_A = 1;
const WORKSPACE_B = 2;

/** The creator holds `chat.write` on workspace A only. */
function policyStoreGrantingWorkspaceA() {
  prisma.permissions.findUnique.mockResolvedValue({ id: 1 });
  prisma.role_permissions.findMany.mockResolvedValue([{ effect: "allow", role_id: 1 }]);
  // The engine narrows grants by the resource's workspace, so the store answers per query.
  prisma.principal_role_grants.findMany.mockImplementation(async ({ where }) => {
    const scope = where.AND?.[1];
    const asks = scope?.OR?.some((clause) => clause.workspace_id === WORKSPACE_A);
    return asks ? [{ role_id: 1 }] : [];
  });
}

function appFor(binding) {
  const app = express();
  app.get(
    "/api/test/:slug",
    [validApiKey("chat.write", binding)],
    (_req, res) => res.json({ ok: true })
  );
  return app;
}

const call = (app, slug) =>
  request(app).get(`/api/test/${slug}`).set("Authorization", "Bearer apw-key-t4b-secret");

beforeEach(() => {
  jest.clearAllMocks();
  // an UNBOUND key: PR-4a's binding check passes it through unconditionally
  ApiKey.resolve.mockResolvedValue({
    id: 11, keyPrefix: "apw-key-t4b", scopes: ["chat.write"],
    workspaceId: null, expiresAt: null, revokedAt: null,
  });
  policyStoreGrantingWorkspaceA();
});

describe("T-4b W-9: an unbound key is authorized against the workspace it addresses", () => {
  test("reaching the workspace its creator holds the grant on is allowed", async () => {
    prisma.workspaces.findUnique.mockResolvedValue({ id: WORKSPACE_A });
    const response = await call(appFor({ workspaceSlugParam: "slug" }), "workspace-a");
    expect(response.status).toBe(200);
  });

  test("reaching a DIFFERENT workspace is denied, though the scope string permits it", async () => {
    // The hole: nothing compared chat.write to workspace B. The key's scope says
    // chat.write, the creator holds chat.write somewhere, and the route resolves B.
    prisma.workspaces.findUnique.mockResolvedValue({ id: WORKSPACE_B });
    const response = await call(appFor({ workspaceSlugParam: "slug" }), "workspace-b");
    expect(response.status).toBe(403);
  });

  test("an unresolvable slug does not leak whether the workspace exists", async () => {
    prisma.workspaces.findUnique.mockResolvedValue(null);
    const response = await call(appFor({ workspaceSlugParam: "slug" }), "does-not-exist");
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Insufficient scope." });
  });

  test("a route with NO binding is still authorized org-wide, not against a stray param", async () => {
    // Document routes have no workspace in the path by design (recon: attachment happens
    // later). They must keep working, and must not pick up :slug as a workspace.
    prisma.principal_role_grants.findMany.mockResolvedValue([{ role_id: 1 }]);
    const response = await call(appFor(null), "not-a-workspace");
    expect(response.status).toBe(200);
  });
});

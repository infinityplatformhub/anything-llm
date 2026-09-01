// T-4b (#29) W-8 — the grant half of `/v1` authorization, over real HTTP.
//
// PR-4a gave `validApiKey` the SCOPE half: does this key's scope string permit the action.
// Nothing asked the other half — does the principal behind the key actually hold a grant
// for it. Effective permission is grants(createdBy) ∩ scopes(key), so a key whose creator
// was demoted, or which was minted with a scope its creator never held, still passed.
//
// The check lands in validApiKey itself rather than a router-level middleware: Express runs
// router `use()` in registration order, and every /v1 route registers after the mount, so a
// separate middleware could only run BEFORE apiKeyContext exists — forcing a second key
// lookup and, worse, a grant denial that never reaches `auth.key_used`.
// RED on main: every case below is allowed.

process.env.API_KEY_PEPPER = process.env.API_KEY_PEPPER || "t4b-http-api-key-pepper-32-bytes";

jest.mock("../models/systemSettings", () => ({
  SystemSettings: { isMultiUserMode: jest.fn().mockResolvedValue(true) },
}));
jest.mock("../models/apiKeys", () => ({ ApiKey: { resolve: jest.fn(), touch: jest.fn() } }));
jest.mock("../utils/events", () => ({ emitAuditEvent: jest.fn().mockResolvedValue({}) }));
jest.mock("../utils/prisma", () => ({
  $transaction: async (fn) => fn({ api_keys: { update: jest.fn() } }),
  workspaces: { findUnique: jest.fn() },
  api_keys: { findUnique: jest.fn() },
  workspace_users: { findMany: jest.fn().mockResolvedValue([]) },
}));
jest.mock("../utils/authorization/engine", () => {
  const actual = jest.requireActual("../utils/authorization/engine");
  return { ...actual, DatabaseAuthorizationEngine: jest.fn() };
});

const express = require("express");
const request = require("supertest");
const { ApiKey } = require("../models/apiKeys");
const { emitAuditEvent } = require("../utils/events");
const prisma = require("../utils/prisma");
const { DatabaseAuthorizationEngine } = require("../utils/authorization/engine");
const { validApiKey } = require("../utils/middleware/validApiKey");

const KEY_ROW = {
  id: 11,
  keyPrefix: "apw-key-t4b",
  scopes: ["workspace.write"],
  workspaceId: null,
  expiresAt: null,
  revokedAt: null,
};

function appFor(action) {
  const app = express();
  app.get("/api/test", [validApiKey(action)], (_req, res) => res.json({ ok: true }));
  return app;
}

const call = (app) =>
  request(app).get("/api/test").set("Authorization", "Bearer apw-key-t4b-secret");

/** Point the mocked engine at a fixed decision and capture what it was asked. */
function engineAnswers(decision) {
  const authorize = jest.fn().mockResolvedValue(decision);
  DatabaseAuthorizationEngine.mockImplementation(() => ({ authorize }));
  return authorize;
}

beforeEach(() => {
  jest.clearAllMocks();
  ApiKey.resolve.mockResolvedValue(KEY_ROW);
  prisma.api_keys.findUnique.mockResolvedValue({ createdBy: 5 });
  prisma.workspace_users.findMany.mockResolvedValue([]);
});

describe("T-4b W-8: /v1 checks the grant half, not only the scope half", () => {
  test("a key whose creator lacks the grant is 403 even though its scope permits the action", async () => {
    engineAnswers({ allowed: false, reason: "no_permission_in_roles", matchedPolicyIds: [] });
    const response = await call(appFor("workspace.write"));
    expect(response.status).toBe(403);
  });

  test("a key whose creator holds the grant still passes — /v1 is not universally denied", async () => {
    engineAnswers({ allowed: true, reason: "allowed_by_role", matchedPolicyIds: [] });
    const response = await call(appFor("workspace.write"));
    expect(response.status).toBe(200);
  });

  test("the scope half runs FIRST — a scope failure never reaches the engine", async () => {
    // Order matters for more than efficiency: the engine reads the policy store, and a
    // request whose scope already failed must not be able to make it do work.
    const authorize = engineAnswers({ allowed: true, reason: "allowed_by_role", matchedPolicyIds: [] });
    const response = await call(appFor("workspace.delete")); // key holds workspace.write
    expect(response.status).toBe(403);
    expect(authorize).not.toHaveBeenCalled();
  });

  test("a grant denial is recorded in the SAME audit event, not a silent 403", async () => {
    // auth.key_used already carries `allowed`; a grant denial has to be visible there or
    // the audit trail says the key was used successfully and the caller saw a 403.
    engineAnswers({ allowed: false, reason: "no_grants", matchedPolicyIds: [] });
    await call(appFor("workspace.write"));
    const [type, payload] = emitAuditEvent.mock.calls[0];
    expect(type).toBe("auth.key_used");
    expect(payload.allowed).toBe(false);
    expect(payload.denyReason).toBe("grant");
  });

  test("a scope denial is still attributed to scope, not to grant", async () => {
    engineAnswers({ allowed: true, reason: "allowed_by_role", matchedPolicyIds: [] });
    await call(appFor("workspace.delete"));
    const [, payload] = emitAuditEvent.mock.calls[0];
    expect(payload.allowed).toBe(false);
    expect(payload.denyReason).toBe("scope");
  });

  test("an allowed request records no deny reason", async () => {
    engineAnswers({ allowed: true, reason: "allowed_by_role", matchedPolicyIds: [] });
    await call(appFor("workspace.write"));
    const [, payload] = emitAuditEvent.mock.calls[0];
    expect(payload.allowed).toBe(true);
    expect(payload.denyReason ?? null).toBeNull();
  });

  test("a wildcard key skips the grant check — the burn-down routes stay reachable", async () => {
    // Wildcard routes carry no per-route action to evaluate. They are on Dev1's burn-down
    // (EXPECTED_WILDCARD_ROUTES); until it reaches zero they keep scope-only behaviour,
    // recorded in the ledger rather than silently denied.
    ApiKey.resolve.mockResolvedValue({ ...KEY_ROW, scopes: ["*"] });
    const authorize = engineAnswers({ allowed: false, reason: "no_grants", matchedPolicyIds: [] });
    const response = await call(appFor("*"));
    expect(response.status).toBe(200);
    expect(authorize).not.toHaveBeenCalled();
  });

  test("a key with no resolvable actor is denied rather than passed through", async () => {
    // resolveActor returns null for a revoked/expired key. No actor means nothing to
    // authorize, and "nothing to authorize" must never read as "nothing objected".
    ApiKey.resolve.mockResolvedValue({ ...KEY_ROW, revokedAt: new Date() });
    engineAnswers({ allowed: true, reason: "allowed_by_role", matchedPolicyIds: [] });
    const response = await call(appFor("workspace.write"));
    expect(response.status).toBe(403);
  });

  test("an engine failure denies — an unavailable policy store is never an allow", async () => {
    const authorize = jest.fn().mockRejectedValue(new Error("policy store down"));
    DatabaseAuthorizationEngine.mockImplementation(() => ({ authorize }));
    const response = await call(appFor("workspace.write"));
    expect(response.status).toBe(403);
  });

  test("the engine is asked about the action the route declares", async () => {
    const authorize = engineAnswers({ allowed: true, reason: "allowed_by_role", matchedPolicyIds: [] });
    await call(appFor("workspace.write"));
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "workspace.write",
        actor: expect.objectContaining({ id: "api-key:11" }),
      })
    );
  });
});

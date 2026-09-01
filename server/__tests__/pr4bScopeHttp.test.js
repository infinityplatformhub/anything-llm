process.env.API_KEY_PEPPER = process.env.API_KEY_PEPPER || "pr4b-http-api-key-pepper-32-bytes";

jest.mock("../models/systemSettings", () => ({ SystemSettings: { isMultiUserMode: jest.fn().mockResolvedValue(true) } }));
jest.mock("../models/apiKeys", () => ({ ApiKey: { resolve: jest.fn(), touch: jest.fn() } }));
jest.mock("../utils/events", () => ({ emitAuditEvent: jest.fn().mockResolvedValue({}) }));
jest.mock("../utils/prisma", () => ({
  $transaction: async (fn) => fn({ api_keys: { update: jest.fn() } }),
  workspaces: { findUnique: jest.fn() },
}));

const express = require("express");
const request = require("supertest");
const { ApiKey } = require("../models/apiKeys");
const prisma = require("../utils/prisma");
const { validApiKey } = require("../utils/middleware/validApiKey");
const { ROUTE_SCOPES, scopeFor } = require("../utils/apiKeySecurity/scopes");

const key = (scopes, workspaceId = null) => ({
  id: 11, keyPrefix: "apw-key-pr4b", scopes, workspaceId, expiresAt: null, revokedAt: null,
});

function appFor(action, binding) {
  const app = express();
  app.get("/api/test/:slug?", [validApiKey(action, binding)], (_req, res) => res.json({ ok: true }));
  return app;
}

const call = (app, path = "/api/test") =>
  request(app).get(path).set("Authorization", "Bearer apw-key-pr4b-secret");

// One entry per distinct scope this PR introduces to the table, paired with a scope
// the key actually holds that must NOT open it.
const GRID = [
  ["workspace.create", "workspace.write"],
  ["workspace.delete", "workspace.write"],
  ["workspace.embeddings.manage", "workspace.write"],
  ["document.pin", "document.write"],
  ["document.search", "document.read"],
  ["chat.read", "chat.write"],
  ["chat.write", "chat.read"],
  ["thread.create", "thread.write"],
  ["thread.write", "thread.create"],
  ["thread.delete", "thread.write"],
];

describe("PR-4b workspace and thread scope enforcement", () => {
  test.each(GRID)("a key holding only %s is refused where %s is required", async (required, owned) => {
    ApiKey.resolve.mockResolvedValueOnce(key([owned]));
    const response = await call(appFor(required));
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Insufficient scope." });
  });

  test.each(GRID)("a key holding %s reaches the handler", async (required) => {
    ApiKey.resolve.mockResolvedValueOnce(key([required]));
    const response = await call(appFor(required));
    expect(response.status).toBe(200);
  });

  test("a key bound to one workspace cannot act on another workspace's slug", async () => {
    ApiKey.resolve.mockResolvedValueOnce(key(["chat.write"], 7));
    prisma.workspaces.findUnique.mockResolvedValueOnce({ id: 8 });
    const response = await call(appFor("chat.write", { workspaceSlugParam: "slug" }), "/api/test/other-workspace");
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Insufficient scope." });
  });

  test("a key bound to a workspace still reaches that same workspace", async () => {
    ApiKey.resolve.mockResolvedValueOnce(key(["chat.write"], 7));
    prisma.workspaces.findUnique.mockResolvedValueOnce({ id: 7 });
    const response = await call(appFor("chat.write", { workspaceSlugParam: "slug" }), "/api/test/mine");
    expect(response.status).toBe(200);
  });

  test("every workspace and thread route resolves to a scope, so none can boot unguarded", () => {
    const routes = Object.keys(ROUTE_SCOPES).filter((entry) => entry.includes("/v1/workspace"));
    expect(routes).toHaveLength(17);
    for (const entry of routes) {
      const [method, ...rest] = entry.split(" ");
      const scope = scopeFor(method, rest.join(" "));
      expect(typeof scope).toBe("string");
      expect(scope).not.toBe("*");
      expect(() => validApiKey(scope)).not.toThrow();
    }
  });
});

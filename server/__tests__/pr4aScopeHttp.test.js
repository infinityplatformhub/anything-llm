process.env.API_KEY_PEPPER = process.env.API_KEY_PEPPER || "pr4a-http-api-key-pepper-32-bytes";

jest.mock("../models/systemSettings", () => ({ SystemSettings: { isMultiUserMode: jest.fn().mockResolvedValue(true) } }));
jest.mock("../models/apiKeys", () => ({ ApiKey: { resolve: jest.fn(), touch: jest.fn() } }));
jest.mock("../utils/events", () => ({ emitAuditEvent: jest.fn().mockResolvedValue({}) }));
// T-4b: /v1 now checks the grant half too — see __testHelpers__/grantStore.js.
jest.mock("../utils/prisma", () => require("../__testHelpers__/grantStore").grantingPrismaMock());

const express = require("express");
const request = require("supertest");
const { ApiKey } = require("../models/apiKeys");
const { validApiKey } = require("../utils/middleware/validApiKey");

function appFor(action, binding) {
  const app = express();
  app.get("/api/test/:workspaceId?", [validApiKey(action, binding)], (_req, res) => res.json({ ok: true }));
  return app;
}

const key = (scopes, workspaceId = null) => ({ id: 7, keyPrefix: "apw-key-test", scopes, workspaceId, expiresAt: null, revokedAt: null });

describe("PR-4a key scope HTTP enforcement", () => {
  test.each([
    ["user.read", "user.write"],
    ["invite.read", "invite.delete"],
    ["system.read", "sso.issue"],
  ])("scope %s cannot call route requiring %s", async (owned, required) => {
    ApiKey.resolve.mockResolvedValueOnce(key([owned]));
    const response = await request(appFor(required)).get("/api/test").set("Authorization", "Bearer apw-key-test-secret");
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Insufficient scope." });
  });

  test("matching scope reaches handler", async () => {
    ApiKey.resolve.mockResolvedValueOnce(key(["user.read"]));
    const response = await request(appFor("user.read")).get("/api/test").set("Authorization", "Bearer apw-key-test-secret");
    expect(response.status).toBe(200);
  });

  test("workspace-bound key cannot target another workspace", async () => {
    ApiKey.resolve.mockResolvedValueOnce(key(["workspace.read"], 7));
    const response = await request(appFor("workspace.read", { workspaceParam: "workspaceId" }))
      .get("/api/test/8").set("Authorization", "Bearer apw-key-test-secret");
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Insufficient scope." });
  });
});

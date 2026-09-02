/**
 * #50 RED (2), PMO ruling: deleting the route must not break keys that were
 * already minted holding `sso.issue`.
 *
 * `scopes` is a JSON list on the key row. Removing a route mapping does not
 * rewrite those rows, and it must not need to — a key carrying a scope that no
 * longer addresses anything is inert, not invalid. If an unknown scope string
 * could poison a key, every scope retirement would become a migration and a
 * fleet-wide outage for whoever held it.
 */

process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER || "s50-inert-api-key-pepper-32-bytes-ok";
process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "s50-inert-")
  );

jest.mock("../../models/systemSettings", () => ({
  SystemSettings: { isMultiUserMode: jest.fn().mockResolvedValue(true) },
}));
jest.mock("../../models/apiKeys", () => ({
  ApiKey: { resolve: jest.fn(), touch: jest.fn() },
}));
jest.mock("../../utils/events", () => ({
  emitAuditEvent: jest.fn().mockResolvedValue({}),
}));
jest.mock("../../utils/prisma", () =>
  require("../../__testHelpers__/grantStore").grantingPrismaMock()
);

const express = require("express");
const request = require("supertest");
const { ApiKey } = require("../../models/apiKeys");
const { validApiKey } = require("../../utils/middleware/validApiKey");

const BEARER = "Bearer apw-key-test-secret";
const key = (scopes) => ({
  id: 7,
  keyPrefix: "apw-key-test",
  scopes,
  workspaceId: null,
  expiresAt: null,
  revokedAt: null,
});

function appFor(action) {
  const app = express();
  app.get("/api/test", [validApiKey(action)], (_req, res) =>
    res.json({ ok: true })
  );
  return app;
}

describe("#50: a retired scope leaves the rest of the key working", () => {
  test("a key holding sso.issue alongside user.read still calls user.read", async () => {
    ApiKey.resolve.mockResolvedValueOnce(key(["sso.issue", "user.read"]));
    const response = await request(appFor("user.read"))
      .get("/api/test")
      .set("Authorization", BEARER);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });

  test("sso.issue alone grants nothing, and is refused like any absent scope", async () => {
    ApiKey.resolve.mockResolvedValueOnce(key(["sso.issue"]));
    const response = await request(appFor("user.read"))
      .get("/api/test")
      .set("Authorization", BEARER);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Insufficient scope." });
  });
});

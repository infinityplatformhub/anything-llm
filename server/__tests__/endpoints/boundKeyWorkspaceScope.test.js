process.env.API_KEY_PEPPER = process.env.API_KEY_PEPPER || "bound-key-test-pepper-32-bytes-min";
process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();

/**
 * A workspace-bound API key must not reach past the workspace it was issued for.
 *
 * The scope middleware binds the fifteen routes that carry a slug. These two carry
 * no workspace in the path, so the middleware cannot refuse them and the handler has
 * to. Without these guards a bound key lists every workspace in the deployment —
 * including each one's thread slugs and the user ids behind them — and can create
 * further workspaces it was never scoped to.
 */
jest.mock("../../models/systemSettings", () => ({
  SystemSettings: { isMultiUserMode: jest.fn().mockResolvedValue(true) },
}));
jest.mock("../../models/apiKeys", () => ({ ApiKey: { resolve: jest.fn(), touch: jest.fn() } }));
jest.mock("../../utils/events", () => ({ emitAuditEvent: jest.fn().mockResolvedValue({}) }));
// T-4b: /v1 now checks the grant half too — see __tests__/helpers/grantStore.js.
jest.mock("../../utils/prisma", () => ({
  ...require("../helpers/grantStore").grantingPrismaMock(),
  workspaces: { findUnique: jest.fn(), findMany: jest.fn() },
}));
jest.mock("../../models/workspace", () => ({
  Workspace: { _findMany: jest.fn(), new: jest.fn() },
}));
jest.mock("../../models/telemetry", () => ({ Telemetry: { sendTelemetry: jest.fn() } }));
jest.mock("../../utils/files/purgeDocument", () => ({
  purgeDocument: jest.fn().mockResolvedValue(true),
}));

const express = require("express");
const request = require("supertest");
const { ApiKey } = require("../../models/apiKeys");
const { Workspace } = require("../../models/workspace");
const { apiWorkspaceEndpoints } = require("../../endpoints/api/workspace");
const { apiDocumentEndpoints } = require("../../endpoints/api/document");
const { apiSystemEndpoints } = require("../../endpoints/api/system");
const { purgeDocument } = require("../../utils/files/purgeDocument");
const prisma = require("../../utils/prisma");

const key = (scopes, workspaceId = null) => ({
  id: 3, keyPrefix: "apw-key-bound", scopes, workspaceId, expiresAt: null, revokedAt: null,
});

function app() {
  const server = express();
  server.use(express.json());
  apiWorkspaceEndpoints(server);
  apiDocumentEndpoints(server);
  apiSystemEndpoints(server);
  return server;
}

const auth = (req) => req.set("Authorization", "Bearer apw-key-bound-secret");

beforeEach(() => {
  jest.clearAllMocks();
  Workspace._findMany.mockResolvedValue([]);
  Workspace.new.mockResolvedValue({ workspace: { id: 1, name: "n" }, message: null });
  prisma.workspaces.findMany.mockResolvedValue([]);
});

describe("workspace-bound API keys", () => {
  test("listing workspaces returns only the workspace the key is bound to", async () => {
    ApiKey.resolve.mockResolvedValueOnce(key(["workspace.read"], 7));
    const response = await auth(request(app()).get("/v1/workspaces"));

    expect(response.status).toBe(200);
    expect(Workspace._findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 } })
    );
  });

  test("an unbound key still lists every workspace", async () => {
    ApiKey.resolve.mockResolvedValueOnce(key(["workspace.read"]));
    const response = await auth(request(app()).get("/v1/workspaces"));

    expect(response.status).toBe(200);
    expect(Workspace._findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} })
    );
  });

  test("a bound key cannot create a workspace it was never scoped to", async () => {
    ApiKey.resolve.mockResolvedValueOnce(key(["workspace.create"], 7));
    const response = await auth(request(app()).post("/v1/workspace/new")).send({ name: "mine" });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Insufficient scope." });
    expect(Workspace.new).not.toHaveBeenCalled();
  });

  test("an unbound key with the scope still creates a workspace", async () => {
    ApiKey.resolve.mockResolvedValueOnce(key(["workspace.create"]));
    const response = await auth(request(app()).post("/v1/workspace/new")).send({ name: "mine" });

    expect(response.status).toBe(200);
    expect(Workspace.new).toHaveBeenCalled();
  });

  // E-1 (QA-2): a key scoped to workspace A embedded a document into workspace B by
  // naming B in the request body. These four routes take their targets from the body,
  // so the slug binding in the scope middleware never sees them.
  describe.each([
    ["/v1/document/upload-link", { link: "https://example.com" }],
    ["/v1/document/raw-text", { textContent: "hello", metadata: { title: "t" } }],
  ])("addToWorkspaces on POST %s", (route, body) => {
    test("a bound key naming another workspace is refused", async () => {
      ApiKey.resolve.mockResolvedValueOnce(key(["document.write"], 7));
      prisma.workspaces.findMany.mockResolvedValueOnce([]); // slug belongs to nobody this key owns

      const response = await auth(request(app()).post(route)).send({
        ...body,
        addToWorkspaces: "someone-elses-workspace",
      });

      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: "Insufficient scope." });
    });

    test("a bound key naming a workspace it does own passes the check", async () => {
      ApiKey.resolve.mockResolvedValueOnce(key(["document.write"], 7));
      prisma.workspaces.findMany.mockResolvedValueOnce([{ slug: "mine" }]);

      const response = await auth(request(app()).post(route)).send({
        ...body,
        addToWorkspaces: "mine",
      });

      expect(response.status).not.toBe(403);
    });

    test("a bound key naming its own workspace plus another is refused entirely", async () => {
      ApiKey.resolve.mockResolvedValueOnce(key(["document.write"], 7));
      prisma.workspaces.findMany.mockResolvedValueOnce([{ slug: "mine" }]);

      const response = await auth(request(app()).post(route)).send({
        ...body,
        addToWorkspaces: "mine,theirs",
      });

      expect(response.status).toBe(403);
    });

    test("an unbound key is not restricted", async () => {
      ApiKey.resolve.mockResolvedValueOnce(key(["document.write"]));

      const response = await auth(request(app()).post(route)).send({
        ...body,
        addToWorkspaces: "anything",
      });

      expect(response.status).not.toBe(403);
      expect(prisma.workspaces.findMany).not.toHaveBeenCalled();
    });
  });

  // remove-documents purges by name across the whole deployment. There is no
  // workspace anywhere in the request for the slug binding to catch.
  test("a bound key cannot purge documents system-wide", async () => {
    ApiKey.resolve.mockResolvedValueOnce(key(["document.delete"], 7));

    const response = await auth(
      request(app()).delete("/v1/system/remove-documents")
    ).send({ names: ["custom-documents/theirs.json"] });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Insufficient scope." });
    expect(purgeDocument).not.toHaveBeenCalled();
  });

  test("an unbound key with document.delete still purges", async () => {
    ApiKey.resolve.mockResolvedValueOnce(key(["document.delete"]));

    const response = await auth(
      request(app()).delete("/v1/system/remove-documents")
    ).send({ names: ["custom-documents/mine.json"] });

    expect(response.status).toBe(200);
    expect(purgeDocument).toHaveBeenCalledWith("custom-documents/mine.json");
  });
});

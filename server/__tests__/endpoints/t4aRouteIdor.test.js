process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();

jest.mock("../../utils/prisma", () => {
  const state = {
    workspaces: { findFirst: jest.fn() },
    workspace_users: { findFirst: jest.fn() },
    workspace_documents: { findFirst: jest.fn(), findMany: jest.fn() },
    workspace_parsed_files: {
      aggregate: jest.fn().mockResolvedValue({ _sum: 0 }),
    },
  };
  return { ...state, __state: state };
});
jest.mock("../../utils/files/purgeDocument", () => ({
  purgeDocument: jest.fn().mockResolvedValue(undefined),
  purgeFolder: jest.fn(),
}));
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
jest.mock("../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn() },
}));
jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_request, response, next) => {
    response.locals.multiUserMode = true;
    next();
  },
}));
// T-4a: this suite mocks prisma, so the real engine behind requirePermission has
// no policy tables and correctly reports the store as unavailable (503). The
// suite exercises the purge GUARD, not the authorization GATE — the gate is
// proven end-to-end against real Postgres in
// __tests__/security/authorization/routeWiring.test.js.
jest.mock("../../utils/middleware/requirePermission", () => ({
  requirePermission: () => (_request, _response, next) => next(),
  NON_DISCLOSING: new Set(),
}));
jest.mock("../../utils/files/multer", () => ({
  handleFileUpload: (_request, _response, next) => next(),
}));
jest.mock("../../utils/http", () => ({
  reqBody: (request) => request.body,
  multiUserMode: (response) => response.locals.multiUserMode,
  userFromSession: jest.fn(),
  safeJsonParse: (value, fallback) => {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  },
}));

const express = require("express");
const prisma = require("../../utils/prisma");
const { purgeDocument } = require("../../utils/files/purgeDocument");
const { userFromSession } = require("../../utils/http");
const { workspaceEndpoints } = require("../../endpoints/workspaces");

const LEGACY_ADMIN_WITHOUT_ORG_GRANT = {
  id: 77,
  role: "admin",
  username: "legacy-admin",
};
const WORKSPACE_B = { id: 20, slug: "workspace-b", name: "Workspace B" };
const DOCUMENT_B = {
  id: 5,
  workspaceId: 20,
  docId: "doc-b",
  docpath: "custom-documents/b.json",
};
let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  workspaceEndpoints(app);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.closeAllConnections?.();
  server.close(done);
}, 60_000);

beforeEach(() => {
  jest.clearAllMocks();
  userFromSession.mockResolvedValue(LEGACY_ADMIN_WITHOUT_ORG_GRANT);
  prisma.workspaces.findFirst.mockResolvedValue(WORKSPACE_B);
  prisma.workspace_documents.findFirst.mockResolvedValue(DOCUMENT_B);
  prisma.workspace_documents.findMany.mockResolvedValue([
    { workspaceId: WORKSPACE_B.id },
  ]);
});

test("G11: legacy admin role without org-wide grant cannot purge workspace document", async () => {
  const response = await fetch(
    `${baseUrl}/workspace/${WORKSPACE_B.slug}/remove-and-unembed`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentLocation: DOCUMENT_B.docpath }),
    }
  );

  expect(response.status).toBe(403);
  expect(purgeDocument).not.toHaveBeenCalled();
});

/**
 * P0-4 #11 QA-2 round 2: HTTP-level exploit regression.
 *
 * The first round of tests called the guard directly and never exercised
 * Workspace.getWithUser — whose manager bypass let a manager who is NOT a
 * member of workspace B reach the purge for B's document. This suite fires
 * real HTTP DELETEs through the actual route module with real models and a
 * mocked prisma, so the whole chain (getWithUser → guard → purgeDocument) runs.
 */
process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();

jest.mock("../../utils/prisma", () => {
  const state = {
    // workspace lookup by slug (getWithUser → get for admin/manager)
    workspaces: { findFirst: jest.fn() },
    // membership + doc lookups
    workspace_users: { findFirst: jest.fn() },
    workspace_documents: { findFirst: jest.fn(), findMany: jest.fn() },
    // Workspace.get → _getCurrentContextTokenCount aggregate
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
  Telemetry: { sendTelemetry: jest.fn().mockResolvedValue() },
}));
jest.mock("../../models/eventLogs", () => ({
  EventLogs: { logEvent: jest.fn().mockResolvedValue() },
}));
jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: jest.fn((_, response, next) => {
    response.locals.multiUserMode = true; // exploit runs in multi-user mode
    next();
  }),
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
  handleFileUpload: jest.fn((_, __, next) => next()),
}));
jest.mock("../../utils/http", () => {
  const real = jest.requireActual("../../utils/http");
  return {
    ...real,
    userFromSession: jest.fn(), // configured per test
  };
});

const express = require("express");
const prisma = require("../../utils/prisma");
const { purgeDocument } = require("../../utils/files/purgeDocument");
const { userFromSession } = require("../../utils/http");
const { workspaceEndpoints } = require("../../endpoints/workspaces");

const MANAGER = { id: 11, role: "manager", username: "mgr" };
const ADMIN = { id: 1, role: "admin", username: "root" };
const WS_B = { id: 20, slug: "ws-b", name: "Workspace B" };
const DOC_ONLY_IN_B = {
  id: 5,
  workspaceId: 20,
  docId: "doc-b",
  docpath: "custom-documents/b-only.json",
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
// #143: explicit timeout. This hook was untimed for as long as the #142 guard has
// existed — it scanned `afterAll(async () => {` only, so this callback form was
// invisible to it. `t4aRouteIdor.test.js:86` is the same shape and already carried
// `60_000`, which is where this number comes from.
afterAll((done) => {
  server.closeAllConnections?.(); // fetch keep-alive would block close()
  server.close(done);
}, 60_000);

beforeEach(() => {
  jest.clearAllMocks();
  // Default fixture: manager is NOT a member of ws-b; doc embedded only in b.
  prisma.workspaces.findFirst.mockResolvedValue(WS_B);
  prisma.workspace_users.findFirst.mockResolvedValue(null);
  prisma.workspace_documents.findFirst.mockResolvedValue(DOC_ONLY_IN_B);
  prisma.workspace_documents.findMany.mockResolvedValue([
    { workspaceId: 20 },
  ]);
});

const deleteDoc = (slug) =>
  fetch(`${baseUrl}/workspace/${slug}/remove-and-unembed`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documentLocation: DOC_ONLY_IN_B.docpath }),
  });

describe("HTTP DELETE workspace remove-and-unembed - QA-2 A1 issue 11", () => {
  it("manager who is NOT a member of the workspace gets 403; nothing purged", async () => {
    userFromSession.mockResolvedValue(MANAGER);

    const res = await deleteDoc("ws-b");

    expect(res.status).toBe(403);
    expect(purgeDocument).not.toHaveBeenCalled();
  });

  it("manager who IS a member gets 200 and exactly one purge", async () => {
    userFromSession.mockResolvedValue(MANAGER);
    prisma.workspace_users.findFirst.mockResolvedValue({
      user_id: 11,
      workspace_id: 20,
    });

    const res = await deleteDoc("ws-b");

    expect(res.status).toBe(200);
    expect(purgeDocument).toHaveBeenCalledTimes(1);
    expect(purgeDocument).toHaveBeenCalledWith(DOC_ONLY_IN_B.docpath);
  });

  // T-4a (#25) changed this contract deliberately. The guard used to short-circuit
  // on the legacy admin role, so a role string bought a system-wide purge.
  // Admin-ness is now an org-wide grant that requirePermission checks BEFORE this
  // guard runs (proven end-to-end in routeWiring.test.js); the guard is left with
  // only the blast-radius question, which a non-member cannot pass here because
  // this suite bypasses the gate. Renamed rather than deleted: the case still
  // pins real behaviour, just the opposite outcome.
  it("legacy admin role alone no longer purges — the grant does that now", async () => {
    userFromSession.mockResolvedValue(ADMIN);

    const res = await deleteDoc("ws-b");

    expect(res.status).toBe(403);
    expect(purgeDocument).not.toHaveBeenCalled();
  });

  it("manager member is denied when the doc is also embedded elsewhere", async () => {
    userFromSession.mockResolvedValue(MANAGER);
    prisma.workspace_users.findFirst.mockResolvedValue({
      user_id: 11,
      workspace_id: 20,
    });
    prisma.workspace_documents.findMany.mockResolvedValue([
      { workspaceId: 20 },
      { workspaceId: 30 },
    ]);

    const res = await deleteDoc("ws-b");

    expect(res.status).toBe(403);
    expect(purgeDocument).not.toHaveBeenCalled();
  });
});

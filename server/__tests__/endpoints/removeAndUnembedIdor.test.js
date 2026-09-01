/**
 * PR-0c (issue #11, G11): DELETE /workspace/:slug/remove-and-unembed let any
 * admin/manager purge ANY document system-wide by path — including documents
 * only embedded in workspaces they are not a member of (cross-workspace IDOR).
 *
 * Guard: the document must be embedded in the addressed workspace, and a
 * non-admin caller may not purge a document that is also embedded in other
 * workspaces.
 */
process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();

jest.mock("../../utils/prisma", () => ({
  workspace_documents: { findFirst: jest.fn(), findMany: jest.fn() },
  workspace_users: { findFirst: jest.fn() },
}));
jest.mock("../../utils/files/purgeDocument", () => ({
  purgeDocument: jest.fn().mockResolvedValue(undefined),
  purgeFolder: jest.fn(),
}));

const prisma = require("../../utils/prisma");
const { purgeDocument } = require("../../utils/files/purgeDocument");
const {
  canPurgeDocumentFromWorkspace,
} = require("../../utils/helpers/documentPurgeGuard");

describe("remove-and-unembed purge guard (PR-0c / G11)", () => {
  beforeEach(() => jest.clearAllMocks());

  const workspace = { id: 1, slug: "mine" };
  const admin = { id: 10, role: "admin" };
  const manager = { id: 11, role: "manager" };

  it("denies when the document is not embedded in the addressed workspace", async () => {
    prisma.workspace_documents.findFirst.mockResolvedValue(null);

    const result = await canPurgeDocumentFromWorkspace({
      workspace,
      user: manager,
      documentLocation: "custom-documents/other-teams-doc.json",
    });

    expect(result.allowed).toBe(false);
    expect(purgeDocument).not.toHaveBeenCalled();
  });

  it("denies a non-admin member when the document is also embedded in other workspaces", async () => {
    prisma.workspace_documents.findFirst.mockResolvedValue({
      id: 5,
      workspaceId: 1,
      docpath: "custom-documents/shared.json",
    });
    prisma.workspace_users.findFirst.mockResolvedValue({ user_id: 11 });
    prisma.workspace_documents.findMany.mockResolvedValue([
      { workspaceId: 1 },
      { workspaceId: 2 },
    ]);

    const result = await canPurgeDocumentFromWorkspace({
      workspace,
      user: manager,
      documentLocation: "custom-documents/shared.json",
    });

    expect(result.allowed).toBe(false);
  });

  it("allows a non-admin member when the document lives only in their workspace", async () => {
    prisma.workspace_documents.findFirst.mockResolvedValue({
      id: 5,
      workspaceId: 1,
      docpath: "custom-documents/own.json",
    });
    prisma.workspace_users.findFirst.mockResolvedValue({ user_id: 11 });
    prisma.workspace_documents.findMany.mockResolvedValue([
      { workspaceId: 1 },
    ]);

    const result = await canPurgeDocumentFromWorkspace({
      workspace,
      user: manager,
      documentLocation: "custom-documents/own.json",
    });

    expect(result.allowed).toBe(true);
  });

  it("allows an admin even when the document spans workspaces (system-wide doc management)", async () => {
    prisma.workspace_documents.findFirst.mockResolvedValue({
      id: 5,
      workspaceId: 1,
      docpath: "custom-documents/shared.json",
    });
    prisma.workspace_documents.findMany.mockResolvedValue([
      { workspaceId: 1 },
      { workspaceId: 2 },
    ]);

    const result = await canPurgeDocumentFromWorkspace({
      workspace,
      user: admin,
      documentLocation: "custom-documents/shared.json",
    });

    expect(result.allowed).toBe(true);
  });

  it("treats single-user mode (no user) as admin-equivalent", async () => {
    prisma.workspace_documents.findFirst.mockResolvedValue({
      id: 5,
      workspaceId: 1,
      docpath: "custom-documents/own.json",
    });
    prisma.workspace_documents.findMany.mockResolvedValue([
      { workspaceId: 1 },
      { workspaceId: 2 },
    ]);

    const result = await canPurgeDocumentFromWorkspace({
      workspace,
      user: null,
      documentLocation: "custom-documents/own.json",
    });

    expect(result.allowed).toBe(true);
  });
});

describe("route wiring (PR-0c)", () => {
  it("workspaces endpoint uses the guard before purgeDocument", () => {
    const source = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../endpoints/workspaces.js"),
      "utf8"
    );
    const purgeCallIdx = source.indexOf("await purgeDocument(");
    const guardIdx = source.indexOf("await canPurgeDocumentFromWorkspace(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(purgeCallIdx);
    // The guard's verdict must actually gate the purge with a 403.
    const gate = source.slice(guardIdx, purgeCallIdx);
    expect(gate).toMatch(
      /if \(!allowed\) return response\.status\(403\)\.json\(\{ error: reason \}\);/
    );
  });
});

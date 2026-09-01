/* eslint-env jest */
const { sourceIdentifier } = require("../../utils/chats");

const STALE_PUBLISHED = "1/1/2020, 12:00:00 PM";
const OLD_CONTENT = "the old content of the watched document";
const NEW_CONTENT = "the new content of the watched document";

let mockResolveConcluded;
const concluded = new Promise((resolve) => (mockResolveConcluded = resolve));
const mockVectorDatabase = {
  deleteDocumentFromNamespace: jest.fn(),
  addDocumentToNamespace: jest.fn(),
};
const mockUpdateSourceDocument = jest.fn();

jest.mock("../../jobs/helpers", () => ({
  log: jest.fn(),
  conclude: jest.fn(() => mockResolveConcluded()),
  updateSourceDocument: mockUpdateSourceDocument,
}));
jest.mock("../../utils/helpers", () => ({
  getVectorDbClass: jest.fn(() => mockVectorDatabase),
}));
jest.mock("../../utils/collectorApi", () => ({
  CollectorApi: jest.fn(() => ({
    online: jest.fn().mockResolvedValue(true),
    forwardExtensionRequest: jest
      .fn()
      .mockResolvedValue({ content: NEW_CONTENT }),
  })),
}));
jest.mock("../../utils/files", () => ({
  fileData: jest.fn().mockResolvedValue({
    title: "watched-and-pinned.html",
    published: STALE_PUBLISHED,
    pageContent: OLD_CONTENT,
  }),
}));
jest.mock("../../models/documents", () => ({
  Document: {
    parseDocumentTypeAndSource: jest.fn(() => ({
      metadata: { chunkSource: "link://example.com" },
      type: "link",
      source: "https://example.com",
    })),
    // Clause-aware mock (PR-0e): rows are filtered by the clause the job
    // actually sends, so the attack row below only blooms if the job matches
    // on basename instead of docpath.
    where: jest.fn(async (clause = {}) => {
      const rows = [
        {
          id: 2,
          docId: "other-workspace-doc-id",
          docpath: "custom-documents/watched-and-pinned.json",
          filename: "watched-and-pinned.json",
          workspace: { slug: "other-workspace", name: "Other Workspace" },
        },
        // Attack fixture: same basename, different docpath — an unrelated
        // document from another tenant's connector folder.
        {
          id: 3,
          docId: "foreign-doc-id",
          docpath: "connector-abc/watched-and-pinned.json",
          filename: "watched-and-pinned.json",
          workspace: { slug: "foreign-workspace", name: "Foreign Workspace" },
        },
      ];
      return rows.filter((row) =>
        Object.entries(clause).every(([field, want]) =>
          want !== null && typeof want === "object" && "not" in want
            ? row[field] !== want.not
            : row[field] === want
        )
      );
    }),
  },
}));
jest.mock("../../models/documentSyncQueue", () => ({
  DocumentSyncQueue: {
    validFileTypes: ["link"],
    staleDocumentQueues: jest.fn().mockResolvedValue([
      {
        id: 1,
        workspaceDoc: {
          id: 1,
          docId: "workspace-doc-id",
          docpath: "custom-documents/watched-and-pinned.json",
          filename: "watched-and-pinned.json",
          workspace: { slug: "workspace", name: "Workspace" },
        },
      },
    ]),
    calcNextSync: jest.fn(() => new Date()),
    _update: jest.fn(),
    saveRun: jest.fn(),
  },
}));
jest.mock("../../models/documentSyncRun", () => ({
  DocumentSyncRun: { statuses: { success: "success" } },
}));

// A pinned document is de-duplicated out of the RAG results by comparing the `sourceIdentifier` of
// the on-disk document against the identifier of every chunk returned by the vector database. A
// re-sync rewrites both of those, so if they drift apart the pinned document is also returned as
// chunks and gets injected into the context twice.
describe("watched document re-sync", () => {
  beforeAll(async () => {
    require("../../jobs/sync-watched-documents");
    await concluded;
  });

  it("stamps the workspace vectors with the source identifier written to disk", () => {
    const [, vectorPayload] =
      mockVectorDatabase.addDocumentToNamespace.mock.calls[0];
    const [, diskPayload] = mockUpdateSourceDocument.mock.calls[0];

    expect(diskPayload.published).not.toBe(STALE_PUBLISHED);
    expect(sourceIdentifier(vectorPayload)).toBe(sourceIdentifier(diskPayload));
  });

  it("stamps the vectors of every other workspace referencing the document with that same identifier", () => {
    const [bloomedSlug, bloomedPayload] =
      mockVectorDatabase.addDocumentToNamespace.mock.calls[1];
    const [, diskPayload] = mockUpdateSourceDocument.mock.calls[0];

    expect(bloomedSlug).toBe("other-workspace");
    expect(sourceIdentifier(bloomedPayload)).toBe(sourceIdentifier(diskPayload));
  });

  it("does not bloom to a document that only shares a basename (PR-0e attack case)", () => {
    const bloomedSlugs =
      mockVectorDatabase.addDocumentToNamespace.mock.calls.map(
        ([slug]) => slug
      );
    expect(bloomedSlugs).not.toContain("foreign-workspace");
    expect(mockVectorDatabase.addDocumentToNamespace).toHaveBeenCalledTimes(2);
  });
});

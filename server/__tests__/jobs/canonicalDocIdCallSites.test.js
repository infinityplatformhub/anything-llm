// T-4b (#29) W-12 — the call sites T-4b owns must find vectors by EITHER id.
//
// `doc-vectors-canonicalize` rewrites document_vectors.docId from the legacy
// workspace_documents uuid to the canonical documents.id. Every runtime caller still
// looking up by the legacy uuid then matches nothing — silently. For a DELETE that means
// the vectors of a deleted document stay in the store: the row is gone from
// workspace_documents, so nothing will ever clean them up, and they remain retrievable.
//
// The job refuses to run until the call sites move (CanonicalizeNotEnabledError), so this
// is not yet a live bug — it is the precondition for T-6 flipping the flag. T-4b does not
// flip it (C-1 ruling: T-6 owns the 7 remaining providers).
//
// The fix is to delete by both ids rather than to swap one for the other: the job is
// batched, so during the run one document's vectors are canonical while another's are
// still legacy, and a caller that reads only the new shape breaks for the ones not yet
// converted. Both-ids is correct before, during, and after.
// RED on main: the delete names only the legacy uuid.

const path = require("path");
const fs = require("fs");

const documentsSource = fs.readFileSync(
  path.resolve(__dirname, "../../models/documents.js"),
  "utf8"
);

describe("T-4b W-12: vector lookups tolerate legacy and canonical ids", () => {
  test("removeDocuments deletes vectors by canonical id as well as legacy uuid", () => {
    // Asserted on the source rather than through a mock because the failure mode is a
    // WHERE clause that silently matches zero rows — a mocked prisma would happily report
    // success either way, which is exactly how this would reach production unnoticed.
    const removeBlock = documentsSource.slice(
      documentsSource.indexOf("removeDocuments:"),
      documentsSource.indexOf("removeDocuments:") + 2500
    );
    expect(removeBlock).toMatch(/document_vectors\.deleteMany/);
    // both ids in the same predicate
    expect(removeBlock).toMatch(/docId:\s*\{\s*in:/);
  });

  test("deleteForWorkspace collects both ids, so a deleted workspace leaves no vectors", () => {
    const vectorsSource = fs.readFileSync(
      path.resolve(__dirname, "../../models/vectors.js"),
      "utf8"
    );
    const block = vectorsSource.slice(
      vectorsSource.indexOf("deleteForWorkspace:"),
      vectorsSource.indexOf("deleteIds:")
    );
    expect(block).toMatch(/doc\.documentId/);
    expect(block).toMatch(/doc\.docId/);
  });

  test("the canonicalize job still refuses to run — T-4b does not flip the flag (C-1)", async () => {
    const {
      run,
      CanonicalizeNotEnabledError,
    } = require("../../jobs/docVectorsCanonicalize");
    await expect(run({ enable: false })).rejects.toBeInstanceOf(
      CanonicalizeNotEnabledError
    );
  });

  test("the flag is not set anywhere in T-4b's own files", () => {
    // C-1: the 7 non-Lance providers still read legacy uuids and are T-6's. Enabling the
    // job here would leave vectors behind on every non-Lance deployment.
    for (const file of ["../../jobs/sync-watched-documents.js", "../../jobs/embedding-worker.js"]) {
      const source = fs.readFileSync(path.resolve(__dirname, file), "utf8");
      expect(source).not.toMatch(/ENABLE_DOC_VECTORS_CANONICALIZE\s*=/);
    }
  });
});

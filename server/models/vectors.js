const prisma = require("../utils/prisma");
const { Document } = require("./documents");

const DocumentVectors = {
  bulkInsert: async function (vectorRecords = []) {
    if (vectorRecords.length === 0) return;

    try {
      const inserts = [];
      vectorRecords.forEach((record) => {
        inserts.push(
          prisma.document_vectors.create({
            data: {
              docId: record.docId,
              vectorId: record.vectorId,
            },
          })
        );
      });
      await prisma.$transaction(inserts);
      return { documentsInserted: inserts.length };
    } catch (error) {
      console.error("Bulk insert failed", error);
      return { documentsInserted: 0 };
    }
  },

  /**
   * T-6 C-1 (#28): every id a document's vectors may be stored under.
   *
   * doc-vectors-canonicalize rewrites document_vectors.docId from the legacy
   * workspace_documents uuid to the canonical documents.id, in batches — so
   * mid-run one document's vectors are canonical while another's are still
   * legacy. A caller that reads only one shape silently matches zero rows, and
   * for a DELETE that leaves the vectors of a deleted document in the store with
   * nothing left to find them by.
   *
   * Resolving both is correct before, during and after the run. The lookup is by
   * the legacy uuid because that is what every caller still holds; the canonical
   * id comes off the stored row, never off the caller.
   *
   * @param {string} docId the legacy uuid a caller passes around
   * @returns {Promise<string[]>} distinct ids to match document_vectors.docId on
   */
  docIdVariants: async function (docId) {
    if (docId === null || docId === undefined) return [];
    const ids = new Set([String(docId)]);
    try {
      const document = await prisma.workspace_documents.findFirst({
        where: { docId: String(docId) },
        select: { documentId: true },
      });
      if (document?.documentId !== null && document?.documentId !== undefined)
        ids.add(String(document.documentId));
    } catch (error) {
      // A lookup failure must not turn a delete into a silent no-op: fall back to
      // the id the caller gave us rather than returning nothing.
      console.error("docIdVariants lookup failed", error.message);
    }
    return [...ids];
  },

  /** Vectors for a document under either id. See docIdVariants. */
  forDocument: async function (docId) {
    const ids = await this.docIdVariants(docId);
    if (ids.length === 0) return [];
    return this.where({ docId: { in: ids } });
  },

  where: async function (clause = {}, limit) {
    try {
      const results = await prisma.document_vectors.findMany({
        where: clause,
        take: limit || undefined,
      });
      return results;
    } catch (error) {
      console.error("Where query failed", error);
      return [];
    }
  },

  deleteForWorkspace: async function (workspaceId) {
    const documents = await Document.forWorkspace(workspaceId);
    // T-4b (#29) W-12: doc-vectors-canonicalize rewrites document_vectors.docId from the
    // legacy uuid to the canonical documents.id in batches, so both shapes coexist during
    // the run. Deleting by only one leaves a workspace's vectors behind after the
    // workspace is gone, with nothing left to find them by.
    const docIds = [
      ...new Set(
        documents
          .flatMap((doc) => [doc.docId, doc.documentId])
          .filter((id) => id !== null && id !== undefined)
          .map(String)
      ),
    ];

    try {
      await prisma.document_vectors.deleteMany({
        where: { docId: { in: docIds } },
      });
      return true;
    } catch (error) {
      console.error("Delete for workspace failed", error);
      return false;
    }
  },

  deleteIds: async function (ids = []) {
    try {
      await prisma.document_vectors.deleteMany({
        where: { id: { in: ids } },
      });
      return true;
    } catch (error) {
      console.error("Delete IDs failed", error);
      return false;
    }
  },

  delete: async function (clause = {}) {
    try {
      await prisma.document_vectors.deleteMany({ where: clause });
      return true;
    } catch (error) {
      console.error("Delete failed", error);
      return false;
    }
  },
};

module.exports = { DocumentVectors };

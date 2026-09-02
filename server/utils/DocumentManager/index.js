const fs = require("fs");
const path = require("path");
const {
  AuthorizationContractError,
} = require("../authorization/errors");
const {
  allowUnprovableRows,
} = require("../authorization/retrievalEnforcement");

const documentsPath =
  process.env.NODE_ENV === "development"
    ? path.resolve(__dirname, `../../storage/documents`)
    : path.resolve(process.env.STORAGE_DIR, `documents`);

class DocumentManager {
  constructor({ workspace = null, maxTokens = null }) {
    this.workspace = workspace;
    this.maxTokens = maxTokens || Number.POSITIVE_INFINITY;
    this.documentStoragePath = documentsPath;
  }

  log(text, ...args) {
    console.log(`\x1b[36m[DocumentManager]\x1b[0m ${text}`, ...args);
  }

  async pinnedDocuments(db = null) {
    if (!this.workspace) return [];
    const prisma = db ?? require("../prisma");
    // Selected through prisma rather than Document.where so `documentId` comes back: the
    // ACL keys on the canonical id, and the model's shape is not guaranteed to carry it.
    return await prisma.workspace_documents.findMany({
      where: { workspaceId: Number(this.workspace.id), pinned: true },
    });
  }

  /**
   * The pinned documents this actor may read.
   *
   * T-5 slice 2 (G17/S-21): pinned documents reach the prompt WITHOUT touching the vector
   * store, so slice 1's retrieval filter never saw them. Anyone who could chat in a
   * workspace received every pinned document in it, including ones `document_acl`
   * explicitly denied them — the ACL was enforced on the search path and bypassed on this
   * one.
   *
   * The SAME `DocumentAclFilter` decides both. Calling the engine per document was
   * rejected (Techlead ruling Q1): it would be a second definition of "readable" alongside
   * seam 02's, free to drift, and an N+1 query on every chat turn.
   *
   * @param {{aclFilter: Object, db?: Object}} input
   * @returns {Promise<Object[]>}
   */
  async pinnedDocs({ aclFilter, db = null } = {}) {
    // Null is never "no restriction" — the same contract queryAuthorized enforces. An
    // OPTIONAL filter is the shape that let #45's keyKind gap through: correct at every
    // call site that remembers it, silently absent at the one that does not.
    if (!aclFilter || typeof aclFilter !== "object") {
      throw new AuthorizationContractError(
        "pinnedDocs requires a DocumentAclFilter (aclFilter) — pinned documents bypass the vector store, so nothing else filters them"
      );
    }
    if (!this.workspace) return [];
    // A positively denied actor gets nothing, without touching the disk.
    if (aclFilter.matchNone === true) return [];

    const rows = await this.pinnedDocuments(db);
    if (rows.length === 0) return [];

    const denied = new Set((aclFilter.deniedDocumentIds ?? []).map(String));
    const allowed = Array.isArray(aclFilter.allowedDocumentIds)
      ? new Set(aclFilter.allowedDocumentIds.map(String))
      : null;
    const allowUnprovable = allowUnprovableRows();
    let unprovable = 0;

    const readable = rows.filter((row) => {
      // `document_acl` keys on `documents.id` (Int), NOT on the legacy `docId` string,
      // which stays frozen until the canonicalize job finishes. A row with no canonical id
      // cannot be matched against the ACL at all, so it cannot be shown to be readable.
      //
      // "No match found, therefore allow" is the one reading this must never have: it
      // would turn an id mismatch — a schema slip — into a silent leak rather than a
      // visible outage. Same rule as an unlabelled vector (S-26/G4).
      if (row.documentId === null || row.documentId === undefined) {
        unprovable += 1;
        return allowUnprovable;
      }
      const documentId = String(row.documentId);
      if (denied.has(documentId)) return false;
      if (allowed !== null && !allowed.has(documentId)) return false;
      return true;
    });

    if (unprovable > 0 && !allowUnprovable) {
      this.log(
        `${unprovable} pinned document(s) in workspace ${this.workspace.id} have no canonical documentId yet, so they cannot be proven readable and are EXCLUDED from context. They become available once the document canonicalize job has run.`
      );
    }

    let tokens = 0;
    const pinnedDocs = [];
    for await (const row of readable) {
      try {
        const filePath = path.resolve(this.documentStoragePath, row.docpath);
        const data = JSON.parse(
          fs.readFileSync(filePath, { encoding: "utf-8" })
        );

        if (
          !data.hasOwnProperty("pageContent") ||
          !data.hasOwnProperty("token_count_estimate")
        ) {
          this.log(
            `Skipping document - Could not find page content or token_count_estimate in pinned source.`
          );
          continue;
        }

        if (tokens >= this.maxTokens) {
          this.log(
            `Skipping document - Token limit of ${this.maxTokens} has already been exceeded by pinned documents.`
          );
          continue;
        }

        pinnedDocs.push(data);
        tokens += data.token_count_estimate || 0;
      } catch {}
    }

    this.log(
      `Found ${pinnedDocs.length} pinned sources - prepending to content with ~${tokens} tokens of content.`
    );
    return pinnedDocs;
  }
}

module.exports = { DocumentManager };

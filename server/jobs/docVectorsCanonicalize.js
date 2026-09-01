// T-1 (#17) — post-migration job: rewrite document_vectors.docId (legacy
// workspace_documents.docId) → canonical documents.id, batched by distinct document.
// Runs on the P0-6 queue BEFORE T-5's vector-metadata-backfill (single ordered chain;
// never in parallel with it). legacy_docid_map preserves the mapping — there is no
// migration rollback once this runs; recovery is from the map.
//
// ponytail: batch unit is documents, not vector rows (1 doc → N vectors share a docId);
// if a corpus ever has single documents with >10^6 chunks, add checkpoint resume.

const prisma = require("../utils/prisma");

const BATCH = 1000;

// GUARD (8b review, 2026-09-02): after this job rewrites document_vectors.docId to
// canonical ids, every runtime caller still looking vectors up by the legacy uuid
// (DocumentVectors.where({docId}) in 8 providers, Documents.removeDocuments,
// deleteForWorkspace) silently matches nothing — deleted documents would leave
// vectors behind. The job MUST NOT run until T-4b/T-5 migrate those call sites.
// ENABLE_DOC_VECTORS_CANONICALIZE is set by T-5 when the last call site moves.
class CanonicalizeNotEnabledError extends Error {}

async function run({ db = prisma, emit = () => {}, batch = BATCH, enable } = {}) {
  const enabled = enable ?? ("ENABLE_DOC_VECTORS_CANONICALIZE" in process.env);
  if (!enabled) {
    throw new CanonicalizeNotEnabledError(
      "doc-vectors-canonicalize refused: runtime call sites still read legacy uuid docIds — enable only when T-4b/T-5 have migrated them"
    );
  }

  const [counts] = await db.$queryRaw`
    SELECT count(DISTINCT wd."docId") AS total
    FROM workspace_documents wd
    WHERE wd."documentId" IS NOT NULL
      AND EXISTS (SELECT 1 FROM document_vectors dv WHERE dv."docId" = wd."docId")
  `;
  const total = Number(counts.total);
  let done = 0;
  for (;;) {
    // claim unmapped documents (NOT EXISTS — the map only grows; NOT IN would degrade)
    const rows = await db.$queryRaw`
      SELECT DISTINCT wd."docId" AS legacy_doc_id, wd."documentId" AS canonical_id
      FROM workspace_documents wd
      WHERE wd."documentId" IS NOT NULL
        AND EXISTS (SELECT 1 FROM document_vectors dv WHERE dv."docId" = wd."docId")
        AND NOT EXISTS (SELECT 1 FROM legacy_docid_map m WHERE m.legacy_doc_id = wd."docId")
      LIMIT ${batch}
    `;
    if (rows.length === 0) break;

    await db.$transaction(async (tx) => {
      // audit map first, inside the same transaction as the rewrite (recovery path)
      await tx.$executeRaw`
        INSERT INTO legacy_docid_map (legacy_doc_id, canonical_id)
        SELECT * FROM unnest(${rows.map((r) => r.legacy_doc_id)}::text[], ${rows.map((r) => Number(r.canonical_id))}::int[])
        ON CONFLICT (legacy_doc_id) DO NOTHING
      `;
      await tx.$executeRaw`
        UPDATE document_vectors dv
        SET "docId" = m.canonical_id::text
        FROM legacy_docid_map m
        WHERE m.legacy_doc_id = dv."docId"
      `;
    });

    done += rows.length;
    await emit("job.progress", { job: "doc-vectors-canonicalize", done, total });
  }

  // Completion assertion: non-numeric docIds left are orphans (no workspace_documents
  // pair — models/documents.js deletes the two tables in separate statements, a crash
  // between them leaves orphans). Reported, never counted as done.
  const [orphans] = await db.$queryRaw`
    SELECT count(*) AS n FROM document_vectors dv
    WHERE dv."docId" !~ '^[0-9]+$'
  `;
  return { done, total, orphanVectors: Number(orphans.n) };
}

module.exports = { run, BATCH, CanonicalizeNotEnabledError };

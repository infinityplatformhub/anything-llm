// T-1 post-migration job (draft) — runs on the P0-6 queue AFTER #5 merges, BEFORE T-5's
// vector-metadata-backfill (single ordered chain; the two jobs never run in parallel).
// Runtime home: server/jobs/docVectorsCanonicalize.js
//
// Rewrites document_vectors.docId (legacy workspace_documents.docId) -> canonical documents.id
// in batches. No rollback once run — legacy_docid_map preserves the mapping for recovery.

const BATCH = 1000;

async function run({ prisma, emit }) {
  // Batch unit = distinct legacy docId (1 doc → N vector rows share it), not vector rows —
  // otherwise progress under-reports and duplicate docIds pile into every claim query.
  const [counts] = await prisma.$queryRaw`
    SELECT count(DISTINCT wd."docId") AS total
    FROM workspace_documents wd
    WHERE wd."documentId" IS NOT NULL
      AND EXISTS (SELECT 1 FROM document_vectors dv WHERE dv."docId" = wd."docId")
  `;
  const total = Number(counts.total);
  let done = 0;
  while (true) {
    // claim a batch of unmapped documents (NOT EXISTS, not NOT IN — the map only grows)
    const rows = await prisma.$queryRaw`
      SELECT DISTINCT wd."docId" AS legacy_doc_id, wd."documentId" AS canonical_id
      FROM workspace_documents wd
      WHERE wd."documentId" IS NOT NULL
        AND EXISTS (SELECT 1 FROM document_vectors dv WHERE dv."docId" = wd."docId")
        AND NOT EXISTS (SELECT 1 FROM legacy_docid_map m WHERE m.legacy_doc_id = wd."docId")
      LIMIT ${BATCH}
    `;
    if (rows.length === 0) break;

    await prisma.$transaction(async (tx) => {
      // audit map first — inside the same transaction as the rewrite (recovery path)
      await tx.$executeRaw`
        INSERT INTO legacy_docid_map (legacy_doc_id, canonical_id)
        VALUES ${prisma.join(rows.map((r) => [r.legacy_doc_id, r.canonical_id]))}
        ON CONFLICT DO NOTHING
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

  // Completion assertion (8b review): every mapped row is numeric-canonical; non-numeric
  // leftovers are orphans (no workspace_documents pair) — reported, never counted as done.
  const [orphans] = await prisma.$queryRaw`
    SELECT count(*) AS n FROM document_vectors dv
    WHERE dv."docId" !~ '^[0-9]+$'
  `;
  return { done, total, orphanVectors: Number(orphans.n) };
}

module.exports = { run, BATCH };
// draft note: legacy_docid_map table ships with this job's migration (id, legacy_doc_id UNIQUE,
// canonical_id, mapped_at timestamptz). Idempotent: re-run skips already-mapped rows via the map.
// G4 gate lives in T-5's capability check, not here — this job only fixes the docId references.

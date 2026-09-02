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

// HISTORY (8b review, 2026-09-02 — RESOLVED, kept for the reasoning): after this job
// rewrites document_vectors.docId to canonical ids, any runtime caller still looking
// vectors up by the legacy uuid silently matches nothing, and a deleted document would
// leave its vectors behind. That is why the job was gated: not because rewriting is
// risky, but because a lookup that matches nothing does not fail, it just quietly finds
// no rows.
//
// The condition is now MET, so this no longer says "MUST NOT run" — see the C-1 block
// below, which is the operative text. T-4b (#29) migrated Documents.removeDocuments and
// DocumentVectors.deleteForWorkspace to match on BOTH ids, and T-6 Phase B (#28) moved all
// eight providers onto DocumentVectors.forDocument, which resolves the legacy uuid and the
// canonical id together. Correct before, during and after the batched run.
//
// T-5 (#30) slice 3 kept this paragraph rather than deleting it: the file previously
// asserted both "MUST NOT run until those call sites migrate" AND (below) "C-1 CLOSED,
// default is now ON". A file that says both is worse than one merely out of date, because
// a reader acts on whichever half they read first.
class CanonicalizeNotEnabledError extends Error {}

// C-1 CLOSED by T-6 Phase B (#28): the seven non-Lance providers now resolve
// vectors through DocumentVectors.forDocument, which matches the legacy uuid AND
// the canonical id, so a delete is correct before, during and after the batched
// run. That was the precondition this flag existed to hold, so the default is now
// ON.
//
// It stays overridable, and the override is the OFF direction:
// ENABLE_DOC_VECTORS_CANONICALIZE=0/false/off refuses to run. An operator who
// finds a call site we missed needs a way to stop the job without a deploy, and
// the value is read rather than merely tested for presence — the old
// `"KEY" in process.env` form made `ENABLE_...=0` mean ENABLED, which is the
// wrong answer to give someone trying to turn it off in a hurry.
const OFF_VALUES = new Set(["0", "false", "off", "no"]);

function canonicalizeEnabled(env = process.env) {
  const raw = env.ENABLE_DOC_VECTORS_CANONICALIZE;
  if (raw === undefined || raw === null || String(raw).trim() === "") return true;
  return !OFF_VALUES.has(String(raw).trim().toLowerCase());
}

async function run({ db = prisma, emit = () => {}, batch = BATCH, enable } = {}) {
  const enabled = enable ?? canonicalizeEnabled();
  if (!enabled) {
    throw new CanonicalizeNotEnabledError(
      "doc-vectors-canonicalize refused: ENABLE_DOC_VECTORS_CANONICALIZE is set to an off value"
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

module.exports = { run, BATCH, CanonicalizeNotEnabledError, canonicalizeEnabled };

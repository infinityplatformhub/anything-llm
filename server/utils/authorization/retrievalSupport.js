// T-5 (#30): tell an operator at BOOT whether their deployment can actually enforce the
// document ACL — and if not, exactly how much data is in the way.
//
// Two separate things can be wrong, and they need different answers:
//
//   1. The vector provider has no ACL pushdown yet (only LanceDB, PGVector and Milvus do).
//      Retrieval refuses rather than serving unfiltered results.
//   2. The provider supports it, but vectors written before T-5 carry no ACL metadata and
//      cannot be proven readable. Those rows are denied unless
//      RETRIEVAL_FILTER_ALLOW_UNPROVABLE is set.
//
// The second one is COUNTED, not guessed. A warning that says "some documents may be
// affected" is noise an operator learns to skip; "4,812 of 5,001 vectors cannot be proven
// readable" is a number they can act on, and it goes to zero when the backfill finishes,
// which is how they know it worked.
//
// This warns; it does NOT refuse to boot. Chat without retrieval, document management and
// admin all still work, and taking the server down for a degraded subsystem turns a
// partial gap into a total one.

const {
  allowUnprovableRows,
} = require("./retrievalEnforcement");

const SUPPORTED_PROVIDERS = Object.freeze(["lancedb", "pgvector", "milvus"]);

/**
 * Count vectors with no ACL metadata, per provider.
 *
 * Returns null when the count cannot be taken (provider unreachable, table absent, a
 * driver with no cheap way to ask). Null means "unknown", and the caller says so rather
 * than reporting a reassuring zero — an unknown count must never read as "all clear".
 */
async function unprovableVectorCount(provider) {
  try {
    if (provider === "pgvector") {
      const { PGVector } = require("../vectorDbProviders/pgvector");
      const instance = new PGVector();
      const connection = await instance.connect();
      try {
        const { rows } = await connection.query(
          `SELECT COUNT(*)::int AS unlabelled, (SELECT COUNT(*)::int FROM "${PGVector.tableName()}") AS total FROM "${PGVector.tableName()}" WHERE metadata->>'orgId' IS NULL`
        );
        return { unlabelled: rows[0].unlabelled, total: rows[0].total };
      } finally {
        await connection.end();
      }
    }

    if (provider === "lancedb") {
      const { LanceDb } = require("../vectorDbProviders/lance");
      const instance = new LanceDb();
      const { client } = await instance.connect();
      let unlabelled = 0;
      let total = 0;
      for (const name of await client.tableNames()) {
        const table = await client.openTable(name);
        total += await table.countRows();
        // LanceDB counts with a predicate rather than scanning rows into the process.
        unlabelled += await table.countRows("orgId IS NULL");
      }
      return { unlabelled, total };
    }

    // Milvus has no cheap count-with-predicate across a JSON member on every version, and
    // guessing is worse than admitting the gap.
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {string} [provider] value of VECTOR_DB; defaults to the same fallback
 *   getVectorDbClass uses, so the report describes what will actually run.
 * @param {Console} [logger]
 */
async function reportRetrievalFilterSupport(
  provider = process.env.VECTOR_DB || "lancedb",
  logger = console
) {
  const normalized = String(provider).toLowerCase();

  if (!SUPPORTED_PROVIDERS.includes(normalized)) {
    logger.warn(
      `\x1b[33m[authorization]\x1b[0m VECTOR_DB="${normalized}" cannot yet push the document ACL filter into its query. ` +
        `Retrieval (chat with context, /v1 vector-search, agent memory) will be REFUSED rather than served unfiltered, ` +
        `because returning unfiltered results would expose documents the requester may not read. ` +
        `Supported today: ${SUPPORTED_PROVIDERS.join(", ")}.`
    );
    return { supported: false, provider: normalized, counts: null };
  }

  const counts = await unprovableVectorCount(normalized);
  if (counts === null) {
    logger.warn(
      `\x1b[33m[authorization]\x1b[0m could not count vectors missing ACL metadata for "${normalized}". ` +
        `If this deployment has documents embedded before the ACL metadata was introduced, they cannot be proven readable and will be excluded from retrieval.`
    );
    return { supported: true, provider: normalized, counts: null };
  }

  if (counts.unlabelled > 0) {
    const allowed = allowUnprovableRows();
    logger.warn(
      `\x1b[33m[authorization]\x1b[0m ${counts.unlabelled} of ${counts.total} vectors have no ACL metadata and cannot be proven readable. ` +
        (allowed
          ? `RETRIEVAL_FILTER_ALLOW_UNPROVABLE is set, so they are included in search results — this is the pre-backfill escape hatch. It weakens the document ACL for exactly those rows, and because they compete for the same result slots, it can also crowd out documents that DO carry metadata. Run the backfill, then remove the variable.`
          : `They are EXCLUDED from search results — searches will return fewer results than expected until they are backfilled. Run the vector metadata backfill, or set RETRIEVAL_FILTER_ALLOW_UNPROVABLE to include them in the meantime (which weakens the document ACL for those rows).`)
    );
  }

  return { supported: true, provider: normalized, counts };
}

module.exports = {
  reportRetrievalFilterSupport,
  unprovableVectorCount,
  SUPPORTED_PROVIDERS,
};

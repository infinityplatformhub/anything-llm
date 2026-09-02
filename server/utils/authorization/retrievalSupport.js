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
 * THREE outcomes, never conflated (Ruling C2):
 *
 *   {unlabelled, total}          a real count
 *   {unsupported: true}          this provider has no cheap way to ask
 *   {error: "<message>"}         the count was attempted and FAILED
 *
 * The previous version returned bare `null` for all three from a `catch {}`, which is how
 * a genuine bug stayed invisible: `countRows("orgId IS NULL")` used a bare identifier,
 * DataFusion threw `No field named orgid`, the catch swallowed it, and LanceDB reported
 * "could not count" on every deployment forever. An operator reading that assumes their
 * driver is old, not that the query is broken.
 *
 * A swallowed error and an unsupported provider read identically to the operator while
 * meaning opposite things: one is "nothing to do here", the other is "something is
 * broken". Reporting them as one value is what let the broken case hide behind the benign
 * one for as long as it did.
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
        const rows = await table.countRows();
        total += rows;

        // A pre-T-5 table has no ACL COLUMNS in its Arrow schema, and a predicate naming a
        // column that is not there throws rather than matching nothing. So the schema is
        // asked first: no columns means every row in that table is unlabelled, which is a
        // fact worth counting rather than an error worth reporting.
        if (!(await instance.hasAclColumns(table))) {
          unlabelled += rows;
          continue;
        }

        // Backticks for the same reason as the read path: an unquoted camelCase
        // identifier is case-folded to `orgid` and throws.
        unlabelled += await table.countRows("`orgId` IS NULL");
      }
      return { unlabelled, total };
    }

    // Milvus has no cheap count-with-predicate across a JSON member on every version, and
    // guessing is worse than admitting the gap. Distinct from an error: nothing is wrong
    // here, the question just cannot be asked cheaply.
    return { unsupported: true };
  } catch (error) {
    // Surfaced with its message rather than flattened to null. The operator can act on
    // "No field named orgid"; they cannot act on silence.
    return { error: error.message };
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

  // A failed count is an ERROR, not a shrug. The message is included because it is the
  // actionable part: "No field named orgid" tells an operator the diagnostic itself is
  // broken, where the old catch-all "could not count" told them to look at their driver.
  if (counts?.error) {
    logger.error(
      `\x1b[31m[authorization]\x1b[0m failed to count vectors missing ACL metadata for "${normalized}": ${counts.error}. ` +
        `This is a fault in the diagnostic, not a statement about your data — retrieval enforcement is unaffected, but this deployment cannot report how many vectors predate the ACL metadata.`
    );
    return { supported: true, provider: normalized, counts };
  }

  // Distinct from the above: nothing is broken, the question just cannot be asked cheaply
  // on this provider.
  if (counts?.unsupported) {
    logger.warn(
      `\x1b[33m[authorization]\x1b[0m cannot count vectors missing ACL metadata on "${normalized}" — this provider offers no cheap way to ask. ` +
        `If this deployment has documents embedded before the ACL metadata was introduced, they cannot be proven readable and will be excluded from retrieval.`
    );
    return { supported: true, provider: normalized, counts };
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

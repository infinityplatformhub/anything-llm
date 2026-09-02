// T-5 (#30): translate a seam-02 DocumentAclFilter into something a provider can push
// down, and enforce the same rules again on the rows that come back.
//
// Lives here rather than in a provider because eight providers must agree on what a filter
// MEANS. If each wrote its own translation, "denied" would drift into eight slightly
// different answers and only the strictest would be right.
//
// The translation is TWO-STEP on purpose (Techlead ruling):
//
//   filter -> RetrievalConstraint (neutral) -> toSqlString() | toStructured()
//
// The neutral middle is what stops the SQL dialect from becoming the interchange format.
// Providers that take an expression string (lance, pgvector, milvus) call toSqlString();
// providers with object filter DSLs (qdrant, pinecone, chroma, weaviate, astra) call
// toStructured(). Neither parses the other's output — a provider parsing a SQL string to
// rebuild an object filter is how a subtly wrong predicate gets written.
//
// Two enforcement layers, deliberately overlapping:
//
//   1. The pushdown. This is the real enforcement: it runs inside the query, before topN,
//      so the actor's own documents compete for the topN slots instead of losing them to
//      rows they may not read (S-17).
//   2. `isRowAllowed` on returned rows. Redundant when the pushdown works, and that is the
//      point: a provider whose predicate is subtly wrong (an unindexed column silently
//      ignored, a dialect quirk) fails closed instead of leaking. It also catches rows
//      written before the ACL backfill, which no predicate can match (S-26/G4).

const { AuthorizationContractError } = require("./errors");
const { allowUnprovableRows } = require("./retrievalEnforcement");

/** SQL string literal escaping — single quotes doubled, the one metacharacter that matters. */
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * A filter must be a filter. Null, `{}`, or a filter with no policy stamp are all refused
 * rather than treated as "no restriction" — an unfiltered read must never be reachable by
 * forgetting an argument.
 */
function assertFilter(aclFilter) {
  if (!aclFilter || typeof aclFilter !== "object") {
    throw new AuthorizationContractError(
      "queryAuthorized requires a DocumentAclFilter — null is never 'no restriction'"
    );
  }
  if (aclFilter.policyVersion === undefined || aclFilter.policyVersion === null) {
    throw new AuthorizationContractError(
      "DocumentAclFilter is missing policyVersion — an unstamped filter cannot be known to describe current policy"
    );
  }
  if (aclFilter.matchNone !== true && aclFilter.orgId === undefined) {
    throw new AuthorizationContractError("DocumentAclFilter is missing orgId");
  }
}

/**
 * The provider-neutral constraint.
 *
 * `matchNone` is a first-class state rather than an unsatisfiable predicate: the caller
 * must skip the query entirely, which is cheaper than issuing one and impossible to get
 * subtly wrong in a dialect that treats `1=0` unusually.
 */
class RetrievalConstraint {
  constructor({ matchNone, orgId, workspaceIds, deniedDocIds, allowedDocIds }) {
    this.matchNone = matchNone;
    this.orgId = orgId;
    /** Empty means "not narrowed by workspace" (an org-wide grant), never "no workspaces". */
    this.workspaceIds = workspaceIds ?? [];
    this.deniedDocIds = deniedDocIds ?? [];
    /** null (not []) means "no explicit allow-list"; [] would mean "allow nothing". */
    this.allowedDocIds = allowedDocIds ?? null;
    Object.freeze(this);
  }

  /**
   * For providers taking an SQL-ish expression string: lance, pgvector, milvus.
   *
   * ALWAYS the strict predicate, in every state. Relaxing it to admit rows with no ACL
   * metadata would let those rows occupy topN slots and push the actor's own documents
   * out of the results — S-17 in reverse, and a silent retrieval-quality loss rather than
   * a visible one. The unprovable-row decision belongs to `isRowAllowed`, after ranking.
   */
  toSqlString() {
    if (this.matchNone) return null;
    const clauses = [`orgId = ${quote(this.orgId)}`];
    if (this.workspaceIds.length > 0) {
      clauses.push(`workspaceId IN (${this.workspaceIds.map(quote).join(", ")})`);
    }
    if (this.deniedDocIds.length > 0) {
      clauses.push(`docId NOT IN (${this.deniedDocIds.map(quote).join(", ")})`);
    }
    if (this.allowedDocIds !== null) {
      clauses.push(`docId IN (${this.allowedDocIds.map(quote).join(", ")})`);
    }
    return clauses.join(" AND ");
  }

  /**
   * For Milvus, whose boolean expressions address JSON fields as `metadata["key"]` and
   * whose set membership operator is `in [...]`.
   *
   * Its own syntax rather than a reuse of toSqlString: Milvus does not accept
   * `col IN (...)` or bare column names for JSON members, and a predicate that fails to
   * parse is a query that either errors or, worse, is silently dropped by a driver that
   * treats an empty expression as "no filter".
   */
  toMilvusExpr(field = "metadata") {
    if (this.matchNone) return null;
    const member = (key) => `${field}["${key}"]`;
    const list = (values) => `[${values.map(quote).join(", ")}]`;

    // Strict in every state, for the same reason as toSqlString.
    const clauses = [`${member("orgId")} == ${quote(this.orgId)}`];
    if (this.workspaceIds.length > 0) {
      clauses.push(`${member("workspaceId")} in ${list(this.workspaceIds)}`);
    }
    if (this.deniedDocIds.length > 0) {
      clauses.push(`not (${member("docId")} in ${list(this.deniedDocIds)})`);
    }
    if (this.allowedDocIds !== null) {
      clauses.push(`${member("docId")} in ${list(this.allowedDocIds)}`);
    }
    return clauses.join(" and ");
  }

  /**
   * For providers issuing real SQL against a JSONB metadata column (pgvector).
   *
   * Returns BOUND PARAMETERS rather than an interpolated string. `toSqlString` escapes
   * quotes and is fine for LanceDB's embedded expression parser, but pgvector hands its
   * predicate to a live PostgreSQL connection — building that by interpolation would put
   * document ids, which originate as user-supplied file data, into executable SQL. There
   * is no reason to accept that risk when the driver already binds parameters.
   *
   * @param {string} column the JSONB column holding vector metadata
   * @param {number} startIndex first free placeholder number ($1, $2, ...)
   * @returns {{sql: string, params: any[]}|null} null when nothing may match
   */
  toJsonbSql(column = "metadata", startIndex = 1) {
    if (this.matchNone) return null;
    const params = [];
    const clauses = [];
    const next = () => `$${startIndex + params.length}`;

    // Strict in every state, for the same reason as toSqlString.
    params.push(String(this.orgId));
    clauses.push(`${column}->>'orgId' = ${next()}`);

    if (this.workspaceIds.length > 0) {
      const placeholder = next();
      params.push(this.workspaceIds);
      clauses.push(`${column}->>'workspaceId' = ANY(${placeholder})`);
    }
    if (this.deniedDocIds.length > 0) {
      const placeholder = next();
      params.push(this.deniedDocIds);
      // A row with no docId cannot be checked against the deny list, so it is refused
      // rather than admitted. `docId IS NULL OR NOT IN (...)` would have been the natural
      // SQL and the wrong answer: it admits exactly the rows whose provenance cannot be
      // established.
      clauses.push(
        `${column}->>'docId' IS NOT NULL AND NOT (${column}->>'docId' = ANY(${placeholder}))`
      );
    }
    if (this.allowedDocIds !== null) {
      const placeholder = next();
      params.push(this.allowedDocIds);
      clauses.push(`${column}->>'docId' = ANY(${placeholder})`);
    }
    return { sql: clauses.join(" AND "), params };
  }

  /**
   * For providers with an object filter DSL: qdrant, pinecone, chroma, weaviate, astra.
   * Returns the conditions in a shape each driver maps to its own syntax — the mapping is
   * the driver's job, the MEANING is decided here.
   */
  toStructured() {
    if (this.matchNone) return null;
    const must = [{ field: "orgId", op: "eq", value: String(this.orgId) }];
    if (this.workspaceIds.length > 0) {
      must.push({ field: "workspaceId", op: "in", value: this.workspaceIds });
    }
    if (this.allowedDocIds !== null) {
      must.push({ field: "docId", op: "in", value: this.allowedDocIds });
    }
    const mustNot =
      this.deniedDocIds.length > 0
        ? [{ field: "docId", op: "in", value: this.deniedDocIds }]
        : [];
    return { must, mustNot };
  }
}

/**
 * Build the neutral constraint from a DocumentAclFilter.
 *
 * An empty result is expressed as `matchNone`, never as an empty clause list — an empty
 * clause list would read as "no restriction", which is the one meaning it must never have.
 */
function constraintFor(aclFilter) {
  assertFilter(aclFilter);
  const none = new RetrievalConstraint({ matchNone: true });
  if (aclFilter.matchNone === true) return none;

  // orgWide is scope on its own: a service principal holding an org-wide grant has no
  // membership rows to enumerate, so an empty workspaceIds is not an empty scope for it.
  // Narrowing to workspaces here would deny it everything.
  let workspaceIds = [];
  if (!aclFilter.orgWide) {
    workspaceIds = (aclFilter.workspaceIds ?? []).map(String);
    if (workspaceIds.length === 0) return none;
  }

  // An explicit allow-list (embed/service actors) is a further narrowing, never a
  // widening — it is ANDed with everything above.
  let allowedDocIds = null;
  if (Array.isArray(aclFilter.allowedDocumentIds)) {
    allowedDocIds = aclFilter.allowedDocumentIds.map(String);
    if (allowedDocIds.length === 0) return none;
  }

  return new RetrievalConstraint({
    matchNone: false,
    orgId: aclFilter.orgId,
    workspaceIds,
    // Deny wins, and it is inlined rather than applied afterwards for the same reason the
    // whole predicate is: a denied document must not occupy a topN slot.
    deniedDocIds: (aclFilter.deniedDocumentIds ?? []).map(String),
    allowedDocIds,
  });
}

/**
 * Re-check one returned row against the same filter.
 *
 * A row that cannot be PROVEN allowed is denied. Missing orgId or workspaceId means the
 * row predates the ACL backfill: there is no way to tell whose document it is, and
 * "unknown" must not read as "yours".
 */
function isRowAllowed(row, aclFilter) {
  if (!row || typeof row !== "object") return false;
  // A positively denied actor is denied in both enforcement states. matchNone is a
  // decision the filter made, not an absence of evidence.
  if (aclFilter.matchNone === true) return false;

  // This is the ONLY place the escape hatch applies, and only to rows carrying no ACL
  // metadata at all — vectors written before T-5. A row that HAS metadata is judged
  // identically whatever the flag says: another org's row, a revoked document and a
  // match-none actor are denied in both states. Absence of evidence, never evidence of
  // denial. See retrievalEnforcement.js.
  const allowUnprovable = allowUnprovableRows();
  const missing = (field) => row[field] === undefined || row[field] === null;

  // A row with no metadata cannot be shown to belong to anyone (S-26/G4).
  const unlabelled =
    missing("orgId") && missing("workspaceId") && missing("docId");
  if (unlabelled) return allowUnprovable;

  // From here the row claims a provenance, so it is held to it in every state.
  if (missing("orgId")) return false;
  if (String(row.orgId) !== String(aclFilter.orgId)) return false;

  if (!aclFilter.orgWide) {
    if (missing("workspaceId")) return false;
    const scope = (aclFilter.workspaceIds ?? []).map(String);
    if (!scope.includes(String(row.workspaceId))) return false;
  }

  const docId = missing("docId") ? null : String(row.docId);
  const denied = (aclFilter.deniedDocumentIds ?? []).map(String);
  // A row with no docId cannot be checked against the deny list. If anything is denied at
  // all, that unverifiable row is refused rather than assumed innocent.
  if (denied.length > 0 && (docId === null || denied.includes(docId))) return false;

  if (Array.isArray(aclFilter.allowedDocumentIds)) {
    const allowed = aclFilter.allowedDocumentIds.map(String);
    if (docId === null || !allowed.includes(docId)) return false;
  }

  return true;
}

module.exports = {
  assertFilter,
  constraintFor,
  isRowAllowed,
  RetrievalConstraint,
};

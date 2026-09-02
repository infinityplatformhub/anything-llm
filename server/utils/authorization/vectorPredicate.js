// T-5 (#30): translate a seam-02 DocumentAclFilter into something a provider can push
// down, and enforce the same rules again on the rows that come back.
//
// Lives here rather than in a provider because eight providers must agree on what a filter
// MEANS. If each wrote its own translation, "denied" would drift into eight slightly
// different answers and only the strictest would be right.
//
// The translation is TWO-STEP on purpose (Techlead ruling):
//
//   filter -> RetrievalConstraint (neutral) -> one renderer PER DIALECT
//
// The neutral middle is what stops any one dialect from becoming the interchange format.
// No renderer parses another's output — a provider parsing a SQL string to rebuild an
// object filter is how a subtly wrong predicate gets written.
//
// ADDING A PROVIDER: write its own renderer here, plus (a) a render test asserting it
// differs between the two RETRIEVAL_FILTER_ALLOW_UNPROVABLE states, and (b) a REAL-STORE
// test that sends the rendered predicate to an actual instance. There is no shared
// "structured" shape to reuse, and that is deliberate: an earlier `toStructured()` promised
// one, but implementing all five dialects proved they disagree about far more than
// spelling, so it was deleted rather than left as a trap for the sixth provider.
//
// (b) is not optional. Three renderers shipped with predicates that read correctly and
// were rejected by the engine — LanceDB needed backticks (bare identifiers throw,
// double quotes silently return zero rows), pgvector had a placeholder off-by-one that
// made every shape unexecutable, and Milvus needed each `not exists` parenthesised or the
// whole escape clause failed to parse. All three passed review. None would have been
// caught without a real store.
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
 * Identifier quoting for LanceDB's DataFusion expression parser: BACKTICKS, never
 * double quotes.
 *
 * Our ACL columns are camelCase (`orgId`, `workspaceId`, `docId`), and DataFusion
 * case-folds an unquoted identifier to lowercase. Measured on lancedb 0.15 against a real
 * table, the three spellings fail in three different ways:
 *
 *   orgId = '1'      -> THROWS: Schema error: No field named orgid
 *   "orgId" = '1'    -> parses, returns 0 rows, ALWAYS
 *   `orgId` = '1'    -> correct
 *
 * The double-quote form is the trap. It is standard SQL, it reads as obviously correct,
 * and it fails closed and SILENT — no error, no rows, permanently. That is a retrieval
 * outage that presents as an embedding or ranking problem and would be debugged as one.
 * The bare form at least announces itself, which is how QA-2 found it: LanceDB is the
 * default provider, so every stock deployment's context-backed chat was throwing.
 *
 * Only this renderer needs it. pgvector addresses the fields as JSONB keys
 * (`metadata->>'orgId'`) and Milvus as JSON members (`metadata["orgId"]`); both are
 * string keys inside a document, not identifiers, so neither is case-folded.
 */
const ident = (name) => `\`${name}\``;

/**
 * The three fields that make a vector's provenance provable, in one place.
 *
 * Every dialect's unlabelled-row escape clause is built from this list, so a renderer
 * cannot quietly check two of them and admit a half-labelled row through the third. The
 * LanceDB provider also reads it to ask whether a table carries these COLUMNS at all — a
 * pre-T-5 table has none, and a predicate naming a column that is not in the Arrow schema
 * throws rather than matching nothing.
 */
const ACL_FIELDS = Object.freeze(["orgId", "workspaceId", "docId"]);

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
   * For LanceDB, which takes an SQL-ish expression string parsed by DataFusion.
   *
   * Every identifier is BACKTICK-quoted (see `ident`): unquoted camelCase is case-folded
   * to `orgid` and throws, and the standard-SQL double-quote form silently returns zero
   * rows forever. pgvector and Milvus are unaffected — they address these fields as keys
   * inside a JSON document, not as identifiers — and have their own renderers below.
   *
   * The strict predicate by default. When RETRIEVAL_FILTER_ALLOW_UNPROVABLE is set, the
   * whole thing is wrapped so that a fully unlabelled row also survives:
   *
   *   ((orgId IS NULL AND workspaceId IS NULL AND docId IS NULL) OR (<strict>))
   *
   * QA correction (Techlead): my first version left the predicate strict in both states
   * and put the escape hatch only in `isRowAllowed`. That made the flag INERT — a legacy
   * row was cut by `orgId = '1'` inside the query and never reached the row check — while
   * the boot report told operators the flag was serving those rows. A flag that does
   * nothing is worse than no flag: it converts "retrieval is broken" into "retrieval is
   * broken and the fix I was told to apply did not help".
   *
   * The escape clause is the CONJUNCTION of all three being absent, not a per-field
   * `IS NULL OR`. Per-field leniency would admit half-labelled rows — a row claiming an
   * orgId but no workspaceId would pass the workspace check by having no workspace, which
   * is a genuine hole rather than a rollout accommodation. All-or-nothing means only the
   * pre-T-5 shape is excused, and `isRowAllowed` applies the same rule to what comes back.
   *
   * Accepted cost until #56 backfills: unlabelled rows compete for topN slots and can push
   * the actor's own documents out. That is a retrieval-quality loss in the flagged state
   * only, and it is the price of the flag working at all.
   */
  toSqlString() {
    if (this.matchNone) return null;
    const clauses = [`${ident("orgId")} = ${quote(this.orgId)}`];
    if (this.workspaceIds.length > 0) {
      clauses.push(
        `${ident("workspaceId")} IN (${this.workspaceIds.map(quote).join(", ")})`
      );
    }
    if (this.deniedDocIds.length > 0) {
      clauses.push(
        `${ident("docId")} NOT IN (${this.deniedDocIds.map(quote).join(", ")})`
      );
    }
    if (this.allowedDocIds !== null) {
      clauses.push(
        `${ident("docId")} IN (${this.allowedDocIds.map(quote).join(", ")})`
      );
    }
    const strict = clauses.join(" AND ");
    if (!allowUnprovableRows()) return strict;
    const unlabelled = ACL_FIELDS
      .map((key) => `${ident(key)} IS NULL`)
      .join(" AND ");
    return `((${unlabelled}) OR (${strict}))`;
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
    const strict = clauses.join(" and ");
    if (!allowUnprovableRows()) return strict;
    // Same all-or-nothing escape as toSqlString; Milvus spells "JSON key absent" as
    // `exists`.
    //
    // Each `not exists` is PARENTHESISED individually, which is not cosmetic. Measured
    // against Milvus 2.3.9:
    //
    //   not exists a and not exists b       -> cannot parse expression:
    //                                          'and' can only be used between boolean
    //                                          expressions
    //   (not exists a) and (not exists b)   -> correct
    //
    // `not` binds tighter than the operand here, so the parser sees `not (exists a and
    // not exists b)` and rejects the shape. Without the parentheses the flagged state
    // errored on every Milvus query while the strict state worked — the flag would have
    // turned retrieval OFF on this provider rather than widening it, and only a
    // deployment that set it would ever have found out.
    //
    // Caught by running the rendered expression through a real Milvus 2.3.9 parser. No
    // amount of reading finds this: the string looks correct and reads correctly.
    const unlabelled = ACL_FIELDS.map(
      (key) => `(not exists ${member(key)})`
    ).join(" and ");
    return `((${unlabelled}) or (${strict}))`;
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

    // ONE way to allocate a placeholder: push the value, then return the number it landed
    // on. Nothing else may touch `params`.
    //
    // The previous version had a `next()` that read `params.length` WITHOUT pushing, and
    // call sites disagreed about the order — orgId pushed then called it, everything else
    // called it then pushed. So orgId got `$2`, workspaceId got `$2` as well, and `$1` was
    // never referenced by anything. Postgres rejected every shape:
    // `could not determine data type of parameter $1`, or an array bound where a scalar
    // was expected. pgvector's queryAuthorized could not run at all.
    //
    // Off-by-one in placeholder numbering is not a typo class you can review your way out
    // of — the two orderings look identical at a glance and only differ at runtime. Making
    // reserve-and-push atomic removes the ordering question rather than answering it.
    const bind = (value) => {
      params.push(value);
      return `$${startIndex + params.length - 1}`;
    };

    // Strict in every state, for the same reason as toSqlString.
    clauses.push(`${column}->>'orgId' = ${bind(String(this.orgId))}`);

    if (this.workspaceIds.length > 0) {
      clauses.push(
        `${column}->>'workspaceId' = ANY(${bind(this.workspaceIds)})`
      );
    }
    if (this.deniedDocIds.length > 0) {
      // A row with no docId cannot be checked against the deny list, so it is refused
      // rather than admitted. `docId IS NULL OR NOT IN (...)` would have been the natural
      // SQL and the wrong answer: it admits exactly the rows whose provenance cannot be
      // established.
      clauses.push(
        `${column}->>'docId' IS NOT NULL AND NOT (${column}->>'docId' = ANY(${bind(this.deniedDocIds)}))`
      );
    }
    if (this.allowedDocIds !== null) {
      clauses.push(`${column}->>'docId' = ANY(${bind(this.allowedDocIds)})`);
    }
    const strict = clauses.join(" AND ");
    if (!allowUnprovableRows()) return { sql: strict, params };
    // Same all-or-nothing escape as toSqlString. No new parameters: the escape clause is
    // three IS NULL checks, so the caller's placeholder numbering is unaffected.
    const unlabelled = ACL_FIELDS
      .map((key) => `${column}->>'${key}' IS NULL`)
      .join(" AND ");
    return { sql: `((${unlabelled}) OR (${strict}))`, params };
  }

  // ---------------------------------------------------------------------------
  // Slice 1b: the five object-DSL dialects.
  //
  // Each renders the same neutral constraint into one driver's syntax. They are separate
  // methods rather than a generic mapper because the dialects disagree about more than
  // spelling — Qdrant nests must/must_not, Pinecone uses Mongo-ish operators, Chroma
  // requires an explicit $and above one clause, Weaviate wants a GraphQL operator tree,
  // Astra is Mongo-like but flat. A "generic" mapper would either be a lowest common
  // denominator (weaker than every dialect can express) or a pile of conditionals.
  //
  // All five share one rule the tests assert as a table: null means SKIP THE QUERY. A
  // dialect returning an empty filter object instead would issue an unrestricted search,
  // which is the single most dangerous mistake available in this file.
  // ---------------------------------------------------------------------------

  /** Qdrant: `{must: [...], must_not: [...]}` with `match: {value}` / `match: {any}`. */
  toQdrantFilter() {
    if (this.matchNone) return null;
    const must = [{ key: "orgId", match: { value: String(this.orgId) } }];
    if (this.workspaceIds.length > 0) {
      must.push({ key: "workspaceId", match: { any: this.workspaceIds } });
    }
    if (this.allowedDocIds !== null) {
      must.push({ key: "docId", match: { any: this.allowedDocIds } });
    }
    const filter = { must };
    if (this.deniedDocIds.length > 0) {
      filter.must_not = [{ key: "docId", match: { any: this.deniedDocIds } }];
    }
    if (!allowUnprovableRows()) return filter;
    // The same all-or-nothing escape as every other dialect, expressed with Qdrant's
    // `should` (OR) at the top level: either the point carries no ACL payload at all, or
    // it satisfies the strict filter. `is_null` is Qdrant's own condition for it.
    //
    // Nested under `should` rather than added as another `must`, because a flag that only
    // narrowed would be inert — which is exactly the bug slice 1a was failed for.
    return {
      should: [
        {
          must: ACL_FIELDS.map((key) => ({ is_null: { key } })),
        },
        filter,
      ],
    };
  }

  /** Pinecone: a Mongo-ish metadata filter — `$eq`, `$in`, `$nin`. */
  toPineconeFilter() {
    if (this.matchNone) return null;
    const filter = { orgId: { $eq: String(this.orgId) } };
    if (this.workspaceIds.length > 0) {
      filter.workspaceId = { $in: this.workspaceIds };
    }
    // Both docId clauses can apply at once, so they merge into one object rather than the
    // second overwriting the first — an allow-list that silently dropped the deny-list
    // would re-admit a revoked document.
    const docId = {};
    if (this.allowedDocIds !== null) docId.$in = this.allowedDocIds;
    if (this.deniedDocIds.length > 0) docId.$nin = this.deniedDocIds;
    if (Object.keys(docId).length > 0) filter.docId = docId;
    if (!allowUnprovableRows()) return filter;
    // The all-or-nothing escape, as a top-level `$or`. Pinecone spells "this key is
    // absent" as `$exists: false`, so the unlabelled branch is the conjunction of all
    // three being absent — never a per-field relaxation that would admit half-labelled
    // rows.
    return {
      $or: [
        { $and: ACL_FIELDS.map((key) => ({ [key]: { $exists: false } })) },
        filter,
      ],
    };
  }

  /**
   * Chroma: `where` clauses, with `$and` required as soon as there is more than one.
   *
   * THE ONE DIALECT WITH NO ESCAPE CLAUSE. Chroma's operator set is closed —
   * `$gt $gte $lt $lte $ne $eq $in $nin` — with no `$exists`, so "this key is absent"
   * cannot be expressed at all. Chroma therefore renders the SAME predicate whether
   * RETRIEVAL_FILTER_ALLOW_UNPROVABLE is set or not, and pre-T-5 vectors stay excluded
   * until the backfill (#56) gives them metadata.
   *
   * That is deliberate and it is ANNOUNCED, in `retrievalSupport.js`: a Chroma deployment
   * that sets the flag gets a boot-time error saying the flag cannot take effect here.
   * Making it silently inert is precisely the bug slice 1a was failed for twice — the
   * operator sets their one documented lever, nothing changes, and nothing tells them why.
   *
   * The sentinel alternative (write `""` instead of leaving fields absent, then match on
   * it) was rejected: every pre-T-5 row would have to be rewritten for the sentinel to
   * exist, which IS the backfill. It would solve a problem it created rather than the one
   * in front of us.
   */
  toChromaWhere() {
    if (this.matchNone) return null;
    const clauses = [{ orgId: { $eq: String(this.orgId) } }];
    if (this.workspaceIds.length > 0) {
      clauses.push({ workspaceId: { $in: this.workspaceIds } });
    }
    if (this.allowedDocIds !== null) {
      clauses.push({ docId: { $in: this.allowedDocIds } });
    }
    if (this.deniedDocIds.length > 0) {
      clauses.push({ docId: { $nin: this.deniedDocIds } });
    }
    return clauses.length === 1 ? clauses[0] : { $and: clauses };
  }

  /**
   * Weaviate: a GraphQL `where` operator tree; `And` of `Equal` / `ContainsAny` paths.
   *
   * Weaviate's operator set is a CLOSED enum:
   *
   *   And Or Equal Like NotEqual GreaterThan GreaterThanEqual LessThan LessThanEqual
   *   WithinGeoRange IsNull ContainsAny ContainsAll
   *
   * Two consequences drive the shape below, and both are the opposite of what I first
   * assumed when writing this renderer:
   *
   *   1. There is NO `Not`. An earlier version of this emitted `operator: "Not"` around a
   *      ContainsAny for the deny-list — not a valid operator, so the deny-list would have
   *      failed or been dropped. A deny-list that is dropped re-admits revoked documents,
   *      which is the worst direction for this particular bug to fail in. It is now an
   *      `And` of one `NotEqual` per denied id, which the enum does support.
   *   2. There IS `IsNull`, so unlike Chroma this dialect CAN express the escape clause.
   */
  toWeaviateWhere() {
    if (this.matchNone) return null;
    const operands = [
      {
        path: ["orgId"],
        operator: "Equal",
        valueText: String(this.orgId),
      },
    ];
    if (this.workspaceIds.length > 0) {
      operands.push({
        path: ["workspaceId"],
        operator: "ContainsAny",
        valueTextArray: this.workspaceIds,
      });
    }
    if (this.allowedDocIds !== null) {
      operands.push({
        path: ["docId"],
        operator: "ContainsAny",
        valueTextArray: this.allowedDocIds,
      });
    }
    if (this.deniedDocIds.length > 0) {
      // No `Not` and no NOT-IN in the enum, so "none of these" is spelled as the
      // conjunction of individual NotEqual clauses. Linear in the deny-list, which is
      // acceptable: a deny-list is a revocation set, not a catalogue.
      operands.push(
        ...this.deniedDocIds.map((id) => ({
          path: ["docId"],
          operator: "NotEqual",
          valueText: id,
        }))
      );
    }
    const strict =
      operands.length === 1 ? operands[0] : { operator: "And", operands };
    if (!allowUnprovableRows()) return strict;
    // All-or-nothing escape, using the one operator that can express absence here.
    return {
      operator: "Or",
      operands: [
        {
          operator: "And",
          operands: ACL_FIELDS.map((key) => ({
            path: [key],
            operator: "IsNull",
            valueBoolean: true,
          })),
        },
        strict,
      ],
    };
  }

  /** Astra: Mongo-like, addressing the stored metadata sub-document. */
  toAstraFilter() {
    if (this.matchNone) return null;
    const filter = { "metadata.orgId": String(this.orgId) };
    if (this.workspaceIds.length > 0) {
      filter["metadata.workspaceId"] = { $in: this.workspaceIds };
    }
    // Merged for the same reason as Pinecone: both docId constraints can apply.
    const docId = {};
    if (this.allowedDocIds !== null) docId.$in = this.allowedDocIds;
    if (this.deniedDocIds.length > 0) docId.$nin = this.deniedDocIds;
    if (Object.keys(docId).length > 0) filter["metadata.docId"] = docId;
    if (!allowUnprovableRows()) return filter;
    // All-or-nothing escape. Astra's Data API is Mongo-shaped, so absence is `$exists:
    // false` on the dotted metadata path — the same path the strict clauses address, so a
    // field renamed on one side cannot silently diverge from the other.
    return {
      $or: [
        {
          $and: ACL_FIELDS.map((key) => ({
            [`metadata.${key}`]: { $exists: false },
          })),
        },
        filter,
      ],
    };
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
  ACL_FIELDS,
};

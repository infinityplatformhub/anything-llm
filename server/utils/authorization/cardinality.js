// T-5 (#30) slice 3 — S-25 (G2): cardinality must not exceed the actor's scope.
//
// A count is a small number, which is why this reads as minor and is not. Three endpoints
// reported vector counts with no scope check at all: `?slug=` counted any workspace, a
// missing slug counted the whole instance, and `/v1/system/vector-count` returned the
// instance total to any key. A number is enough to answer "does this workspace hold
// anything I am not allowed to see" — and that is the question the ACL exists to refuse.
//
// Three rules, each learned somewhere else in this issue:
//
//   1. SCOPE IS CHECKED BEFORE THE STORE IS TOUCHED. Not only because it is cheaper: if the
//      refusal path runs a vector-store query and the not-found path does not, the two are
//      distinguishable by TIMING even when their bodies are byte-identical. Both must fail
//      at the same point for the same reason (QA-2 ruling).
//
//   2. OUT-OF-SCOPE READS AS ABSENT, NEVER AS FORBIDDEN. A 403 confirms the workspace
//      exists, which is the oracle wearing a different costume. This returns null and the
//      route answers 404 — the rule `requirePermission` already applies through
//      NON_DISCLOSING.
//
//   3. THE COUNT NEED NOT BE DENY-LIST EXACT (PMO ruling). An exact per-actor number means
//      running the ACL predicate across a whole namespace on a request that only asks "are
//      there any" — expensive on the chat hot path. Scope-level counting closes the real
//      exposure: what matters is not revealing WHICH documents exist. That limit is stated
//      here rather than left for a reader to discover.

/**
 * Max namespaces one count request may query before it refuses.
 *
 * The loop exists because `namespaceCount` is per-namespace across all ten providers, each
 * implementing it differently — a single GROUP BY would need all ten changed, which is
 * wider than this slice. Tracked as #81 (batch namespaceCount); when that lands, this cap
 * can go.
 */
const WORKSPACE_COUNT_CAP = 50;

/**
 * Raised when an actor's scope is too wide to count without fanning out. Named rather than
 * generic so the route can answer 500 with a message an operator can act on, instead of
 * this reading as an unexpected crash.
 */
class CardinalityScopeTooLargeError extends Error {}

/**
 * Count one namespace, or refuse indistinguishably.
 *
 * @param {Object} input
 * @param {Object} input.VectorDb provider instance
 * @param {string} input.slug workspace slug from the request
 * @param {Object} input.aclFilter a DocumentAclFilter — required
 * @param {Function} input.resolveSlug slug -> {id} | null
 * @returns {Promise<number|null>} the count, or null meaning "answer 404"
 */
async function scopedNamespaceCount({ VectorDb, slug, aclFilter, resolveSlug }) {
  // Order matters, per rule 1. Every refusal below happens before the vector store is
  // consulted, so "not yours", "not there" and "match-none" all cost the same lookup and
  // return at the same point.
  if (!aclFilter || typeof aclFilter !== "object") {
    throw new Error(
      "scopedNamespaceCount requires a DocumentAclFilter — an unscoped count reports cardinality beyond the actor's reach"
    );
  }
  if (aclFilter.matchNone === true) return null;

  const workspace = await resolveSlug(slug);
  if (!workspace) return null;

  if (aclFilter.orgWide !== true) {
    const scope = new Set((aclFilter.workspaceIds ?? []).map(String));
    if (!scope.has(String(workspace.id))) return null;
  }

  return VectorDb.namespaceCount(slug);
}

/**
 * The total this actor is entitled to see.
 *
 * An org-wide actor gets the instance total; anyone else gets the sum over their own
 * workspaces. Returning `totalVectors()` to a bound key would tell a single-workspace
 * principal how much data the whole instance holds — #67 A+B, restated for counts.
 *
 * @param {Object} input
 * @param {Object} input.VectorDb provider instance
 * @param {Object} input.aclFilter a DocumentAclFilter — required
 * @param {Function} input.countFor workspaceId -> Promise<number>
 * @returns {Promise<number>}
 */
async function scopedTotalVectors({ VectorDb, aclFilter, countFor }) {
  if (!aclFilter || typeof aclFilter !== "object") {
    throw new Error(
      "scopedTotalVectors requires a DocumentAclFilter — an unscoped total reports the whole instance"
    );
  }
  // Zero rather than null: the caller asked for a number and is entitled to one. "You may
  // see nothing" is a true answer; it is refusing to say what exists elsewhere.
  if (aclFilter.matchNone === true) return { vectorCount: 0 };
  if (aclFilter.orgWide === true)
    return { vectorCount: await VectorDb.totalVectors() };

  // `workspaceIds` is ALREADY ceiling(creator) ∩ binding(key): buildDocumentFilter runs
  // narrowToKeyBinding, and a binding can only narrow. So a key bound to a workspace its
  // creator holds no grant for intersects to nothing and totals 0 — no separate check
  // needed here, and adding one would be a second definition of the same rule.
  const scope = (aclFilter.workspaceIds ?? []).map(String);

  // Amplification cap (PMO ruling). One request must not fan out into unbounded per-
  // namespace queries against the vector store.
  //
  // Over the cap this THROWS rather than returning a truncated number. A `partial: true`
  // key was the first design and was withdrawn for a good reason: the response shape must
  // not vary, because a shape that changes with who is asking is itself a signal about the
  // caller. And a silently-truncated count is worse than an error — it is a wrong number
  // that looks exactly like a right one, which is the failure mode this whole issue is
  // about. The route answers 500; an operator with a scope this wide needs to know the
  // endpoint cannot serve them, not a plausible-looking undercount.
  if (scope.length > WORKSPACE_COUNT_CAP) {
    throw new CardinalityScopeTooLargeError(
      `workspace scope too large to count (${scope.length} > ${WORKSPACE_COUNT_CAP})`
    );
  }

  const counts = await Promise.all(scope.map((id) => countFor(id)));
  return {
    vectorCount: counts.reduce((sum, n) => sum + (Number(n) || 0), 0),
  };
}

/**
 * The vector-search response body — ONE shape for every outcome.
 *
 * The bug this closes is not in the data, it is in the shape of the refusal. The route used
 * to early-return `{results: [], message: "No embeddings found for this workspace."}` when
 * `namespaceCount === 0`, while an ACL-filtered search that matched nothing returned
 * `{results: []}`. So a caller could distinguish "this workspace has content you may not
 * read" from "this workspace is empty" — an existence oracle over workspace content, the
 * same class as #32's mint oracle.
 *
 * No `message` key in any case, so the two bodies are byte-identical rather than merely
 * similar. Comparing parsed fields would let a stray key through; the assertion is on the
 * serialized body for that reason.
 */
function buildVectorSearchResponse({ sources = [] } = {}) {
  return {
    results: sources.map((source) => ({
      id: source.id,
      text: source.text,
      metadata: {
        url: source.url,
        title: source.title,
        author: source.docAuthor,
        description: source.description,
        docSource: source.docSource,
        chunkSource: source.chunkSource,
        published: source.published,
        wordCount: source.wordCount,
        tokenCount: source.token_count_estimate,
      },
      // `_distance`, matching the route this was extracted from. Writing `score` here
      // instead would have been a silent behaviour change smuggled in under a security
      // fix — the field is undefined on providers that do not set it, and callers read it.
      distance: source._distance,
      score: source.score,
    })),
  };
}

module.exports = {
  scopedNamespaceCount,
  scopedTotalVectors,
  buildVectorSearchResponse,
  CardinalityScopeTooLargeError,
  WORKSPACE_COUNT_CAP,
};

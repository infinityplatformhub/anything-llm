// T-5 (#30): the one way a retrieval call site gets its DocumentAclFilter.
//
// Eight call sites need a filter, and every one of them holds a `user` (or nothing, for
// embeds and agents) rather than a seam-02 Actor. Left to themselves they would each
// invent the conversion, and eight conversions means eight chances for one to be subtly
// more generous than the rest — which is how a leak that passes every test gets written.
//
// So this is deliberately the only door: resolve the actor, build (or reuse) the filter,
// hand back something `queryAuthorized` accepts. A caller that cannot produce an actor
// gets a match-none filter, never a null — "no actor" must read as "reads nothing", not as
// "unrestricted".

const { buildDocumentFilter } = require("./documentFilter");
const { resolveActorRef } = require("./actorResolver");
const {
  filterCache,
  registerAuthorizationCacheSubscriber,
} = require("./cacheSubscriber");

/**
 * Build the retrieval filter for a chat/search request.
 *
 * The cache subscriber is registered lazily here rather than only at boot: a FilterCache
 * serving entries with nothing invalidating them is the one failure mode that looks
 * healthy, so the wiring that makes the cache correct is attached to the wiring that makes
 * it used. If the bus is unavailable the cache disables itself and every call rebuilds.
 *
 * @param {Object} input
 * @param {Object|null} input.user the request's user, when there is one
 * @param {Object|null} [input.actor] a seam-02 Actor, when the caller already resolved one
 * @param {string} [input.action] "document.read" | "document.search"
 * @param {string[]} [input.allowedDocumentIds] explicit narrowing, embed/service only
 * @returns {Promise<Object>} a DocumentAclFilter — never null
 */
async function retrievalFilterFor({
  user = null,
  actor = null,
  actorRef = null,
  action = "document.search",
  allowedDocumentIds,
  db,
}) {
  await registerAuthorizationCacheSubscriber();

  // A user is not an Actor, and this file does NOT build one: T-2 makes actorResolver the
  // only place a seam-02 Actor is constructed (actorResolver.js:1-2), so an Actor literal
  // here would be a second, quietly divergent definition of identity.
  //
  // Three ways in, one construction site. A caller either already holds an Actor, or hands
  // over a principal REFERENCE (an embed uuid, a user id) which resolveActorRef turns into
  // one — deriving membership and tenant from the database rather than from anything the
  // caller passed in.
  const ref = actorRef ?? (user ? { type: "user", id: String(user.id) } : null);
  const resolved = actor ?? (ref ? await resolveActorRef(ref, { db }) : null);

  const input = { actor: resolved, action, db, ...(allowedDocumentIds !== undefined ? { allowedDocumentIds } : {}) };
  return filterCache.get(input, () => buildDocumentFilter(input));
}

/**
 * The bridge every chat/agent retrieval site uses: build the filter, embed the query, run
 * the authorized search.
 *
 * It exists so wiring a call site is a one-line change. The alternative — each site
 * building a filter, embedding, and calling queryAuthorized itself — is nine copies of a
 * three-step sequence, and the failure mode of a copied sequence is that one copy is
 * missing a step and nothing says so.
 *
 * Returns the same `{contextTexts, sources, message}` shape the old
 * `performSimilaritySearch` returned, so callers keep their existing result handling.
 *
 * @param {Object} input
 * @param {Object} input.VectorDb provider instance
 * @param {string} input.namespace
 * @param {string} input.input query text
 * @param {Object} input.LLMConnector
 * @param {Object|null} [input.user] the requesting user, when there is one
 * @param {Object|null} [input.actor] a resolved Actor, when the caller has one
 * @param {string[]} [input.allowedDocumentIds] explicit narrowing (embed/service)
 */
async function authorizedSimilaritySearch({
  VectorDb,
  namespace,
  input,
  LLMConnector,
  user = null,
  actor = null,
  actorRef = null,
  allowedDocumentIds,
  similarityThreshold = 0.25,
  topN = 4,
  filterIdentifiers = [],
  rerank = false,
  query = null,
  db,
}) {
  const aclFilter = await retrievalFilterFor({
    user,
    actor,
    actorRef,
    action: "document.search",
    allowedDocumentIds,
    db,
  });

  // Embedding happens after the filter is built and only when there is something to
  // search: an actor with no scope should not pay for an embedding call, and a failure to
  // build the filter must not be preceded by work that looks like a successful query.
  if (aclFilter.matchNone === true) {
    return { contextTexts: [], sources: [], message: null };
  }

  const queryVector = await LLMConnector.embedTextInput(input);
  const { contextTexts, sourceDocuments } = await VectorDb.queryAuthorized({
    namespace,
    queryVector,
    aclFilter,
    similarityThreshold,
    topN,
    filterIdentifiers,
    rerank,
    query,
  });

  const sources = sourceDocuments.map((metadata, i) => ({
    metadata: { ...metadata, text: contextTexts[i] },
  }));
  return {
    contextTexts,
    sources: VectorDb.curateSources(sources),
    message: false,
  };
}

module.exports = { retrievalFilterFor, authorizedSimilaritySearch };

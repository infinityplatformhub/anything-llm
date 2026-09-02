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
  workspace = null,
  action = "document.search",
  allowedDocumentIds,
  db,
}) {
  await registerAuthorizationCacheSubscriber();

  // A user is not an Actor, and this file does NOT build one: T-2 makes actorResolver the
  // only place a seam-02 Actor is constructed (actorResolver.js:1-2), so an Actor literal
  // here would be a second, quietly divergent definition of identity. resolveActorRef is
  // that file's sanctioned entry point for "I have a principal reference, give me the
  // Actor", and it derives membership and tenant from the database rather than from
  // anything a caller passed in.
  const resolved =
    actor ??
    (user ? await resolveActorRef({ type: "user", id: String(user.id) }, { db }) : null);

  const input = { actor: resolved, action, db, ...(allowedDocumentIds !== undefined ? { allowedDocumentIds } : {}) };
  return filterCache.get(input, () => buildDocumentFilter(input));
}

module.exports = { retrievalFilterFor };

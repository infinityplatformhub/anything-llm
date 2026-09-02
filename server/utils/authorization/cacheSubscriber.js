// T-5 (#30): the `policy.changed` subscriber that keeps FilterCache honest.
//
// T-3 built the cache and left this as its DoD, restated in the T-5 recon as a same-change
// requirement rather than a follow-up — and that sequencing matters. A FilterCache wired
// into retrieval with nothing invalidating it serves a revoked grant for up to its TTL.
// Thirty seconds of reading a document you were just cut off from is not a caching
// artifact; it is the authorization failure the seam exists to prevent.
//
// The version stamp in each filter is a backstop, not a substitute: consulting it costs a
// database round trip per query, which is the cost the cache exists to avoid. Event-driven
// invalidation is what makes the fast path correct rather than merely fast.

const { eventBus } = require("../events");
const { FilterCache } = require("./cache");

/** Process-wide cache for retrieval filters. */
const filterCache = new FilterCache();

// Registration happens from more than one place (boot, and lazily from the first
// retrieval), and two handlers would invalidate twice per event — harmless in itself, but
// it would mask a genuine double-registration bug somewhere else.
let registration = null;

/**
 * Subscribe `cache` to policy.changed on `bus`.
 *
 * On failure the cache is DISABLED rather than left running. A cache with no invalidation
 * is the dangerous shape: it looks healthy, and every entry serves until its TTL with no
 * way to be corrected. Disabling costs a rebuild per query and is always correct.
 *
 * @param {{bus?: Object, cache?: FilterCache}} [input]
 */
async function registerAuthorizationCacheSubscriber({
  bus = eventBus,
  cache = filterCache,
} = {}) {
  if (registration) return registration;

  registration = (async () => {
    try {
      await bus.subscribe({
        subscriberId: "authorization-cache",
        eventTypes: ["policy.changed"],
        handler: async (event) => {
          const scopeKeys = event?.data?.scopeKeys;
          // A malformed event has an unknown blast radius, so the safe reading is
          // "everything changed". The cost is a rebuild; the cost of the other default is
          // serving policy that no longer exists.
          if (!Array.isArray(scopeKeys) || scopeKeys.length === 0) {
            cache.invalidateAll();
            return;
          }
          cache.invalidateScopes(scopeKeys);
        },
      });
      cache.enable();
      return true;
    } catch (error) {
      cache.disable(`event bus unavailable: ${error.message}`);
      // Cleared so a later attempt can retry rather than inheriting this failure forever.
      registration = null;
      return false;
    }
  })();

  return registration;
}

/** Test seam: forget the current registration so a suite can register again. */
function resetAuthorizationCacheSubscriber() {
  registration = null;
}

module.exports = {
  filterCache,
  registerAuthorizationCacheSubscriber,
  resetAuthorizationCacheSubscriber,
};

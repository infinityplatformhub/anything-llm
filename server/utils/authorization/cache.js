// T-3 (#22): FilterCache — caches built DocumentAclFilters.
//
// Staleness is "a newer policy_versions row exists", never a TTL (recon §2). The TTL
// below is a memory bound only; correctness comes from the version stamp and from
// policy.changed invalidation. If the bus subscription is down the cache disables
// itself and every call rebuilds — stale is never served.

const prisma = require("../prisma");
const { currentPolicyVersion } = require("./policyRepository");

const DEFAULT_TTL_MS = 30_000;

const keyFor = ({ actor, action }) =>
  [
    actor?.type ?? "none",
    actor ? String(actor.id) : "none",
    action,
    actor?.orgId ?? 1,
    [...(actor?.workspaceIds ?? [])].map(String).sort().join(","),
  ].join("|");

// Scope keys an entry depends on, matched against policy.changed payloads.
const scopesFor = ({ actor }) => {
  const scopes = new Set([`org:${actor?.orgId ?? 1}`]);
  for (const id of actor?.workspaceIds ?? []) scopes.add(`workspace:${id}`);
  return scopes;
};

class FilterCache {
  constructor({ ttlMs = DEFAULT_TTL_MS, db = prisma } = {}) {
    this.ttlMs = ttlMs;
    this.db = db;
    this.entries = new Map();
    this.enabled = true;
    this.disabledReason = null;
  }

  /** Disable on bus failure — fail open on freshness, never on authorization. */
  disable(reason) {
    this.enabled = false;
    this.disabledReason = reason;
    this.entries.clear();
  }

  enable() {
    this.enabled = true;
    this.disabledReason = null;
  }

  /** Drop every entry whose scope keys intersect the changed scopes. */
  invalidateScopes(scopeKeys = []) {
    const changed = new Set(scopeKeys);
    for (const [key, entry] of this.entries) {
      for (const scope of entry.scopes) {
        if (changed.has(scope)) {
          this.entries.delete(key);
          break;
        }
      }
    }
  }

  invalidateAll() {
    this.entries.clear();
  }

  /**
   * @param {{actor: Object|null, action: string, db?: Object}} input
   * @param {() => Promise<Object>} build builds the filter on a miss
   */
  async get(input, build) {
    if (!this.enabled) return build();

    const key = keyFor(input);
    const entry = this.entries.get(key);
    const head = await currentPolicyVersion(input.db ?? this.db);

    const fresh =
      entry &&
      entry.policyVersion === head &&
      Date.now() - entry.storedAt < this.ttlMs;
    if (fresh) return entry.filter;

    const filter = await build();
    this.entries.set(key, {
      filter,
      policyVersion: filter.policyVersion,
      storedAt: Date.now(),
      scopes: scopesFor(input),
    });
    return filter;
  }

  /** A filter is stale once any newer policy version exists. */
  async isStale(filter, db = this.db) {
    const head = await currentPolicyVersion(db);
    return filter.policyVersion !== head;
  }

  get size() {
    return this.entries.size;
  }
}

module.exports = { FilterCache, DEFAULT_TTL_MS };

// T-5 (#30) PR-1 — the `policy.changed` subscriber that keeps FilterCache honest.
//
// T-3's DoD, restated in the T-5 recon as a same-change requirement rather than a
// follow-up: wiring FilterCache into retrieval without this subscriber means a revoked
// grant stays live until the 30s TTL expires. Thirty seconds of reading a document you
// were just cut off from is not a caching artifact, it is the authorization failure the
// whole seam exists to prevent.
//
// The version stamp is a backstop, not a substitute: checking it costs a database round
// trip per query, which is exactly what the cache exists to avoid. Invalidation is what
// makes the fast path correct.
//
// RED on approof/main eda1214b: no subscriber exists, so nothing invalidates the cache.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();

const { FilterCache } = require("../../../utils/authorization/cache");

describe("T-5: policy.changed invalidates exactly the affected cache scopes", () => {
  let registerAuthorizationCacheSubscriber;
  let resetAuthorizationCacheSubscriber;
  beforeAll(() => {
    ({
      registerAuthorizationCacheSubscriber,
      resetAuthorizationCacheSubscriber,
    } = require("../../../utils/authorization/cacheSubscriber"));
  });
  // Registration is process-wide by design (one subscriber per process), so each case
  // clears it — otherwise every test after the first reuses the first one's bus.
  beforeEach(() => resetAuthorizationCacheSubscriber());

  const fakeBus = () => {
    const subscribers = [];
    return {
      subscribers,
      subscribe: jest.fn(async ({ handler, eventTypes, subscriberId }) => {
        subscribers.push({ handler, eventTypes, subscriberId });
        return true;
      }),
      emit: async (event) => {
        for (const sub of subscribers) await sub.handler(event);
      },
    };
  };

  const cacheWith = (entries) => {
    const cache = new FilterCache();
    for (const [key, scopes] of entries) {
      cache.entries.set(key, {
        filter: { policyVersion: "1" },
        policyVersion: "1",
        storedAt: Date.now(),
        scopes: new Set(scopes),
      });
    }
    return cache;
  };

  test("an entry whose scope changed is dropped", async () => {
    const cache = cacheWith([["user|5|document.read", ["org:1", "workspace:3"]]]);
    const bus = fakeBus();
    await registerAuthorizationCacheSubscriber({ bus, cache });

    await bus.emit({
      type: "policy.changed",
      data: { changeType: "acl", version: "2", scopeKeys: ["workspace:3"] },
    });

    expect(cache.size).toBe(0);
  });

  test("an unrelated entry survives — invalidation is scoped, not a flush", async () => {
    // A workspace-level revoke must not evict every other tenant's filters; that would
    // turn one policy edit into a system-wide cache stampede.
    const cache = cacheWith([
      ["user|5|document.read", ["org:1", "workspace:3"]],
      ["user|9|document.read", ["org:1", "workspace:8"]],
    ]);
    const bus = fakeBus();
    await registerAuthorizationCacheSubscriber({ bus, cache });

    await bus.emit({
      type: "policy.changed",
      data: { changeType: "acl", version: "2", scopeKeys: ["workspace:3"] },
    });

    expect(cache.size).toBe(1);
    expect(cache.entries.has("user|9|document.read")).toBe(true);
  });

  test("an org-level change drops every entry in that org", async () => {
    const cache = cacheWith([
      ["user|5|document.read", ["org:1", "workspace:3"]],
      ["user|9|document.read", ["org:1", "workspace:8"]],
    ]);
    const bus = fakeBus();
    await registerAuthorizationCacheSubscriber({ bus, cache });

    await bus.emit({
      type: "policy.changed",
      data: { changeType: "role", version: "2", scopeKeys: ["org:1"] },
    });

    expect(cache.size).toBe(0);
  });

  test("several scope keys in one event are all honoured", async () => {
    // bumpVersion sends `[scopeKey, ...extraScopeKeys]`; dropping the tail would leave
    // exactly the entries a multi-scope change was meant to clear.
    const cache = cacheWith([
      ["a", ["workspace:3"]],
      ["b", ["workspace:8"]],
      ["c", ["workspace:99"]],
    ]);
    const bus = fakeBus();
    await registerAuthorizationCacheSubscriber({ bus, cache });

    await bus.emit({
      type: "policy.changed",
      data: { version: "2", scopeKeys: ["workspace:3", "workspace:8"] },
    });

    expect(cache.size).toBe(1);
    expect(cache.entries.has("c")).toBe(true);
  });

  test("an event with no scopeKeys clears everything rather than nothing", async () => {
    // Fail closed on a malformed event: an unknown blast radius means the safe assumption
    // is "everything", and the cost is a rebuild, not a leak.
    const cache = cacheWith([
      ["a", ["workspace:3"]],
      ["b", ["workspace:8"]],
    ]);
    const bus = fakeBus();
    await registerAuthorizationCacheSubscriber({ bus, cache });

    await bus.emit({ type: "policy.changed", data: { version: "2" } });

    expect(cache.size).toBe(0);
  });

  test("the subscriber asks only for policy.changed", async () => {
    const bus = fakeBus();
    await registerAuthorizationCacheSubscriber({ bus, cache: new FilterCache() });

    expect(bus.subscribe).toHaveBeenCalledTimes(1);
    expect(bus.subscribe.mock.calls[0][0].eventTypes).toEqual(["policy.changed"]);
  });
});

describe("T-5: if the bus is unavailable the cache disables itself", () => {
  let registerAuthorizationCacheSubscriber;
  let resetAuthorizationCacheSubscriber;
  beforeAll(() => {
    ({
      registerAuthorizationCacheSubscriber,
      resetAuthorizationCacheSubscriber,
    } = require("../../../utils/authorization/cacheSubscriber"));
  });
  beforeEach(() => resetAuthorizationCacheSubscriber());

  test("a failed subscription disables the cache instead of leaving it live", async () => {
    // The dangerous shape: a cache with no invalidation looks like it is working. Every
    // entry then serves up to its TTL with no way to be corrected, so a revoke is
    // invisible for 30 seconds. Disabling costs a rebuild per query and is always correct.
    const cache = new FilterCache();
    const bus = {
      subscribe: jest.fn().mockRejectedValue(new Error("bus down")),
    };

    await registerAuthorizationCacheSubscriber({ bus, cache });

    expect(cache.enabled).toBe(false);
    expect(cache.disabledReason).toMatch(/bus/i);
  });

  test("a disabled cache rebuilds on every call rather than serving a stale filter", async () => {
    const cache = new FilterCache();
    const bus = { subscribe: jest.fn().mockRejectedValue(new Error("bus down")) };
    await registerAuthorizationCacheSubscriber({ bus, cache });

    const build = jest.fn().mockResolvedValue({ policyVersion: "7", matchNone: false });
    await cache.get({ actor: { type: "user", id: "5", orgId: 1 }, action: "document.read" }, build);
    await cache.get({ actor: { type: "user", id: "5", orgId: 1 }, action: "document.read" }, build);

    expect(build).toHaveBeenCalledTimes(2);
  });

  test("registration is idempotent — a second call does not double-subscribe", async () => {
    // Boot paths and lazy callers both register; two handlers would invalidate twice per
    // event, which is harmless but hides a real double-registration bug elsewhere.
    const cache = new FilterCache();
    const subscribe = jest.fn().mockResolvedValue(true);
    const bus = { subscribe };

    await registerAuthorizationCacheSubscriber({ bus, cache });
    await registerAuthorizationCacheSubscriber({ bus, cache });

    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});

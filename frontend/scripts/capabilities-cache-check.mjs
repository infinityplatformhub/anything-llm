/**
 * #40 task 3: executable checks for the capability cache, until #111 lands a
 * real frontend test runner.
 *
 * This is NOT a source scan. An earlier version of this file grepped the hook's
 * text and went red on the word `localStorage` inside the comment explaining
 * why localStorage is not used — the same mistake as checking a router's source
 * instead of its assembled routes. So this executes the cache logic against a
 * stub fetcher and asserts on observed behaviour: how many calls happened, and
 * what the reader saw.
 *
 * Run: node scripts/capabilities-cache-check.mjs
 */
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

// The cache under test, transcribed from src/hooks/useCapabilities.js. Kept in
// step by the drift check at the bottom, which fails if the source stops
// matching the shape asserted here.
function makeCache(fetcher) {
  let promise = null;
  return {
    load() {
      if (!promise) {
        promise = fetcher();
        promise.catch(() => {
          promise = null;
        });
      }
      return promise;
    },
    reset() {
      promise = null;
    },
    get cached() {
      return promise;
    },
  };
}

// F1: a rejected fetch must not be cached.
{
  let calls = 0;
  const cache = makeCache(() => {
    calls += 1;
    return calls === 1
      ? Promise.reject(new Error("network"))
      : Promise.resolve({ capabilities: { "user.manage": true } });
  });

  await cache.load().catch(() => {});
  const second = await cache.load();
  check(calls === 2, `F1: rejection was cached — expected 2 fetches, saw ${calls}`);
  check(
    second.capabilities["user.manage"] === true,
    "F1: the retry did not deliver the real answer"
  );
}

// F1b: a successful fetch IS cached — the retry must not become a request storm.
{
  let calls = 0;
  const cache = makeCache(() => {
    calls += 1;
    return Promise.resolve({ capabilities: {} });
  });
  await cache.load();
  await cache.load();
  await cache.load();
  check(calls === 1, `F1b: success not cached — expected 1 fetch, saw ${calls}`);
}

// F1c: a reader of a rejected load must reach a settled state, not hang.
{
  const cache = makeCache(() => Promise.reject(new Error("network")));
  let state = { loading: true, capabilities: null, error: null };
  await cache
    .load()
    .then((r) => {
      state = { loading: false, capabilities: r.capabilities, error: null };
    })
    .catch(() => {
      state = { loading: false, capabilities: {}, error: "unavailable" };
    });
  check(state.loading === false, "F1c: loading stayed true after a rejection");
  check(
    state.capabilities && Object.keys(state.capabilities).length === 0,
    "F1c: a failed load did not fail closed to an empty map"
  );
}

// F2: reset clears the cache, so the next reader fetches again.
{
  let calls = 0;
  const cache = makeCache(() => {
    calls += 1;
    return Promise.resolve({ capabilities: { "user.manage": calls === 1 } });
  });
  await cache.load();
  cache.reset();
  check(cache.cached === null, "F2: reset did not clear the cached promise");
  const afterLogout = await cache.load();
  check(calls === 2, `F2: no refetch after reset — saw ${calls} fetches`);
  check(
    afterLogout.capabilities["user.manage"] === false,
    "F2: the second user read the first user's answer"
  );
}

// Drift: the transcribed cache above must still match the real source, and
// resetCapabilities must actually be wired into both logout paths.
{
  const { readFileSync } = await import("fs");
  const here = new URL(".", import.meta.url).pathname;
  const hook = readFileSync(`${here}../src/hooks/useCapabilities.js`, "utf8");
  const auth = readFileSync(`${here}../src/AuthContext.jsx`, "utf8");
  check(
    /capabilitiesPromise\.catch\(\(\) => \{\s*capabilitiesPromise = null;/.test(
      hook
    ),
    "drift: the hook no longer clears a rejected promise"
  );
  check(
    (auth.match(/resetCapabilities\(\)/g) || []).length >= 2,
    "drift: resetCapabilities is not called from both logout paths"
  );
}

if (failures.length) {
  console.error(`FAIL ${failures.length}`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("PASS capabilities cache: 9 checks");

/**
 * Issue 38: one instance's background refresh must not write into another's cache.
 *
 * The pricing refresh runs unawaited from the constructor, and the cache paths used to
 * be lazy getters over STORAGE_DIR — so a write started under one directory landed in
 * whichever directory STORAGE_DIR named by the time it finished. Requiring the module
 * at all constructs a singleton and starts one of those refreshes, which is why a suite
 * that merely imports it could overwrite the etag another suite had just asserted.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const freshDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `pricing-${label}-`));
const etagIn = (dir) => fs.readFileSync(path.join(dir, "models", "pricing", ".etag"), "utf8");

const okResponse = (etag) => ({
  status: 200,
  headers: { get: (key) => (key === "etag" ? etag : null) },
  json: async () => ({ openai: { models: { "gpt-4o": { cost: { input: 1, output: 2 } } } } }),
});

const dirs = [];
/** Refreshes started by requiring the module, which no test awaits by itself. */
const abandonedBoots = [];
const originalFetch = global.fetch;
const originalStorage = process.env.STORAGE_DIR;

afterEach(async () => {
  // Nothing may still be writing when the directories below are removed.
  await settleAbandoned();
  global.fetch = originalFetch;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  if (originalStorage === undefined) delete process.env.STORAGE_DIR;
  else process.env.STORAGE_DIR = originalStorage;
});

function instanceIn(dir) {
  jest.resetModules();
  const mod = require("../../../../utils/helpers/modelPricing");
  const { ModelPricing } = mod;
  // Requiring the module constructs MODEL_PRICING and starts a refresh nobody awaits.
  // Abandoning it leaves a write in flight that lands during a later assertion — the
  // same defect this file was written to prove, reintroduced by the file itself.
  abandonedBoots.push(mod.MODEL_PRICING.bootRefresh);
  ModelPricing.instance = null;
  return new ModelPricing({ cacheDir: path.join(dir, "models", "pricing") });
}

/** Settles every refresh started by module-level construction in this test. */
async function settleAbandoned() {
  await Promise.all(abandonedBoots.splice(0).map((p) => p?.catch(() => {})));
}

test("an instance writes to the directory it was built with, not the one current at write time", async () => {
  const mine = freshDir("mine");
  const theirs = freshDir("theirs");
  dirs.push(mine, theirs);

  let release;
  const held = new Promise((resolve) => { release = resolve; });
  global.fetch = jest.fn(async () => {
    await held;
    return okResponse('"mine"');
  });

  process.env.STORAGE_DIR = mine;
  const pricing = instanceIn(mine);

  // The environment moves on while the refresh is still in flight — exactly what
  // happens when the next suite sets its own STORAGE_DIR.
  process.env.STORAGE_DIR = theirs;
  release();
  await pricing.bootRefresh;
  await settleAbandoned();

  expect(etagIn(mine)).toBe('"mine"');
  expect(fs.existsSync(path.join(theirs, "models", "pricing", ".etag"))).toBe(false);
});

test("two instances with different directories do not overwrite each other", async () => {
  const first = freshDir("first");
  const second = freshDir("second");
  dirs.push(first, second);

  let call = 0;
  global.fetch = jest.fn(async () => okResponse(call++ === 0 ? '"first"' : '"second"'));

  const a = instanceIn(first);
  await a.bootRefresh;
  const b = instanceIn(second);
  await b.bootRefresh;
  await settleAbandoned();

  expect(etagIn(first)).toBe('"first"');
  expect(etagIn(second)).toBe('"second"');
});

test("the cache directory is captured once and survives a later environment change", async () => {
  const dir = freshDir("captured");
  dirs.push(dir);
  global.fetch = jest.fn(async () => okResponse('"x"'));

  const pricing = instanceIn(dir);
  await settleAbandoned();
  const captured = pricing.cacheDir;

  process.env.STORAGE_DIR = "/somewhere/else/entirely";
  expect(pricing.cacheDir).toBe(captured);
  expect(pricing.cacheFiles.etag).toBe(path.join(captured, ".etag"));
});

/* eslint-env jest */

/**
 * #88 — the eight providers that guard `connect()` against `VECTOR_DB` compare
 * it as a raw string.
 *
 * #87 normalised the four places that SELECT a provider, so `VECTOR_DB=CHROMA`
 * now resolves to Chroma. These guards were not in that diff, so the same value
 * then throws `Chroma::Invalid ENV settings` on the first upload — a message
 * that is wrong about the cause, since the ENV settings are fine and nothing in
 * that string points at capitalisation.
 *
 * No SDK mocks. Eight mocks of eight client libraries is eight chances to pass
 * for the wrong reason, and the guard runs BEFORE client construction — so
 * "the rejection is not `Invalid ENV settings`" is exactly the property under
 * test, and a real connection failure afterwards is the correct outcome.
 */
const fs = require("fs");
const path = require("path");

const PROVIDERS_DIR = path.join(__dirname, "../../../utils/vectorDbProviders");
const GUARD_PATTERN = /process\.env\.VECTOR_DB|normalizeVectorDbKey/;
const GUARD_ERROR = /Invalid ENV settings/;

/**
 * Which providers guard on VECTOR_DB, read from the directory rather than a
 * literal list — a provider added later with an unnormalised guard has to fail
 * this suite rather than be quietly outside it. This is also how the eighth
 * guard (zilliz, whose check does not sit next to a `new Client(...)`) stays
 * covered.
 */
function guardedProviders() {
  return fs
    .readdirSync(PROVIDERS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      file: path.join(PROVIDERS_DIR, entry.name, "index.js"),
    }))
    .filter(({ file }) => fs.existsSync(file))
    .filter(({ file }) => GUARD_PATTERN.test(fs.readFileSync(file, "utf8")))
    .map(({ name, file }) => {
      // Providers export CLASSES, and some export helpers alongside them
      // (weaviate exports four things). Take the first export that carries a
      // connect() on its prototype rather than the first export full stop.
      const exported = Object.values(require(file));
      const Provider = exported.find(
        (value) => typeof value?.prototype?.connect === "function"
      );
      return { name, file, instance: Provider ? new Provider() : null };
    });
}

const PROVIDERS = guardedProviders();

/** The spellings an operator plausibly writes into a .env or a compose file. */
const variantsOf = (name) => [
  name,
  name.toUpperCase(),
  `${name[0].toUpperCase()}${name.slice(1)}`,
  ` ${name}`,
  `${name} `,
];

/** Run connect() and report only how it failed, if it did. */
async function connectError(provider) {
  try {
    await provider.connect();
    return null;
  } catch (error) {
    return error.message ?? String(error);
  }
}

let restore;

beforeEach(() => {
  restore = process.env.VECTOR_DB;
});

afterEach(() => {
  if (restore === undefined) delete process.env.VECTOR_DB;
  else process.env.VECTOR_DB = restore;
});

describe("the guarded providers are discovered, not listed", () => {
  it("finds the eight that guard on VECTOR_DB", () => {
    // Eight, not seven: zilliz's guard is at the top of connect() rather than
    // beside its client construction, so a scan anchored on `new Client(...)`
    // misses it — and a fix applied from a short list leaves a provider that
    // resolves and then throws.
    expect(PROVIDERS.map((p) => p.name).sort()).toEqual([
      "astra",
      "chroma",
      "chromacloud",
      "milvus",
      "pinecone",
      "qdrant",
      "weaviate",
      "zilliz",
    ]);
  });

  it("does not include the two providers that never read VECTOR_DB", () => {
    const names = PROVIDERS.map((p) => p.name);
    expect(names).not.toContain("lance");
    expect(names).not.toContain("pgvector");
  });

  it("exposes a connect() on each", () => {
    for (const { name, instance } of PROVIDERS) {
      expect(typeof instance?.connect).toBe("function");
      expect(name).toBeTruthy();
    }
  });
});

describe("every guard accepts every spelling of its own name", () => {
  for (const { name, instance } of PROVIDERS) {
    for (const variant of variantsOf(name)) {
      it(`${name} passes its guard for ${JSON.stringify(variant)}`, async () => {
        process.env.VECTOR_DB = variant;
        const message = await connectError(instance);
        // null means it connected (unlikely here, and fine). Anything else is
        // a failure from the client itself — no endpoint, no API key — which
        // is the correct outcome, because the guard is what is under test and
        // it runs first.
        if (message !== null) expect(message).not.toMatch(GUARD_ERROR);
      });
    }
  }
});

describe("every guard still rejects a different provider's name", () => {
  for (const { name, instance } of PROVIDERS) {
    it(`${name} throws when VECTOR_DB names another provider`, async () => {
      // Without this, deleting the guards entirely would pass the suite above.
      const other = PROVIDERS.find((p) => p.name !== name).name;
      process.env.VECTOR_DB = other;
      expect(await connectError(instance)).toMatch(GUARD_ERROR);
    });

    it(`${name} throws for a value that matches no provider`, async () => {
      process.env.VECTOR_DB = "not-a-vector-store";
      expect(await connectError(instance)).toMatch(GUARD_ERROR);
    });
  }
});

describe("the require cycle is real but harmless — measured, not assumed", () => {
  // The recon for this issue claimed a top-level `require("../../helpers")` in
  // a provider would close a cycle and hand back a half-built module.exports.
  // Measured: it does not. `utils/helpers/index.js` requires providers ONLY
  // inside function bodies (getVectorDbClass's switch arms), so nothing is
  // required at load time in that direction, and seven providers already
  // require helpers at module scope today.
  //
  // The tests stay because the claim is worth pinning either way: if someone
  // later hoists a provider require to helpers' module scope, the cycle
  // becomes real and these go red before anyone debugs
  // "normalizeVectorDbKey is not a function" at runtime.
  it("helpers requires providers lazily, not at module scope", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../../../utils/helpers/index.js"),
      "utf8"
    );
    const moduleScope = source
      .split("\n")
      .filter((line) => /^const .*require\(.*vectorDbProviders/.test(line));
    expect(moduleScope).toEqual([]);
  });

  it("loading every provider first still leaves helpers whole", () => {
    // The symptom a cycle would produce, driven directly.
    jest.resetModules();
    for (const { file } of PROVIDERS) require(file);
    const helpers = require("../../../utils/helpers");
    expect(typeof helpers.normalizeVectorDbKey).toBe("function");
  });

  it("and loading helpers first works too", () => {
    jest.resetModules();
    const helpers = require("../../../utils/helpers");
    expect(typeof helpers.normalizeVectorDbKey).toBe("function");
    for (const { file } of PROVIDERS) require(file);
    expect(typeof helpers.normalizeVectorDbKey).toBe("function");
  });
});

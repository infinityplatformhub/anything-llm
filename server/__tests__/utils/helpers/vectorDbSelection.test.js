/* eslint-env jest */

/**
 * #87 — VECTOR_DB is compared as a raw string, so any spelling that is not
 * exactly one of the ten lower-case names silently resolves to LanceDB.
 *
 * The failure is quiet by construction: the server starts, nothing throws, and
 * the operator's vectors go somewhere they did not choose. It shows up later as
 * documents that are not where they should be.
 *
 * These tests pin three things: every provider resolves from any reasonable
 * spelling; an unrecognised value still falls back but says so honestly; and
 * every OTHER place that compares a VECTOR_DB value uses the same normaliser —
 * which is the part a fix applied in one place misses.
 */
const path = require("path");

const HELPERS = path.join(__dirname, "../../../utils/helpers");

const PROVIDERS = [
  ["pinecone", "PineconeDB"],
  ["chroma", "Chroma"],
  ["chromacloud", "ChromaCloud"],
  ["lancedb", "LanceDb"],
  ["weaviate", "Weaviate"],
  ["qdrant", "QDrant"],
  ["milvus", "Milvus"],
  ["zilliz", "Zilliz"],
  ["astra", "AstraDB"],
  ["pgvector", "PGVector"],
];

/** The spellings an operator plausibly types into a .env or a compose file. */
const variantsOf = (name) => [
  name,
  name.toUpperCase(),
  `${name[0].toUpperCase()}${name.slice(1)}`,
  ` ${name}`,
  `${name} `,
  `  ${name}  `,
];

let helpers;
let restoreVectorDb;

beforeAll(() => {
  restoreVectorDb = process.env.VECTOR_DB;
  helpers = require(HELPERS);
});

afterAll(() => {
  if (restoreVectorDb === undefined) delete process.env.VECTOR_DB;
  else process.env.VECTOR_DB = restoreVectorDb;
});

describe("the normaliser is exported, so every comparison can share it", () => {
  it("exists", () => {
    // Exported rather than private: the defect is not that one comparison is
    // wrong, it is that FOUR places compare this value and only one of them
    // can be fixed from inside getVectorDbClass.
    expect(typeof helpers.normalizeVectorDbKey).toBe("function");
  });

  it("lower-cases and trims", () => {
    expect(helpers.normalizeVectorDbKey("  PGVector ")).toBe("pgvector");
  });

  it("maps a missing value to the documented default", () => {
    // `?? "lancedb"` in the original: an unset VECTOR_DB is not an error, it is
    // the default install.
    expect(helpers.normalizeVectorDbKey(undefined)).toBe("lancedb");
    expect(helpers.normalizeVectorDbKey(null)).toBe("lancedb");
  });

  it("leaves an empty or whitespace-only value as the default too", () => {
    // A key set to nothing at all is the same situation as unset, and must not
    // become the empty string — which would match no case and take the unknown
    // path, logging an error about a machine that is merely using the default.
    expect(helpers.normalizeVectorDbKey("")).toBe("lancedb");
    expect(helpers.normalizeVectorDbKey("   ")).toBe("lancedb");
  });

  it("returns an unrecognised value unchanged, so the caller can name it", () => {
    // Not mapped to "lancedb" here: the fallback decision belongs to the
    // caller, and the log has to be able to quote what the operator wrote.
    expect(helpers.normalizeVectorDbKey("Chorma")).toBe("chorma");
  });
});

describe("getVectorDbClass resolves every provider from any spelling", () => {
  for (const [name, className] of PROVIDERS) {
    it(`resolves ${name}`, () => {
      for (const variant of variantsOf(name)) {
        expect(helpers.getVectorDbClass(variant).constructor.name).toBe(
          className
        );
      }
    });
  }

  it("reads VECTOR_DB when given no argument", () => {
    process.env.VECTOR_DB = "PGVECTOR";
    try {
      expect(helpers.getVectorDbClass().constructor.name).toBe("PGVector");
    } finally {
      delete process.env.VECTOR_DB;
    }
  });

  it("uses LanceDB when VECTOR_DB is unset", () => {
    delete process.env.VECTOR_DB;
    expect(helpers.getVectorDbClass().constructor.name).toBe("LanceDb");
  });
});

describe("an unrecognised value falls back, and says why", () => {
  let logged;
  let spy;

  beforeEach(() => {
    logged = [];
    spy = jest
      .spyOn(console, "error")
      .mockImplementation((...args) => logged.push(args.join(" ")));
    helpers.__resetVectorDbWarning();
  });

  afterEach(() => spy.mockRestore());

  it("still returns LanceDB (ruling ข: no throw in this issue)", () => {
    // getVectorDbClass runs on upload, on chat, and on workspace delete.
    // Turning the fallback into a throw would convert a wrong-storage bug into
    // an outage for every instance already running on an accidental LanceDB.
    expect(helpers.getVectorDbClass("Chorma").constructor.name).toBe("LanceDb");
  });

  it("names the value it did not recognise", () => {
    // The old message said "No VECTOR_DB value found in environment!", which is
    // wrong about the cause: the value was found, it just did not match. An
    // operator grepping for their own typo found a message saying nothing was
    // set.
    helpers.getVectorDbClass("Chorma");
    // Quoted as normalised, which is what dispatch actually saw — the operator
    // can still find their typo, and the message does not imply a case
    // distinction that the resolver no longer makes.
    expect(logged.join("\n").toLowerCase()).toContain("chorma");
  });

  it("lists what it would have accepted", () => {
    helpers.getVectorDbClass("Chorma");
    const output = logged.join("\n");
    for (const [name] of PROVIDERS) expect(output).toContain(name);
  });

  it("says which provider it is using instead", () => {
    helpers.getVectorDbClass("Chorma");
    expect(logged.join("\n")).toMatch(/lancedb/i);
  });

  it("does not claim the variable is unset", () => {
    helpers.getVectorDbClass("Chorma");
    expect(logged.join("\n")).not.toMatch(/No VECTOR_DB value found/);
  });

  it("logs once, not on every call", () => {
    // This runs on every document upload and every chat. A per-call log buries
    // the rest of the operator's output and teaches them to ignore it.
    for (let i = 0; i < 5; i += 1) helpers.getVectorDbClass("Chorma");
    expect(logged).toHaveLength(1);
  });

  it("warns again when a DIFFERENT unrecognised value appears", () => {
    // Deduplicating by message rather than by "have we warned at all": two
    // different typos are two different problems, and the second must not be
    // swallowed by the first.
    helpers.getVectorDbClass("Chorma");
    helpers.getVectorDbClass("wevaite");
    expect(logged).toHaveLength(2);
    expect(logged.join("\n")).toContain("wevaite");
  });

  it("says nothing at all for a recognised value", () => {
    for (const [name] of PROVIDERS) helpers.getVectorDbClass(name.toUpperCase());
    expect(logged).toEqual([]);
  });
});

describe("every other comparison of a VECTOR_DB value uses the normaliser", () => {
  it("supportedVectorDB accepts exactly what the resolver accepts", () => {
    // Two validators disagreeing about one field is how `.env` came to accept
    // spellings the settings UI rejects. Same normaliser, same answer.
    const { supportedVectorDB } = require("../../../utils/helpers/updateENV");
    for (const [name] of PROVIDERS) {
      for (const variant of variantsOf(name)) {
        expect(supportedVectorDB(variant)).toBeNull();
      }
    }
    expect(supportedVectorDB("Chorma")).toMatch(/Invalid VectorDB type/);
  });

  it("the doctor's spelling gate stops failing a spelling that now works", () => {
    // O2a (#74) added config.vector_db precisely because `PGVECTOR` reached
    // LanceDB. Once the resolver normalises, that spelling WORKS — so the gate
    // must stop failing it, or the installer blocks a configuration the app
    // itself honours. The check that was right last week is wrong this week,
    // and it is this issue's job to retire it.
    const doctor = require("../../../utils/doctor");
    expect(doctor.requiredExtensions("PGVECTOR")).toEqual([
      "pg_trgm",
      "vector",
    ]);
    expect(doctor.CHECK_IDS).not.toContain("config.vector_db");
  });

  it("resetAllVectorStores picks the pgvector reset path for any spelling", async () => {
    // utils/vectorStore/resetAllVectorStores.js compares vectorDbKey itself to
    // decide between reset() and per-namespace deletion. Normalising inside
    // getVectorDbClass alone gives the RIGHT provider with the WRONG reset
    // strategy — pgvector would get its embedding table left in place with a
    // dimension it can no longer change.
    const source = require("fs").readFileSync(
      path.join(__dirname, "../../../utils/vectorStore/resetAllVectorStores.js"),
      "utf8"
    );
    // Behavioural coverage needs a live pgvector store; what is checkable here
    // is that the comparison is not a bare === against the raw key.
    expect(source).not.toMatch(/vectorDbKey === ["']pgvector["']/);
    expect(source).toMatch(/normalizeVectorDbKey/);
  });
});

/**
 * Harness wiring test for the Thai retrieval eval (issue 44, V1-c).
 *
 * This is NOT the quality gate. The gate is `yarn eval:thai`, which embeds the
 * frozen corpus with the real model and is far too slow for the unit suite.
 * What this file proves is that the wiring underneath that gate is real: the
 * corpus loads, the product's own TextSplitter runs on it, the span-containment
 * rule is applied, and the metric arithmetic is right. A deterministic mock
 * embedder keeps it offline and stable.
 */
const path = require("path");
const {
  scoreCorpus,
  loadCorpus,
  chunkCorpus,
  findSplitSpans,
} = require("../../../utils/eval/retrievalHarness");
const { MockEmbedder } = require("../../../utils/eval/mockEmbedder");
const { TextSplitter } = require("../../../utils/TextSplitter");

const CORPUS_DIR = path.resolve(__dirname, "../../eval/thai/corpus");
const PAIRS = require("../../eval/thai/pairs.json");

const EXPECTED_BUCKETS = [
  "formal",
  "mixed-script",
  "transliteration",
  "lexically-distant",
];

// Same settings the runner uses, so what this test measures is what the gate
// measures. A test on different chunk settings proves nothing about the gate.
const splitter = () => new TextSplitter({ chunkSize: 500, chunkOverlap: 50 });

describe("Thai eval corpus", () => {
  it("holds at least forty pairs across all four buckets", () => {
    expect(PAIRS.length).toBeGreaterThanOrEqual(40);
    const buckets = new Set(PAIRS.map((pair) => pair.bucket));
    for (const name of EXPECTED_BUCKETS) expect(buckets.has(name)).toBe(true);
  });

  it("gives every pair a unique id and the fields the harness reads", () => {
    const ids = new Set();
    for (const pair of PAIRS) {
      expect(typeof pair.id).toBe("string");
      expect(ids.has(pair.id)).toBe(false);
      ids.add(pair.id);
      expect(typeof pair.question).toBe("string");
      expect(pair.question.length).toBeGreaterThan(0);
      expect(typeof pair.answerSpan).toBe("string");
      expect(pair.answerSpan.length).toBeGreaterThan(0);
      expect(EXPECTED_BUCKETS).toContain(pair.bucket);
    }
  });

  it("quotes every answer span verbatim from the document it names", () => {
    const documents = new Map(
      loadCorpus(CORPUS_DIR).map((doc) => [doc.docId, doc.text])
    );
    for (const pair of PAIRS) {
      expect(documents.has(pair.doc)).toBe(true);
      expect(documents.get(pair.doc)).toContain(pair.answerSpan);
    }
  });
});

describe("Thai chunk boundaries", () => {
  it("never splits a gold answer span across two chunks", async () => {
    const chunks = await chunkCorpus(loadCorpus(CORPUS_DIR), splitter());
    const split = findSplitSpans(chunks, PAIRS);
    expect(split.map((entry) => entry.pairId)).toEqual([]);
  });

  it("reports a split span when the splitter cuts mid-answer", () => {
    const pair = PAIRS[0];
    const half = pair.answerSpan.slice(
      0,
      Math.floor(pair.answerSpan.length / 2)
    );
    const shredded = [{ docId: pair.doc, text: half }];
    expect(findSplitSpans(shredded, [pair])).toEqual([
      { pairId: pair.id, docId: pair.doc, span: pair.answerSpan },
    ]);
  });
});

describe("scoreCorpus", () => {
  let results;

  beforeAll(async () => {
    results = await scoreCorpus({
      corpusDir: CORPUS_DIR,
      pairs: PAIRS,
      embedder: new MockEmbedder(),
      splitter: splitter(),
      topK: 5,
    });
  }, 60000);

  it("returns overall metrics, per-bucket metrics, and a miss list", () => {
    expect(results.pairs).toBe(PAIRS.length);
    expect(results.chunkCount).toBeGreaterThan(PAIRS.length);
    for (const metric of ["recallAt1", "recallAt5", "mrr"]) {
      expect(typeof results[metric]).toBe("number");
      expect(results[metric]).toBeGreaterThanOrEqual(0);
      expect(results[metric]).toBeLessThanOrEqual(1);
    }
    expect(results.recallAt5).toBeGreaterThanOrEqual(results.recallAt1);
    expect(Object.keys(results.perBucket).sort()).toEqual(
      [...EXPECTED_BUCKETS].sort()
    );
    for (const bucket of Object.values(results.perBucket)) {
      expect(bucket.pairs).toBeGreaterThan(0);
      expect(bucket.recallAt5).toBeGreaterThanOrEqual(bucket.recallAt1);
    }
    const perBucketPairs = Object.values(results.perBucket).reduce(
      (sum, bucket) => sum + bucket.pairs,
      0
    );
    expect(perBucketPairs).toBe(PAIRS.length);
    expect(Array.isArray(results.misses)).toBe(true);
    expect(results.misses.length).toBe(
      PAIRS.length - Math.round(results.recallAt5 * PAIRS.length)
    );
    expect(Array.isArray(results.splitSpans)).toBe(true);
  });

  it("names the bucket and the expected document on every miss", () => {
    for (const miss of results.misses) {
      expect(EXPECTED_BUCKETS).toContain(miss.bucket);
      expect(PAIRS.some((pair) => pair.id === miss.pairId)).toBe(true);
      expect(typeof miss.expectedDoc).toBe("string");
      expect(typeof miss.spanWasSplit).toBe("boolean");
    }
  });

  it("rejects a pair naming a document the corpus does not have", async () => {
    await expect(
      scoreCorpus({
        corpusDir: CORPUS_DIR,
        pairs: [{ ...PAIRS[0], doc: "no-such-document" }],
        embedder: new MockEmbedder(),
        splitter: splitter(),
      })
    ).rejects.toThrow("no-such-document");
  });
});

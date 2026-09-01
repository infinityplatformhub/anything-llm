#!/usr/bin/env node
/**
 * Thai retrieval eval runner (issue 44, V1-c). Run with `yarn eval:thai`.
 *
 * Deliberately NOT a jest test. Its failure means "retrieval quality regressed",
 * which is a different audience and a different cadence from "the build is
 * broken" - and it embeds the whole corpus with a real model, which is far too
 * slow for the unit suite. `server/__tests__/utils/eval/retrievalHarness.test.js`
 * covers the harness itself with a mock embedder, fast, inside `yarn test`.
 *
 * Environment:
 *   EVAL_EMBEDDER=native|mock   default native. `mock` is for testing this
 *                               script, not for measuring anything.
 *   EVAL_TOP_K=5                k for recall@k
 *   EVAL_RECALL5_THRESHOLD=...  override the gate threshold
 */
const path = require("path");
const { scoreCorpus } = require("../utils/eval/retrievalHarness");
const { TextSplitter } = require("../utils/TextSplitter");

/**
 * Gate threshold for recall@5.
 *
 * UNSET until a baseline exists. Recon section 5 item 4: the threshold is set
 * FROM a measured baseline, never guessed ahead of it, because a threshold
 * picked first becomes a number later work is tuned to satisfy. Running with no
 * threshold reports the metrics and exits 0; that first run IS the baseline.
 *
 * To set it: run `yarn eval:thai` against `Xenova/all-MiniLM-L6-v2` on the
 * current splitter, write the recall@5 it produces into the issue, then put a
 * value here with the date and the run that produced it.
 *
 * @type {number|null}
 */
const RECALL_AT_5_THRESHOLD = null;

const CORPUS_DIR = path.resolve(__dirname, "../__tests__/eval/thai/corpus");
const PAIRS_FILE = path.resolve(__dirname, "../__tests__/eval/thai/pairs.json");

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function printTable(results) {
  const rows = [
    ["overall", results.pairs, results.recallAt1, results.recallAt5, results.mrr],
    ...Object.entries(results.perBucket).map(([name, bucket]) => [
      name,
      bucket.pairs,
      bucket.recallAt1,
      bucket.recallAt5,
      bucket.mrr,
    ]),
  ];
  const width = Math.max(...rows.map(([name]) => name.length), 8);
  console.log(
    `${"bucket".padEnd(width)}  pairs  recall@1  recall@5     MRR`
  );
  for (const [name, pairs, at1, at5, mrr] of rows)
    console.log(
      `${name.padEnd(width)}  ${String(pairs).padStart(5)}  ` +
        `${percent(at1).padStart(8)}  ${percent(at5).padStart(8)}  ${mrr.toFixed(3).padStart(6)}`
    );
}

async function buildEmbedder() {
  const choice = process.env.EVAL_EMBEDDER ?? "native";
  if (choice === "mock") {
    const { MockEmbedder } = require("../utils/eval/mockEmbedder");
    return { embedder: new MockEmbedder(), label: "mock (harness self-test)" };
  }
  if (choice !== "native")
    throw new Error(`Unknown EVAL_EMBEDDER: ${choice}. Use native or mock.`);
  const { NativeEmbedder } = require("../utils/EmbeddingEngines/native");
  const embedder = new NativeEmbedder();
  return { embedder, label: embedder.model };
}

async function main() {
  const pairs = require(PAIRS_FILE);
  const topK = Number(process.env.EVAL_TOP_K ?? 5);
  const { embedder, label } = await buildEmbedder();
  const splitter = new TextSplitter({ chunkSize: 500, chunkOverlap: 50 });

  const results = await scoreCorpus({
    corpusDir: CORPUS_DIR,
    pairs,
    embedder,
    splitter,
    topK,
  });

  console.log(`\nThai retrieval eval - embedder: ${label}, top-k: ${topK}`);
  console.log(`chunks: ${results.chunkCount}, pairs: ${results.pairs}\n`);
  printTable(results);

  if (results.splitSpans.length > 0) {
    console.log(
      `\nChunker split ${results.splitSpans.length} gold answer span(s) across chunks.`
    );
    console.log("These are unreachable regardless of embedder quality:");
    for (const entry of results.splitSpans)
      console.log(`  ${entry.pairId} (${entry.docId})`);
  }

  if (results.misses.length > 0) {
    console.log(`\nMisses outside top ${topK}:`);
    for (const miss of results.misses)
      console.log(
        `  ${miss.pairId} [${miss.bucket}] rank=${miss.rank ?? "none"} ` +
          `expected=${miss.expectedDoc} top=${miss.topResult}` +
          `${miss.spanWasSplit ? " (span was split by chunker)" : ""}`
      );
  }

  const threshold = process.env.EVAL_RECALL5_THRESHOLD
    ? Number(process.env.EVAL_RECALL5_THRESHOLD)
    : RECALL_AT_5_THRESHOLD;

  if (threshold === null || Number.isNaN(threshold)) {
    console.log(
      "\nNo recall@5 threshold set. This run is a baseline measurement, not a gate."
    );
    return 0;
  }

  console.log(`\nrecall@5 ${percent(results.recallAt5)} against threshold ${percent(threshold)}`);
  if (results.recallAt5 < threshold) {
    console.log("FAIL - retrieval quality is below the recorded baseline.");
    return 1;
  }
  console.log("PASS");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`Eval failed: ${error.message}`);
    process.exit(1);
  });

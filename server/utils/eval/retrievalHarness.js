/**
 * Thai retrieval eval harness (issue 44, V1-c).
 *
 * Scores a frozen corpus of question -> answer-span pairs by running the SAME
 * chunker the ingestion path uses (`utils/TextSplitter`), embedding the chunks
 * with a real embedder, and ranking by cosine similarity.
 *
 * The point of going through the splitter is that the failure this eval exists
 * to catch lives there: a chunker that cuts mid-word on a script with no spaces
 * shreds the answer span across two chunks, and no embedder recovers from that.
 * A harness that embedded whole passages would score the model and miss it.
 *
 * ponytail: ranking is in-memory cosine rather than a live vector store. The
 * stores compute the same similarity, so chunking and embedding are measured
 * faithfully; index-specific recall loss (quantization, ANN recall) is not.
 * Add a store-backed mode when a provider is suspected of losing recall.
 */
const fs = require("fs");
const path = require("path");

/** A pair is retrieved only when one chunk holds the ENTIRE gold answer span. */
function chunkContainsSpan(chunk, span) {
  return chunk.includes(span);
}

function dotProduct(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function magnitude(vector) {
  return Math.sqrt(dotProduct(vector, vector));
}

function cosineSimilarity(a, b) {
  const denominator = magnitude(a) * magnitude(b);
  if (denominator === 0) return 0;
  return dotProduct(a, b) / denominator;
}

/**
 * Read every .txt document in the corpus directory.
 * @param {string} corpusDir
 * @returns {{docId: string, text: string}[]}
 */
function loadCorpus(corpusDir) {
  const files = fs
    .readdirSync(corpusDir)
    .filter((name) => name.endsWith(".txt"))
    .sort();
  if (files.length === 0)
    throw new Error(`No .txt documents found in corpus dir: ${corpusDir}`);
  return files.map((name) => ({
    docId: path.basename(name, ".txt"),
    text: fs.readFileSync(path.join(corpusDir, name), "utf8"),
  }));
}

/**
 * Split every document with the supplied splitter, keeping the source doc id.
 * @returns {Promise<{docId: string, text: string}[]>}
 */
async function chunkCorpus(documents, splitter) {
  const chunks = [];
  for (const { docId, text } of documents) {
    for (const chunk of await splitter.splitText(text))
      chunks.push({ docId, text: chunk });
  }
  return chunks;
}

/**
 * Every gold span that no single chunk contains in full. This is the chunker's
 * own score, independent of the embedder: a span split across two chunks is
 * unreachable no matter how good the embedding model is.
 * @returns {{pairId: string, docId: string, span: string}[]}
 */
function findSplitSpans(chunks, pairs) {
  const splitSpans = [];
  for (const pair of pairs) {
    const candidates = chunks.filter((chunk) => chunk.docId === pair.doc);
    const intact = candidates.some((chunk) =>
      chunkContainsSpan(chunk.text, pair.answerSpan)
    );
    if (!intact)
      splitSpans.push({
        pairId: pair.id,
        docId: pair.doc,
        span: pair.answerSpan,
      });
  }
  return splitSpans;
}

function emptyBucketTally() {
  return { pairs: 0, hitsAt1: 0, hitsAt5: 0, reciprocalRankSum: 0 };
}

function summarize(tally) {
  if (tally.pairs === 0) return { pairs: 0, recallAt1: 0, recallAt5: 0, mrr: 0 };
  return {
    pairs: tally.pairs,
    recallAt1: tally.hitsAt1 / tally.pairs,
    recallAt5: tally.hitsAt5 / tally.pairs,
    mrr: tally.reciprocalRankSum / tally.pairs,
  };
}

/**
 * Score the corpus.
 *
 * @param {object} options
 * @param {string} options.corpusDir - Directory of .txt documents.
 * @param {Array} options.pairs - [{id, bucket, question, doc, answerSpan}]
 * @param {{embedTextInput: Function, embedChunks: Function}} options.embedder
 * @param {{splitText: Function}} options.splitter
 * @param {number} [options.topK=5]
 * @returns {Promise<{recallAt1: number, recallAt5: number, mrr: number,
 *   perBucket: object, misses: Array, splitSpans: Array, chunkCount: number}>}
 */
async function scoreCorpus({ corpusDir, pairs, embedder, splitter, topK = 5 }) {
  const documents = loadCorpus(corpusDir);
  const knownDocIds = new Set(documents.map((document) => document.docId));
  for (const pair of pairs) {
    if (!knownDocIds.has(pair.doc))
      throw new Error(`Pair ${pair.id} names unknown document: ${pair.doc}`);
  }

  const chunks = await chunkCorpus(documents, splitter);
  const splitSpans = findSplitSpans(chunks, pairs);

  const chunkVectors = await embedder.embedChunks(
    chunks.map((chunk) => chunk.text)
  );
  if (!Array.isArray(chunkVectors) || chunkVectors.length !== chunks.length)
    throw new Error(
      `Embedder returned ${chunkVectors?.length} vectors for ${chunks.length} chunks`
    );

  const overall = emptyBucketTally();
  const perBucketTally = {};
  const misses = [];

  for (const pair of pairs) {
    const queryVector = await embedder.embedTextInput(pair.question);
    const ranked = chunks
      .map((chunk, index) => ({
        chunk,
        score: cosineSimilarity(queryVector, chunkVectors[index]),
      }))
      .sort((a, b) => b.score - a.score);

    // Rank of the first chunk that holds the whole answer span. Matching on the
    // span rather than the doc id means a chunk from the right document that
    // does not actually contain the answer is not counted as a hit.
    let rank = 0;
    for (let index = 0; index < ranked.length; index++) {
      const candidate = ranked[index].chunk;
      if (
        candidate.docId === pair.doc &&
        chunkContainsSpan(candidate.text, pair.answerSpan)
      ) {
        rank = index + 1;
        break;
      }
    }

    perBucketTally[pair.bucket] ??= emptyBucketTally();
    const bucket = perBucketTally[pair.bucket];
    overall.pairs++;
    bucket.pairs++;

    if (rank === 1) {
      overall.hitsAt1++;
      bucket.hitsAt1++;
    }
    if (rank >= 1 && rank <= topK) {
      overall.hitsAt5++;
      bucket.hitsAt5++;
    } else {
      misses.push({
        pairId: pair.id,
        bucket: pair.bucket,
        question: pair.question,
        expectedDoc: pair.doc,
        rank: rank === 0 ? null : rank,
        topResult: ranked[0]?.chunk?.docId ?? null,
        spanWasSplit: splitSpans.some((entry) => entry.pairId === pair.id),
      });
    }
    if (rank >= 1) {
      overall.reciprocalRankSum += 1 / rank;
      bucket.reciprocalRankSum += 1 / rank;
    }
  }

  const perBucket = {};
  for (const [name, tally] of Object.entries(perBucketTally))
    perBucket[name] = summarize(tally);

  return {
    ...summarize(overall),
    perBucket,
    misses,
    splitSpans,
    chunkCount: chunks.length,
  };
}

module.exports = { scoreCorpus, loadCorpus, chunkCorpus, findSplitSpans, cosineSimilarity };

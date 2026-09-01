/**
 * Deterministic offline embedder for testing the eval harness itself.
 *
 * It is a hashed character-bigram bag of words with L2 normalization: no model,
 * no download, no network, same vectors on every machine. That makes it usable
 * in `yarn test`, where the real embedder's model download is not acceptable.
 *
 * It is NOT a stand-in for retrieval quality. It has no semantics, so it scores
 * lexically-distant pairs near chance by construction — which is exactly why the
 * real gate (`yarn eval:thai`) runs the real embedder. What the mock proves is
 * that the harness wiring works: documents load, the real splitter runs, spans
 * are checked, and the metrics arithmetic is right.
 */
const DIMENSIONS = 256;

function hashBigram(bigram) {
  let hash = 2166136261;
  for (let i = 0; i < bigram.length; i++) {
    hash ^= bigram.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % DIMENSIONS;
}

function embed(text) {
  const vector = new Array(DIMENSIONS).fill(0);
  const normalized = text.replace(/\s+/g, " ").toLowerCase();
  for (let i = 0; i < normalized.length - 1; i++)
    vector[hashBigram(normalized.slice(i, i + 2))] += 1;
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vector;
  return vector.map((v) => v / magnitude);
}

class MockEmbedder {
  constructor() {
    this.className = "MockEmbedder";
  }

  async embedTextInput(textInput) {
    return embed(textInput);
  }

  async embedChunks(textChunks = []) {
    return textChunks.map(embed);
  }
}

module.exports = { MockEmbedder, MOCK_EMBEDDER_DIMENSIONS: DIMENSIONS };

# V1-c recon — Thai eval set and retrieval harness

Lane C, month 2. Base `approof/main`. First of the V1 split (PMO ruling: V1-c eval before V1-b embedding; V1-a chunker starts immediately).

This issue produces **a number**. Everything else in V1 is judged against it, so the number has to mean something.

## 0. The one rule that makes this worth building

**The corpus is built before, and independently of, any tuning it will judge.**

If the corpus is assembled while tuning an embedder, it gets shaped — unconsciously, by whoever is watching the scores — into a set the current configuration happens to do well on. The result is a number that goes up and a system that does not improve. This is why PMO sequenced eval first, and it is the sentence to put at the top of the issue.

Two mechanics enforce it:
- **The corpus is committed and frozen before V1-b starts.** Changing it later is a PR of its own, with a stated reason.
- **Questions are written from the documents, not from the search results.** Whoever writes a pair reads the passage and asks what it answers — never runs a query and labels what came back.

## 1. Owner files (all new)

- `server/__tests__/eval/thai/corpus/` — documents, committed
- `server/__tests__/eval/thai/pairs.json` — question → expected passage id
- `server/utils/eval/retrievalHarness.js` — runs the real retrieval path, scores
- `server/__tests__/eval/thaiRetrieval.eval.test.js` — the gate
- `package.json` — `eval:thai` script

Nothing existing is modified. V1-c collides with nothing, in any lane.

## 2. Corpus — sources that can actually be committed

Licensing decides this, not convenience. The corpus lives in the repo forever.

**Use:**
- **Thai government documents** — ระเบียบ, ประกาศจัดซื้อจัดจ้าง, คู่มือประชาชน. Public-domain-equivalent under Thai law, and they are the actual target: formal register, long compounds, legal boilerplate.
- **Our own writing** — internal docs written for this purpose. Full control, no licence question. Slower.
- **Wikipedia Thai** (CC BY-SA) — attribution required, and it is *encyclopedic* register, which is not what enterprise users search. Useful as filler, misleading as the majority.

**Do not use:** scraped news (copyright), customer documents (obvious), or machine-translated English (translationese is not Thai — retrieval on it measures the translator).

**Composition, ~40 pairs:**

| Bucket | Pairs | What it catches |
|---|---|---|
| Formal government prose | 15 | The primary case |
| Mixed Thai/English technical | 10 | Real internal docs; catches splitters that break at script boundaries |
| Inconsistent transliteration | 5 | คอมพิวเตอร์ vs computer in one document |
| Lexically-distant Q/A | 10 | The question shares few words with the answer — measures embedding, not keyword overlap |

That last bucket is the one that separates a real embedder from a bag of words, and it is the one that is tedious to write, so it will be the one quietly dropped. Name it in the DoD.

**40 pairs detects a broken embedder. It does not rank two good ones.** Write that in the issue — a 3% difference on 40 pairs is noise, and someone will otherwise present it as a result.

## 3. Metrics

- **recall@1** — was the right passage first
- **recall@5** — was it in the window an LLM actually sees
- **MRR** — rank-sensitive, so a fix that moves the answer from 5th to 2nd shows up

**recall@5 is the gate.** RAG feeds the top-k to the model; a right answer at rank 3 is a right answer. recall@1 and MRR are reported for direction, not gated — gating recall@1 optimizes for a thing the product does not need.

Report per bucket as well as overall. An overall number hides the case that broke: 90% overall can be 100% on formal prose and 60% on mixed-script, and only the second one is the bug.

## 4. Harness

Must run **through the real retrieval path** — the same chunker, embedder, and vector query the product uses. A harness that embeds passages directly and compares cosine similarity measures the model and skips the chunker, which is where V1-a's bug lives (`TextSplitter/index.js` falls back to character-count splitting on Thai because there are no spaces to split on).

```js
// retrievalHarness.js
async function scoreCorpus({ corpusDir, pairs, embedder, splitter, topK = 5 })
  → { recallAt1, recallAt5, mrr, perBucket, misses }
```

`misses` is not optional — a score with no list of what failed cannot be acted on. It is the working output; the number is the summary.

**Offline.** No network, no paid API. A gate that costs money per run gets run less, and a gate that needs the internet fails in CI for reasons unrelated to retrieval.

## 5. DoD

1. `yarn eval:thai` runs offline and prints recall@1, recall@5, MRR, overall and per bucket.
2. Corpus committed with a `SOURCES.md` naming each document's origin and licence. A document whose licence cannot be stated does not go in.
3. ≥40 pairs, with the four buckets present at roughly the stated proportions — **including the 10 lexically-distant pairs**.
4. **Baseline recorded by running against today's `Xenova/all-MiniLM-L6-v2` and today's splitter, and written into the issue.** The threshold is set *from* that measurement, never guessed ahead of it: a threshold picked first is a number later work gets tuned to satisfy.
5. Threshold is a named constant with a comment saying which run produced it and on what date.
6. **Not in `yarn test`.** Slow, and its failure means "quality regressed", not "the build is broken" — different audience, different cadence. `check-local.sh` does not run it either.
7. The harness exercises the real chunker and embedder. A test asserting that (e.g. a wrong-splitter injection produces different scores) proves the wiring is real.

## 6. What this issue must not do

- **No tuning.** V1-c measures; V1-b changes. Someone who improves the embedder while building the corpus has invalidated the corpus.
- **No English eval.** Out of scope here, but V1-b's DoD needs one — a Thai gain that costs English is not a gain for a bilingual deployment, and there is nothing to detect that today.
- **No threshold before the baseline.** §5 item 4, restated because it is the thing most likely to be done backwards under time pressure.

## 7. Collision and sequencing

No file overlap with anything: `__tests__/eval/`, `utils/eval/`, one `package.json` script.

Ordering per PMO ruling — V1-c before V1-b, V1-a in parallel. Worth stating the mechanism: **V1-a (chunker) will change the baseline numbers.** If V1-a merges after the baseline is recorded, the baseline is stale and V1-b will be measured against the wrong figure.

So: **record the baseline twice** — once at V1-c merge, once immediately after V1-a merges — and V1-b is judged against the second. One line in the issue; without it, V1-b gets credit for V1-a's improvement.

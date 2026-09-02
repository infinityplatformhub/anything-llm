# V1 recon — ภาษาไทยครบวงจร (Thai end to end)

Lane C, month 2. Base `approof/main` @ `bbf3b7ed`. Backlog: *"UI th, Thai embedding + eval, OCR สแกนไทย"*, depends on **P0-2 only** — so it is genuinely independent of the P0-5 chain, ≈5 cw, backlog says split into ≥3.

DoD from the backlog, restated as things that can be measured: UI th complete on every page · Thai retrieval passes a threshold on an eval set · scanned Thai government PDFs are readable.

## 0. Split — and the order matters more than the split

The schedule says *"embedding+eval ก่อน UI"*. That ordering is load-bearing and the reason should be written into the issues: **the eval set is what tells you whether the other two worked.** Doing UI first produces a Thai interface over a system that cannot retrieve Thai, which looks finished and is not.

| Issue | Scope | Depends on | ~ |
|---|---|---|---|
| **V1-a** | Thai eval set + harness | — | 1 cw |
| **V1-b** | Thai embedding + chunking | V1-a | 2 cw |
| **V1-c** | Thai OCR for scanned PDFs | V1-a | 1.5 cw |
| **V1-d** | UI `th` locale | — (parallel) | 1 cw |

V1-d is independent of the other three in files and can run whenever a translator is available. V1-b and V1-c both answer to V1-a's numbers.

---

## V1-a — eval set and harness (do this first)

**Why first:** "retrieval ไทยผ่าน threshold" is not checkable without a corpus and a number. Building the corpus after tuning the embedder means the corpus gets shaped, unconsciously, to the tuning.

**Owner files (new)**
- `server/__tests__/eval/thai/corpus/` — documents + question/expected-passage pairs, committed.
- `server/utils/eval/retrievalHarness.js` — runs queries through the real retrieval path, scores recall@k and MRR.
- `server/__tests__/eval/thaiRetrieval.eval.test.js` — the gate, with the threshold as a named constant.

**Corpus content** — this decides whether the eval means anything:
- Thai government PDF text (procurement notices, ระเบียบ) — formal register, long compounds
- Mixed Thai/English technical text — the real internal-document case
- Thai with English loanwords transliterated inconsistently (คอมพิวเตอร์ / computer in one document)
- Question/passage pairs where the answer is **not** lexically similar to the question, so the eval measures embedding rather than keyword overlap

30–50 pairs is enough to detect a broken embedder. It is not enough to rank two good ones, and the issue should say so rather than implying the number is authoritative.

**DoD**
1. `yarn eval:thai` runs offline (no network, no paid API) and prints recall@1, recall@5, MRR.
2. Threshold is a named constant with a comment recording what produced it. **Set it from the current `Xenova/all-MiniLM-L6-v2` baseline, whatever that turns out to be** — a threshold picked before measuring is a guess that later work will be tuned to satisfy.
3. Eval is **not** in the default `yarn test` run. It is slow and its failure means "quality regressed", not "the build is broken" — different audiences, different cadence.
4. Baseline numbers recorded in the issue. V1-b and V1-c are judged against them.

---

## V1-b — Thai embedding and chunking

**The two real problems**

1. **The default embedder is English-first.** `server/utils/EmbeddingEngines/native/index.js:9` — `Xenova/all-MiniLM-L6-v2`. It is not trained for Thai; Thai text embeds poorly rather than not at all, which is worse, because retrieval returns confident nonsense instead of nothing.

2. **Thai has no spaces between words, and the splitter assumes it does.** `server/utils/TextSplitter/index.js:172-176` wraps Langchain's `RecursiveCharacterTextSplitter`, which falls back through `["\n\n", "\n", " ", ""]`. A Thai paragraph has no `" "` to split on, so it drops to `""` — a **character-count split that cuts mid-word**. This is the bug that makes Thai retrieval bad regardless of which embedder is chosen, and it is invisible in English testing.

**Owner files**
- `server/utils/EmbeddingEngines/native/index.js` — model selection (a Thai/multilingual default, or per-deployment).
- `server/utils/TextSplitter/index.js` — Thai-aware separators.
- `server/utils/eval/…` — reuse V1-a's harness, do not write a second one.

**Rulings needed**
- **Which model.** Multilingual E5 and BGE-m3 both handle Thai and both are larger than MiniLM — `dimensions` changes, so **every existing embedding must be recomputed**. That is a reindex, not a config change: V11's reindex UI does not exist yet in month 2, so V1-b needs at least a script and an operator note. **This is the biggest hidden cost in V1 and belongs in the issue explicitly.**
- **Splitter approach.** Options: a Thai word-break library (`wordcut`, ICU segmentation), or splitting on Thai sentence markers plus a character cap. Recommend measuring both against V1-a rather than picking on principle — this is exactly what the eval exists for.

**DoD**
1. V1-a numbers improve against the recorded baseline; the issue states by how much, not "improved".
2. A splitter test asserting a Thai paragraph is not cut mid-word — with a specific input and expected boundaries, not a length assertion.
3. Mixed Thai/English document chunks sensibly (the common real case, and where a naive Thai-only splitter breaks).
4. Reindex path exists and is documented; changing the model without recomputing leaves a corpus of embeddings from two models in one index, where similarity scores are not comparable and retrieval silently degrades.
5. English eval does not regress. Whatever exists for English retrieval today must be run — a Thai win that costs English is not a win for a bilingual deployment.

---

## V1-c — Thai OCR

**Already half-present:** `collector/utils/OCRLoader/` uses `tesseract.js@6`, and `validLangs.js:141` already lists `tha: "Thai"`. So the language pack is reachable; what is missing is that Thai is selected, and that the output is good enough to embed.

**Owner files**
- `collector/utils/OCRLoader/index.js` — language selection, Thai preprocessing.
- `collector/__tests__/` — fixtures with real scanned pages.

**What actually breaks with Thai OCR**, in the order it will be hit:
- **Language must be selected.** `tha` alone loses embedded English; `tha+eng` is right for government documents, which are full of English abbreviations, and costs accuracy on both. Measure, do not assume.
- **Thai diacritics sit above and below the line** (สระ/วรรณยุกต์). Low-DPI scans lose them, and losing a tone mark changes the word. This is the accuracy floor and no amount of post-processing recovers it — the issue should state a minimum DPI rather than pretending any scan works.
- **OCR output has no reliable word boundaries either**, so V1-b's splitter work applies to OCR text too. Sequence V1-c after or alongside V1-b, never before.

**DoD**
1. Committed fixtures: at least one real scanned Thai government PDF, one mixed Thai/English page, one deliberately low-quality scan.
2. Character-level accuracy measured and recorded per fixture. A pass/fail with no number cannot detect a regression.
3. The low-quality fixture has a **stated expected outcome** — either a documented accuracy floor or an explicit "this fails, and here is what the user sees". Silent garbage into the index is the failure mode to design against: unreadable OCR text still embeds, still retrieves, and still gets cited.
4. OCR text goes through the same Thai-aware splitter as V1-b.

---

## V1-d — UI `th` locale

**Infrastructure exists and is strict.** `frontend/src/locales/` has 30 languages, `en/common.js` is 1960 lines and is ground truth, `resources.js` documents the rules, and `yarn verify:translations` checks for missing keys. `th/` does not exist.

**Owner files:** `frontend/src/locales/th/common.js` (new), `frontend/src/locales/resources.js` (one import + one registry entry).

**DoD**
1. `yarn verify:translations` passes — that is the mechanical check and it is already written; do not add another.
2. No key added to `th/common.js` that is not in `en/common.js` (`resources.js` states this rule explicitly; it breaks every other language).
3. **Thai text renders without clipping at the app's real font sizes.** Thai stacks diacritics vertically and needs more line-height than Latin; a translation that is correct and visually clipped is not done. Check the settings sidebar and any fixed-height component.
4. Long-string overflow checked — Thai is often longer than English for the same phrase, and buttons are sized to English.

**Collision:** `frontend/src/locales/**` is otherwise untouched by every current track. `resources.js` is the only shared file and takes a two-line append. Lane D owns `frontend/` settings zones per the schedule; V1-d touches locale files only, so it is safe in lane C — worth confirming with lane D rather than assuming.

---

## Cross-cutting

**Migration:** none for any of the four. V1 adds no tables. If a per-deployment embedding-model setting is stored in `system_settings` it is a row, not a schema change.

**Collision with P0-5 chain:** none. V1 touches `EmbeddingEngines/`, `TextSplitter/`, `collector/`, and `frontend/src/locales/` — no file in the T-4a/T-4b/T-5/PR-4c set. It can start immediately and merge in any order relative to them.

**The one dependency that is not in the backlog table:** V1-b changes embedding dimensions, and **T-5 wires ACL filtering into vector queries in the same month.** Both touch the vector store, from opposite ends — T-5 changes how queries are filtered, V1-b changes what is stored. They do not share files, but a reindex during T-5's work will make T-5's tests non-deterministic. **Sequence the reindex to land either before T-5 starts or after it merges**, and say which in the issue.

## §PMO rulings
- Split: V1-a Thai-aware TextSplitter (word-boundary segmentation before Langchain fallback; RED = Thai paragraph chunk boundaries never mid-word) — independent, start now. V1-c eval set (Thai corpus + retrieval eval script) BEFORE V1-b. V1-b embedder switch + reindex script + operator note — schedule AFTER #30 T-5 merges (reindex during T-5 makes its tests non-deterministic). V1-d UI locale th + OCR tha+eng with min-DPI check and low-confidence flag (unreadable OCR must not be silently embedded) — after V1-c.
- V1 touches no T-4a/T-4b/T-5/PR-4c files.

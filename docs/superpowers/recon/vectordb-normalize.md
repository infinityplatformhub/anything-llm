# Recon — `getVectorDbClass` normalises its selection (residual from #74)

Base: `approof/main` after #74 merged (`8edd802be`). Residual raised by QA-3 during #74's review;
`getVectorDbClass` was explicitly left untouched there, because widening provider resolution is
not an installer change.

## What the defect is

`utils/helpers/index.js:88-89`:

```js
const vectorSelection = getExactly ?? process.env.VECTOR_DB ?? "lancedb";
switch (vectorSelection) {
```

A raw-string `switch`. `VECTOR_DB=PGVECTOR`, `PgVector`, or `pgvector ` with a trailing space
matches no case, falls to the `default` arm, prints one `[ENV ERROR]` line, and **returns
LanceDB**. The server starts, nothing throws, and the operator's vectors go somewhere they did not
choose. The mistake surfaces later as documents that are not where they should be.

The same shape applies to all ten providers, not only pgvector — `VECTOR_DB=Chroma` silently
becomes LanceDB too. pgvector is merely where it was noticed, because #74's doctor had to decide
whether to check the `vector` extension.

## Why it survived this long

Three things each look like they would have caught it:

- **`supportedVectorDB`** (`utils/helpers/updateENV.js:1432-1448`) rejects anything outside the
  ten names. But it only runs on the `updateENV` path — the settings UI. A value typed straight
  into `.env`, or set in compose's `environment:` block, never passes through it.
- **The `default` arm logs.** It prints `[ENV ERROR] No VECTOR_DB value found in environment!`,
  which is *wrong about the cause*: the value was found, it just did not match. An operator
  grepping for their misspelling finds a message telling them nothing is set.
- **#74's doctor** now blocks a misspelled pgvector at boot (`config.vector_db`). That covers the
  case the installer can see and only that one — it does not help `VECTOR_DB=Chroma`, and it does
  nothing for an instance whose value is changed after install.

## The shape of the fix, and its one real question

Normalising is three characters of work: `String(vectorSelection).trim().toLowerCase()`. What
needs deciding is what happens to a value that still matches nothing afterwards.

Today the answer is "LanceDB, quietly". Its two siblings in the same file disagree with that and
with each other:

| selector | unknown value |
|---|---|
| `getVectorDbClass` (`:120`) | logs, returns LanceDB |
| `getLLMProvider` (`:261`) | **throws** |
| `getEmbeddingEngineSelection` | falls back to the native embedder |

`getLLMProvider` throwing is the honest one, and it is also the riskiest change here:
`getVectorDbClass` is called on document upload, on chat, and on workspace delete. Turning a
silent fallback into a throw converts a wrong-storage bug into an outage for anyone whose `.env`
has a typo they have been living with. That is a real population — the fallback has been silent
for the entire life of the setting.

**This is the question for the ruling, and it should not be decided inside the fix:**

- (a) normalise only. `PGVECTOR` starts working; `Chorma` still silently becomes LanceDB.
- (b) normalise, and make the unknown-value log say what actually happened — the value, that it
  matched nothing, and that LanceDB is being used instead. Still no behaviour change.
- (c) normalise and throw, matching `getLLMProvider`. Correct, and it will take down instances
  that are currently running on an accidental LanceDB.

(b) is what I would build absent a ruling: it fixes the case that is unambiguously a bug (a
spelling the operator clearly meant) and makes the remaining case diagnosable, without converting
a data-placement problem into an availability problem. (c) is defensible as a follow-up once (b)
has been in a release long enough for the log to have warned people.

## Blast radius

- `getVectorDbClass` has **two** call shapes: no argument (reads `VECTOR_DB`) and one explicit
  argument, from `utils/vectorStore/resetAllVectorStores.js:31`. That caller then compares
  `vectorDbKey === "pgvector"` at `:33` to decide between `reset()` and per-namespace deletion —
  **so normalising inside `getVectorDbClass` alone leaves that comparison unnormalised**, and a
  misspelled value would get the right provider with the wrong reset strategy. It is called from
  `handleVectorStoreReset` with `process.env.VECTOR_DB` (`updateENV.js:1518`). Either normalise at
  the caller too, or export the normaliser. This is the part most likely to be missed.
- The eight `VectorDbSelection: process.env.VECTOR_DB || "lancedb"` sites in `endpoints/` are
  telemetry/response labels, not dispatch. They would report the raw value while the app used the
  normalised one. Harmless but worth deciding deliberately rather than by omission.
- `supportedVectorDB` should normalise too, or the settings UI keeps rejecting `PGVECTOR` while
  `.env` accepts it — two validators disagreeing about the same field.

## Tests worth having

1. every supported name in upper case, mixed case, and with surrounding whitespace resolves to the
   same provider class as the exact spelling — table-driven over the ten names, not one example
2. an unknown value still returns LanceDB (or throws, per the ruling) and logs a message naming
   **the value that was rejected**
3. `resetAllVectorStores` picks the pgvector reset path for `VECTOR_DB=PGVECTOR` — the comparison
   at `:33`, which is the one a normalise-in-one-place fix silently misses
4. `supportedVectorDB` accepts the same set of spellings the resolver does

## Scope

**In:** normalisation in `getVectorDbClass`, the `resetAllVectorStores` comparison, and
`supportedVectorDB`; the log message; the tests above.

**Out:** changing the fallback to a throw unless the ruling says (c); the telemetry label sites,
unless the ruling wants them normalised too; anything touching the providers themselves.

Small enough to be one issue. The only reason it is not a one-line change is the reset comparison,
and that is exactly why it deserves an issue rather than a drive-by.

# Recon — the eight `connect()` guards still compare `VECTOR_DB` raw (residual from #87)

Base: `approof/main` after #87 merged. #87 normalised the four places that *select* a provider;
these eight are inside the providers themselves and were not in that diff.

## The defect

Eight providers open `connect()` with a self-check against the raw environment variable:

| file | line | guard |
|---|---|---|
| `utils/vectorDbProviders/pinecone/index.js` | 28 | `process.env.VECTOR_DB !== "pinecone"` |
| `utils/vectorDbProviders/qdrant/index.js` | 28 | `!== "qdrant"` |
| `utils/vectorDbProviders/chromacloud/index.js` | 30 | `!== "chromacloud"` |
| `utils/vectorDbProviders/milvus/index.js` | 44 | `!== "milvus"` |
| `utils/vectorDbProviders/astra/index.js` | 49 | `!== "astra"` |
| `utils/vectorDbProviders/chroma/index.js` | 76 | `!== "chroma"` |
| `utils/vectorDbProviders/weaviate/index.js` | 117 | `!== "weaviate"` |
| `utils/vectorDbProviders/zilliz/index.js` | 18 | `!== "zilliz"` |

Each throws `<Name>::Invalid ENV settings`.

`lance` and `pgvector` have no such guard — they are the two that never read `VECTOR_DB` at all.

**PMO's message says 7; it is 8.** The eighth is `zilliz`, whose guard sits at `:18` rather than
next to a `new Client(...)` like the others, so a scan anchored on the client construction misses
it. Worth stating because the fix has to be applied to a list, and a list that is short by one
leaves a provider that resolves and then throws.

## What #87 changed, and why this is now worse rather than better

Before #87, `VECTOR_DB=CHROMA` resolved to LanceDB. Wrong, silent, but self-consistent: the guard
was never reached because Chroma was never constructed.

After #87, `CHROMA` resolves to the Chroma provider — and then `connect()` throws
`Chroma::Invalid ENV settings` on the first document upload or chat. The failure moved from
"silently wrong storage" to "loud failure at use", which is better, but the message is wrong about
the cause: the ENV settings are fine, and the operator has no way to read
`Chroma::Invalid ENV settings` as "your capitalisation".

So this is a residual of #87 in the strict sense: #87 made the resolver correct, and these guards
now disagree with it.

## The fix

Route each guard through the same normaliser:

```js
const { normalizeVectorDbKey } = require("../../helpers");
if (normalizeVectorDbKey(process.env.VECTOR_DB) !== "chroma")
  throw new Error("Chroma::Invalid ENV settings");
```

One import per file, one call per guard. No behaviour change for any correctly-spelled value.

**One thing to check before writing it:** `utils/helpers/index.js` requires vector providers
lazily, inside `getVectorDbClass`'s switch arms, so a top-level `require("../../helpers")` in a
provider closes a cycle (`helpers → provider → helpers`). Node tolerates it — the provider's
`require` returns helpers' partially-populated `module.exports` — but `normalizeVectorDbKey` is a
function declaration hoisted into the object at export time, so whether it is defined depends on
evaluation order. **Require it inside `connect()` instead of at file top**, matching how
`resetAllVectorStores` and `utils/doctor` already do it. This is the part most likely to be got
wrong, and it fails as `normalizeVectorDbKey is not a function` at runtime, not at import.

## Is the guard worth keeping at all?

Worth asking, since the fix touches all eight. The guard predates `getVectorDbClass` being the
only construction path; today the resolver already decided which provider to build, so the guard
re-asserts a decision made one frame up the stack. It does still catch one real case: a caller
passing `getExactly` that disagrees with the environment (`resetAllVectorStores` does exactly
this, `:31`).

Recommendation: **keep and normalise**, do not delete. Deleting is a behaviour change to ten
providers to remove a check that costs nothing, and the `getExactly` path means it is not purely
redundant. Noted here so the reviewer does not have to re-derive it.

## Tests

One file, table-driven over the eight providers:

1. every provider's `connect()` passes its guard for exact, upper, mixed and space-padded
   spellings — asserted by getting *past* the guard, i.e. the error thrown (if any) is not
   `Invalid ENV settings`
2. every provider still rejects a genuinely different provider's name — `VECTOR_DB=qdrant` must
   still make Chroma throw, or the guard has been deleted rather than fixed
3. the list of guarded providers is derived by scanning `utils/vectorDbProviders/` rather than
   hardcoded, so a provider added later without a normalised guard fails the suite

For (1) the client constructors must not actually dial out. Two options, and the choice matters
for whether the test proves anything:

- **jest.mock each client SDK** — precise, but eight mocks of eight different libraries, and a
  mock that is wrong makes the test pass for the wrong reason.
- **assert on the error message** — call `connect()`, expect it to reject, and assert the message
  is NOT `Invalid ENV settings`. The connection then fails for its own reasons (no endpoint, no
  API key) and that is fine: what is under test is the guard, and it sits before construction.

The second is what I would build. It needs no SDK mocks, cannot pass because a mock was wrong, and
fails correctly if someone moves the guard below the client construction — at which point the
error would change shape.

## Scope

**In:** the eight guards, the `require` placement, and the test file above.

**Out:** deleting the guards; the eight `VectorDbSelection:` telemetry labels in `endpoints/`
(still raw, deliberately, per #87's ledger); the option-(ค) throw-on-unknown follow-up.

Small — eight one-line edits — but the require-cycle detail and the eighth guard are why it is an
issue rather than a drive-by.

## Correction (Dev5, measured at 36976c14c)
The require-cycle claim above is wrong: `utils/helpers/index.js` requires providers only inside `getVectorDbClass` switch arms, never at module scope, and 7/8 providers already require helpers at module scope today without issue. The `require` inside `connect()` is kept for readability; three tests now pin the true property (helpers requires providers lazily; modules load in any order) so a future top-level provider require in helpers turns red before anyone debugs `normalizeVectorDbKey is not a function` at runtime.

# Techlead-2 pre-review — #30 slice 3 recon (`0739758`) and #73 recon (`536a81a`)

Design review before Dev4 writes code. Nothing is implemented at either SHA; this is a read
of the two recon documents plus one measurement the slice 3 recon flags as unverified and
identifies as its long pole.

Read-only against `/tmp/tl2-s2c` (worktree at slice 2 `4737f574`). Nothing was modified.

---

## The measurement — `curateSources` preserves the ACL fields on all eight providers

Slice 3's recon marks this ⚠️ *"I have read that ACL fields survive `curateSources` for
LanceDB; I have not verified it end to end, nor for the other eight providers"* and calls
the per-provider verification the long pole of the slice.

I measured it. Every provider's `curateSources` was fed the exact object
`authorizedSimilaritySearch` builds — `{metadata: {orgId, workspaceId, docId, title, score,
text}}` (`retrievalFilter.js`, the `sourceDocuments.map` at the end):

| provider | `orgId` | `workspaceId` | `docId` | `text` |
|---|---|---|---|---|
| lance | yes | yes | yes | yes |
| pgvector | yes | yes | yes | yes |
| milvus | yes | yes | yes | yes |
| qdrant | yes | yes | yes | yes |
| pinecone | yes | yes | yes | yes |
| chroma | yes | yes | yes | yes |
| weaviate | yes | yes | yes | yes |
| astra | yes | yes | yes | yes |

All eight survive, because every implementation spreads metadata **wholesale** —
`{...metadata}` — rather than picking named fields. The three shapes differ (lance/pgvector
destructure `text, vector, _distance` then choose `rest.metadata ?? rest`; milvus/pinecone/
chroma read `source.metadata` directly; qdrant/weaviate/astra use `hasOwnProperty("metadata")
? source.metadata : source`), but none of them enumerates keys, so none can drop these three.

**Consequence for the slice: this is not the long pole.** The recon budgeted per-provider
real-store assertions as the dominant cost; the property holds today on all eight and needs
no engine to check.

**It still needs a test**, for the reason the recon gives elsewhere: nothing prevents someone
rewriting one of these as an explicit pick later, and that change would fail closed and
silently — every stored citation on that provider becomes unprovable, retrieval quietly
degrades, and no error appears. But the right test is a **table across the eight
`curateSources` functions**, not eight real-store suites. `curateSources` is a pure function
over a plain object; it never touches the engine. That is the distinction from the five
predicate bugs: those needed a real store because only the engine could judge the predicate.
This one does not.

## #73 — the proposed guard test can pass while the thing it guards is broken

Recon point 3 suggests: *"assert that when `CI=true`, each of the four variables is set."*
That assertion is satisfiable without any suite running:

1. A variable pointing at a dead host is still *set*. The suite then fails in `beforeAll`
   rather than skipping — visible today, but invisible the moment anything downgrades that
   failure (a `continue-on-error`, an ignore pattern, a rename).
2. A guard written as a test case lives inside the suite system it is auditing, so it is
   subject to the same skipping it exists to detect.
3. `CI=true` is set by Actions. Run anywhere else — a self-hosted runner, a local
   reproduction — and the guard is silent by construction.

All three are the same failure the issue was opened for, one level up: a check that has
never been red is not yet shown to stop anything.

**Recommendation: assert that the suites RAN, not that variables exist.**

- Implement the guard as a **jest reporter or `globalTeardown`**, not a test. A reporter
  receives the full `results.testResults` and can assert that each of the four paths appears
  with `numPassingTests > 0`. That is the only vantage point from which "this file produced
  no results at all" is observable — a test case cannot see its own absence.
- If it must be a test, assert **connectivity** (`fetch(QDRANT_TEST_URL + "/collections")`),
  so it fails when the service is down rather than when the variable is unset. The variable
  is a proxy; the service is the thing.
- **Prove the guard once, in the PR that adds it**: delete one `services:` block and show CI
  goes red. §7.9 — a guard that has never failed is a guard whose failure path is untested.
  If that demonstration is not in the evidence, the guard is not yet verified.

The recon's evidence contract, `grep -E "^(Tests|Test Suites):"`, reads the aggregate line
and therefore cannot distinguish which files skipped. Use `--json` and assert per file — the
whole issue is that the total looked fine.

## #73 — Milvus in Actions is feasible, but not through `services:`

`services:` containers share a network and resolve each other by name, but there is no
`depends_on` and no ordering control. Milvus standalone reads `ETCD_ENDPOINTS` and
`MINIO_ADDRESS` at startup and will not become healthy until both are up, so a bare
`services:` block races.

Measured during the slice 1b review on this machine: `docker run --link` failed outright
(`Cannot link to a non running container`), and Milvus only came up after creating an
explicit network and starting etcd and MinIO first — with a wait before the Milvus container
would accept connections. The other three (qdrant, chroma, weaviate) are single containers
with no dependencies and started cleanly first time.

**Recommendation: the recon's own fallback, made explicit.** Put qdrant, chroma and weaviate
in `services:` — they work there and deliver most of the value immediately — and bring Milvus
up as a `docker compose` step with a readiness poll, or leave it developer-run. Either is
defensible; what is not defensible is leaving all four silently skipped. If Milvus stays
developer-run, that belongs **in the workflow file as a comment**, where someone editing CI
will read it, not only in the issue.

## Slice 3 — mutation list

Offered before implementation so the tests are designed against it rather than
retrofitted.

### S-22 (rehydration)

| # | mutation | must be caught by |
|---|---|---|
| M1 | `fillSourceWindow` takes `aclFilter` optional (`= {}`) instead of throwing | the "refuses without a filter" test |
| M2 | filter at the five call sites instead of inside `fillSourceWindow` | a test calling `fillSourceWindow` directly and still seeing filtering |
| M3 | `document.search` instead of `document.read` | slice 2's M8 shape — one document, ALLOW on search, DENY on read |
| M4 | filter `sources` but not `contextTexts` | **the most important one** — see below |
| M5 | `isRowAllowed` → `true` for a source with no ACL metadata | unprovable citation in both flag states |
| M6 | remove `seenChunks` dedupe | nothing — this is not a security property, and tying a test to it would make dedupe unrefactorable |

**M4 is the one to design for first.** `stream.js:243-244` sends `contextTexts` from the
filled window but `sources` only from the *current* search. So a rehydrated citation reaches
the model without ever appearing as a citation — a test asserting only on `sources` passes
while the revoked text is in the prompt. The recon names this (question 4); the mutation
makes it a gate.

**One thing the recon does not cover — ordering.** `fillSourceWindow`'s loop pushes and then
checks `sources.length >= nDocs`. If ACL filtering is applied after that check, a denied
source consumes a backfill slot and a permitted one never gets added: the same class as S-17
(a denied row occupying a topN slot), which slice 1 fixed on the provider side. Filter
**before** the length check. This is easy to get wrong because the loop is written
push-then-break, and the failure is invisible — fewer citations, never an error.

### S-25 (cardinality)

| # | mutation | must be caught by |
|---|---|---|
| M7 | out-of-scope `?slug=` returns 403 instead of 404 | the oracle test — 404 must be indistinguishable from a workspace that does not exist |
| M8 | scope check removed, 404 kept | instance-wide total does not leak |
| M9 | 404 removed, scope count kept | an out-of-scope slug is not answered |
| M10 | `vector-search` restores the `embeddingsCount === 0` early return | byte-identical response test |
| M11 | `/v1/system/vector-count` returns the instance total for a bound key | #67 A+B |

**M10 needs a stricter assertion than "both return 200".** The two responses differ in the
body today:

```
early return          -> {results: [], message: "No embeddings found for this workspace."}
filtered-to-nothing   -> {results: []}
```

Removing the early return alone leaves the `message` divergence, and the oracle survives.
The test must compare the **whole body** between "workspace with embeddings you may not
read" and "workspace with no embeddings", not just the status or the results array.

### Canonicalize

The recon is right that the four sites are already migrated — no provider calls
`where({docId})` directly any more. A comment-only change has no mutation to write; it is
verified by reading. The one hazard is the one the recon names: the "C-1 CLOSED / default ON"
block below the stale text belongs to #28 and must survive the tidy-up.

## Slice 2 notes carried forward — both still wanted

`pinnedDocuments()`'s `include: { document: { select: { orgId: true } } }` is load-bearing
and reads like an incidental eager-load. Worth restating why it matters more than it looks:
if `row.document` goes missing, `rowOrgId` is `undefined`, which routes to the **unprovable**
branch — not to a throw. With `RETRIEVAL_FILTER_ALLOW_UNPROVABLE` set that is a silent
cross-org leak; without it, a silent pinned-document outage. Neither announces itself, and
the comment beside it today explains only the `documentId` selection.

The org-mismatch counter remains worth adding as a **separate** tally from `unprovable`:
"cannot be proven" and "proven to belong to someone else" are different operator problems
with different remedies.

## Reproduction

```
cd /tmp/tl2-s2c/server
node -e '<feed {metadata:{orgId,workspaceId,docId,title,score,text}} through each
          provider.curateSources and report which of the three fields survive>'
```

The probe instantiated each provider class from `utils/vectorDbProviders/<name>` and called
`curateSources` on the wrapped shape; no engine, no network, no database. The Milvus/Actions
observations are from the container work done during the #30 slice 1b review on this machine.

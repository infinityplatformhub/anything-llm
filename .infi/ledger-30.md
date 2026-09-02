# T-5 (#30) — ledger

## Slice 1 part 1 (queryAuthorized + cache invalidation)

Ruling: `queryAuthorized` is a SEPARATE method, not an optional `aclFilter` argument on `performSimilaritySearch` — an optional ACL parameter is one forgotten call site away from an unfiltered read, and the forgetting is silent — risk if wrong is a second method to maintain per provider.

Ruling: The predicate is pushed INTO the query, before `.limit(topN)`. Post-filtering was rejected because it closes the leak and still breaks S-17: topN is spent on rows the actor cannot read, so their own lower-ranked documents never surface — a silent retrieval-quality bug nobody files, and the provider has already materialized forbidden chunk text into memory — risk if wrong is none; verified against lancedb 0.15 typings that `where()` prefilters by default and `postfilter()` is opt-in, asserted by test.

Ruling: `vectorPredicate` holds the filter→predicate translation once. Eight providers each writing their own would produce eight slightly different meanings of "denied", of which only the strictest is correct — risk if wrong is one more indirection.

Ruling: Two overlapping enforcement layers (pushdown + `isRowAllowed`) kept deliberately redundant — a provider whose predicate is subtly wrong (unindexed column silently ignored, dialect quirk) fails closed instead of leaking — risk if wrong is a second pass over at most topN rows.

Ruling: The `policy.changed` subscriber ships in the SAME change as the cache wiring (T-3 DoD, restated by the T-5 recon). A FilterCache with nothing invalidating it serves a revoked grant for up to its TTL — risk if wrong is none; bus failure disables the cache instead of leaving it live.

Ruling (Techlead correction, accepted): the cache saves the filter BUILD (membership/group/ACL/visibility queries), not a database round trip — `FilterCache.get` reads `currentPolicyVersion` on every call by design, which is what makes a missed invalidation safe rather than silently stale. My original comment claimed otherwise and was wrong.

Ruling: `retrievalFilter.js` does NOT construct an Actor — T-2 makes actorResolver the only construction site, and a literal here would be a second definition of identity free to drift more generous than the real one. Caught in my own diff before review.

## Slice 1a (call sites + providers + write path)

Ruling: All 9 retrieval sites go through `authorizedSimilaritySearch` rather than assembling filters themselves — a site that built its own could build a more generous one, and the filter would stop being a single definition of what an actor may read. A grep gate asserts `performSimilaritySearch` is gone from every caller, so a tenth site added later cannot silently skip it — risk if wrong is one shared helper on the hot path of every chat.

Ruling: Call sites pass a principal REFERENCE (`{type, id}`), never a finished Actor. A ref carries identity; an Actor carries scope (workspaceIds, orgId, grantPrincipal), and caller-supplied scope is caller-chosen reach — asserted by test in both directions.

Ruling: On `/v1`, `user` is null and identity lives in the Actor — the API key reads as its creator, narrowed by its own scopes. Without threading it, every /v1 chat resolved to no principal and read nothing.

Ruling (Techlead, item 1): slice 1a must not ship with 8 providers throwing. Lance/PGVector/Milvus implement the pushdown; the rest throw `RetrievalFilterUnsupportedError` — named rather than generic, because "Must be implemented by provider" reads as a code bug when it is a deployment that must change provider or wait. Falling back to unfiltered search was the alternative and would silently serve the whole namespace — risk if wrong is those deployments lose retrieval until slice 1b, which is the intended trade.

Ruling (Techlead, item 2): `vectorPredicate` returns a neutral `RetrievalConstraint` with per-dialect renderers (`toSqlString`, `toJsonbSql`, `toMilvusExpr`, `toStructured`). No provider parses another's output — a provider parsing a SQL string to rebuild an object filter is how a subtly wrong predicate gets written. Done now, while there was one consumer.

Ruling: PGVector binds parameters rather than interpolating — that predicate reaches a live PostgreSQL connection and document ids originate as user-supplied file data. `toSqlString`'s quote-escaping is adequate for LanceDB's embedded parser but not for this — risk if wrong is none.

Ruling: `docId IS NULL OR NOT IN (...)` — the natural SQL for a deny list — was rejected: it admits exactly the rows whose provenance cannot be established. Inverted to `IS NOT NULL AND NOT IN` to match `isRowAllowed`.

Ruling: Reranking runs only over rows that already passed the ACL check, and its widened candidate query (10–50 rows) carries the predicate too. Without that, enabling rerank mode was a way around the seam — found while wiring, not in review.

Ruling (Techlead, item 3): the rerank failure fallback is safe (rows already ACL-filtered) but silent, so it warns per occurrence. Accepted in the DoD as a degradation, not a failure.

Ruling: the WRITE PATH is in slice 1a. Ingest never wrote `orgId`/`workspaceId`/`docId`, so every row was unprovable and retrieval returned zero rows on every deployment. The recon scoped this as a T-6 backfill of old data; the real gap was that new writes had no metadata either. ACL fields are spread LAST so a document's own metadata cannot shadow the fields deciding its tenancy — risk if wrong is a wider slice; the alternative was merging an outage dressed as hardening.

Ruling: `aclMetadataForNamespace` resolves workspaceId inside the provider rather than adding an argument to `addDocumentToNamespace` — that method has five callers, and an argument five callers must remember is one a caller eventually forgets, silently producing unreadable vectors.

Ruling (Techlead, item 2 of the flag revision — my first design was wrong): `RETRIEVAL_FILTER_ALLOW_UNPROVABLE`, presence-based, default FAIL-CLOSED. I first built an `RETRIEVAL_FILTER_ENFORCE` flag defaulting off; that makes every deployment inherit the unsafe state by doing nothing. Inverted: a deployment that has not run the backfill must declare itself — risk if wrong is a pre-backfill upgrade loses retrieval until the operator sets one variable, which the boot report names explicitly.

Ruling (Techlead, item 1 of the same revision — also my error): the flag lives ONLY in `isRowAllowed`, never in the pushdown. I had relaxed all three renderers to `IS NULL OR <match>`; that lets unlabelled rows occupy topN slots and push the actor's own documents out — S-17 in reverse. Reverted; the predicate is strict in every state.

Ruling: the flag governs absence of evidence, never evidence of denial. A row carrying metadata is judged identically in both states — another org's row, a revoked document, a match-none actor stay denied. A half-labelled row is held to the provenance it claims rather than excused. Asserted with a both-states matrix.

Ruling (Techlead, item 4): after the backfill the flag is REMOVED, not flipped — a flag with no legitimate reason to be set is one somebody sets by accident.

Ruling (Techlead, item 3): the boot report COUNTS unlabelled vectors per provider rather than warning vaguely. "4,812 of 5,001 cannot be proven readable" is actionable and goes to zero when the backfill finishes; "some documents may be affected" is noise operators learn to skip. An uncountable provider reports "unknown" — never a reassuring zero.

Ruling (PMO (ก)): T-4a's rule stands — an org-wide grant means "the workspaces you belong to", not "every workspace". T-5 is the first change that makes it apply to retrieval, so `regression.test.js` now gives the key's creator membership rather than the rule being reverted. The write-side asymmetry it exposed (upload into a workspace you cannot read from) is a separate issue, not fixed here.

## Slice 1a — QA FAIL on 52b3d176, corrected

Ruling (Techlead FAIL, my bug): the flag was INERT. I put the escape hatch only in `isRowAllowed` and kept the pushdown strict in both states, so `orgId = '1'` removed every unlabelled row inside the query and the row check never saw one — `constraintFor` rendered identical SQL in both states, which is how QA proved it. Meanwhile the boot report told operators those rows were being served. A flag that does nothing is worse than no flag: it converts "retrieval is broken" into "retrieval is broken and the documented fix did not help" — risk if wrong is none; the correction is verified by reverting it, which fails 3 of the new tests.

Ruling: the escape clause is emitted by `constraintFor` in EVERY dialect as one all-or-nothing wrap — `((orgId IS NULL AND workspaceId IS NULL AND docId IS NULL) OR (<strict>))`. Per-field `IS NULL OR` was rejected: a row claiming an orgId but no workspaceId would pass the workspace check by having no workspace, which is a genuine hole wearing the costume of a rollout accommodation. Only the pre-T-5 shape is excused.

Ruling: accepted cost until #56 — in the flagged state unlabelled rows compete for result slots and can crowd out labelled ones. My original reasoning about that cost was correct but led to the wrong trade: a degraded ranking that works beats a pristine ranking that ignores the operator's only lever. The boot report now states this cost in both states.

Ruling: the regression test drives `queryAuthorized` on a real provider with a legacy row present, in both states — NOT `isRowAllowed` directly. Testing the row check in isolation is precisely what hid the bug: it was fed rows no real query would ever have returned. Every dialect is asserted to render differently once the flag is set, so a dialect that ignored it cannot be inert in only one deployment.

Residual [→ needs issue]: backfill vector metadata for existing deployments (#56), then REMOVE `RETRIEVAL_FILTER_ALLOW_UNPROVABLE`.
Residual: slice 1b — qdrant, pinecone, chroma, weaviate, astra via `toStructured()`.
Residual: slice 2 (G17 context injection / S-21), slice 3 (S-22 rehydration, S-25 cardinality, canonicalize 4 sites + fix the `docVectorsCanonicalize.js:19-20` comment).

SHA: 4e980681 (branch approof/t5-vector-filter, base approof/main 6104d911).

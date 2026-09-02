# Techlead-2 review — #30 slice 1b `4f3e3e38` (code-identical to `203471eb`; diff from `b512557e`)

**Verdict: FAIL.** Two blockers, both on Weaviate, both in the same class as the three
defects this issue has already produced: a predicate that reads correctly, passes every
test in the suite, and is rejected or silently wrong when a real engine sees it.

Everything else in the slice is correct, and the Milvus paren fix is a genuinely good
catch — I reproduced it and mutation-verified the test that holds it.

Independent worktree `/tmp/tl2-1b` (`git worktree add --detach`), `node_modules`
hardlink-copied from `/tmp/wt-50` (has `xml-crypto`), `prisma generate` run, Node v22.23.1.
My own containers: PostgreSQL 16 `:55472`, Qdrant v1.9.0 `:56333`, Chroma 1.0.0 `:58000`,
Weaviate 1.24.10 `:58080`. Milvus v2.3.9 was already running on `:19531`. Nothing in main
or any dev worktree was touched; every mutation was reverted from a backup and the worktree
is clean.

`git diff 203471eb 4f3e3e38 -- server/` is empty — the rebase is docs-only, confirmed.

---

## BLOCKER-1 — Weaviate: the flag does not widen retrieval, it BREAKS it

`RETRIEVAL_FILTER_ALLOW_UNPROVABLE` set + Weaviate ⇒ **every query throws**. Measured
through `Weaviate.queryAuthorized`, on a class created exactly as the provider creates it:

```
wv strict       -> ["MINE","DENIED"]
wv +deny        -> ["MINE"]
wv allow        -> ["MINE"]
wv orgWide      -> ["MINE","DENIED"]
wv FLAG strict  -> THREW  explorer: get class: vector search: ... build inverted filter
                          allow list: fetch doc ids for prop/value pair: nested query:
                          nested child 0: nested query: nested child 0:
                          Nullstate must be indexed to be filterable!
                          Add `indexNullState: true` to the invertedIndexConfig
wv FLAG +deny   -> THREW  (same)
```

Cause: `IsNull` requires `invertedIndexConfig.indexNullState` on the class, and the
provider's two `classCreator()` calls (`weaviate/index.js:297-305`, `:408-417`) pass only
`{class, description, vectorizer}`. So `toWeaviateWhere`'s escape clause — the thing the
ledger cites as Weaviate's advantage over Chroma — cannot execute on any class this
codebase has ever created.

Isolated to prove it is the config and nothing else:

```
class created WITHOUT invertedIndexConfig -> Or[And[IsNull x3], strict]  THROWS
class created WITH  indexNullState: true  -> Or[And[IsNull x3], strict]  -> LABELLED,LEGACY
```

This is worse than Chroma's honest inertness, and it is the exact failure shape slice 1a
was failed for twice: an operator whose retrieval is already degraded sets the one
documented lever, and retrieval goes from *partial* to *totally broken* — with a driver
error that names an index setting, not the flag.

**`indexNullState` cannot be turned on later.** I tried, on a class that already holds
data:

```
PUT /v1/schema/Tup  -> 422
{"error":[{"message":"inverted index config: IndexNullState cannot be changed when
updating a schema"}]}
```

So existing deployments cannot be fixed by a migration on the class — which makes this a
design question, not a one-line patch, and the reason it must not merge as-is. (PMO tells
me Dev4 measured the same and a ruling is being issued; I am recording my own numbers
because they were taken independently and they agree.)

## BLOCKER-2 — Weaviate: `NotEqual` on the deny-list silently returns NOTHING

Separate from BLOCKER-1, present in the **strict** state, and it fails in the direction
that hides.

Weaviate's auto-schema types a property from the first value it sees. Measured against a
class created the way the provider creates one (no declared properties):

```
docId="doc-bad"                                 -> typed text/word
   Equal    "doc-bad"  -> BAD          NotEqual "doc-bad"  -> (none)     <-- WRONG
docId="docbad"                                  -> typed text/word
   Equal    "docbad"   -> BAD          NotEqual "docbad"   -> MINE       <-- correct
docId="bbbbbbbb-5555-6666-7777-888888888888"    -> typed uuid
   Equal    uuid       -> BAD          NotEqual uuid       -> MINE       <-- correct
```

A hyphenated non-UUID docId is tokenized on `word`, and `NotEqual` against a multi-token
value matches nothing — so **the whole deny-list clause returns an empty result set**, and
a legitimate query with any denied document returns zero rows. That reproduces end to end:

```
wv +deny        -> ""      (with docId "doc-bad")
wv +deny(2)     -> ""
```

It is not a leak — it fails closed — but it is a silent, total retrieval outage on exactly
the actors who have a revocation, and it presents as "search stopped finding things".
That is the same signature as LanceDB's double-quote trap the ledger warns about.

Today's real `docId` values are `document.docId` UUIDs, which happen to type as `uuid` and
work. So the bug is latent, and it becomes live the moment a docId is not a bare UUID — or
the moment a class's first-seen docId differs in shape from later ones. A renderer that is
correct only because of an accident of auto-schema typing is not correct; the fix is to
declare the ACL properties explicitly at class creation (which also has to happen for
BLOCKER-1), with tokenization pinned.

Note the interaction: `Equal` on a `word`-tokenized property matched fine, so the strict
clauses are unaffected. Only the deny-list uses `NotEqual`, and only it breaks.

---

## The checkpoints PMO named

### Renderer real-store coverage — three of five have none

| dialect | render test | real-store test in repo | my own execution |
|---|---|---|---|
| milvus | yes | **yes**, `milvusRealStoreAcl.test.js`, skip-if-unavailable, labelled | **7/7 pass** on real Milvus v2.3.9 |
| qdrant | yes | none | executed by me — correct (below) |
| chroma | yes | none | executed by me — correct |
| weaviate | yes | none | executed by me — **BLOCKER-1, BLOCKER-2** |
| pinecone | yes | none | **not executed** — hosted-only, no local instance |
| astra | yes | none | **not executed** — hosted-only, no local instance |

The `vectorPredicateDialects.test.js` shared-contract table is good work and I want to say
so plainly: asserting the same five properties across all five renderers is what makes
"denied" one thing rather than five, and it is stronger than five isolated suites. But it
is a **string-shape** assertion in every case. It cannot see BLOCKER-1 or BLOCKER-2, and it
would not have seen the Milvus paren bug either — the ledger says as much, and the Milvus
suite exists precisely because of it. Applying that lesson to one dialect and not the other
four is the gap.

Qdrant and Chroma are trivially runnable locally (one `docker run` each); they should have
the same skip-if-unavailable treatment Milvus got. Pinecone and Astra genuinely cannot be
stood up locally — for those, the honest answer is a residual saying the renderer is
unverified against a live engine, not silence.

### Milvus — the paren fix is real, and the test that holds it is load-bearing

Reproduced. `7 passed, 7 total` against Milvus v2.3.9. Mutation, removing the parentheses:

```
✕ the ESCAPE CLAUSE parses — the case that was broken
✕ the flag does not admit another org or another workspace
✕ every rendered shape is accepted by the parser
Tests: 3 failed, 4 passed
```

And the same mutation with the suite skipped (no `MILVUS_TEST_ADDRESS`): **105 passed,
105 total** — the render tests do not notice at all. That is the clearest possible
statement of why the other four dialects need the same thing.

### Chroma — inert, announced, and rendered identically. Correct.

```
chroma strict   -> MINE
chroma orgWide  -> DENIED,MINE,OTHER-WS
chroma allow    -> MINE
chroma FLAG     -> MINE
rendered IDENTICAL between states: true
```

Boot report with the flag set:

```
ERROR [authorization] RETRIEVAL_FILTER_ALLOW_UNPROVABLE is set but has NO EFFECT on
VECTOR_DB="chroma". Its filter language has no "field is absent" operator ...
```

`escapeClauseUnavailable: true` travels on the return, and `allowed` in the count warning
is `allowUnprovableRows() && !escapeClauseUnavailable` — the effect, not the variable.
Mutation, emptying `NO_ESCAPE_CLAUSE_PROVIDERS`: **3 failed**. Mutation, giving Chroma an
escape clause anyway: **1 failed**. Both directions held.

### Weaviate `Not` — never emitted, on any path

Swept all five filter shapes in both flag states: no `"operator":"Not"` anywhere. Mutation
replacing `NotEqual` with `Not`: **6 failed / 105**. The ruling is genuinely enforced —
BLOCKER-2 is a different problem in the same clause.

### My 1a findings — all three landed, all three have tests

- **FINDING-1 (42P01)**: `error?.code === "42P01"` → `{unlabelled: 0, total: 0}`
  (`retrievalSupport.js:86-91`), with the reasoning recorded. **NIT-1 below: no test.**
- **FINDING-2 (Milvus unverified)**: closed by `milvusRealStoreAcl.test.js`, which found a
  real bug on its first run. Best possible outcome for that finding.
- **NIT (`every` vs `some`)**: `lanceLegacySchema.test.js` gained a half-migrated block —
  4 shapes, table created with a partial ACL schema. Mutation `every`→`some` now fails.

### Write path — ACL metadata on both branches, all five providers

Cached and novel paths both spread `aclMetadata` in qdrant, pinecone, chroma, weaviate and
astra, resolved once per document via `aclMetadataForNamespace`, spread LAST so document
metadata cannot shadow the tenancy fields. Checked each of the ten sites in the diff.

### Suite

`__tests__/security/authorization`, `--runInBand`, with `DATABASE_URL`, `API_KEY_PEPPER`
and `MILVUS_TEST_ADDRESS` all set: **35 suites / 403 tests, 0 failed, 0 skipped.**

Mutation summary (mine, all on top of a clean tree, each reverted):

| mutation | result |
|---|---|
| qdrant `should` → plain `must` (flag becomes narrowing) | 2 failed |
| pinecone `$nin` dropped | 1 failed |
| astra `$nin` dropped | 1 failed |
| weaviate `NotEqual` → `Not` | 6 failed |
| chroma given an escape clause | 1 failed |
| `NO_ESCAPE_CLAUSE_PROVIDERS` emptied | 3 failed |
| milvus parens dropped (**with** real Milvus) | 3 failed |
| milvus parens dropped (**without** real Milvus) | **0 failed** |
| pgvector 42P01 handler removed | **0 failed** |

---

## NIT-1 — the 42P01 fix has no test

Removing `if (error?.code === "42P01") return { unlabelled: 0, total: 0 };` leaves all 403
tests green. The behaviour is right and the comment explains why, but nothing holds it.
A fresh-install boot is a thing anyone might "simplify" later. One test with a stubbed
connection that throws `{code: "42P01"}` closes it.

## NIT-2 — Qdrant `is_null` does not match an ABSENT key, only an explicit null

Measured on Qdrant v1.9.0:

```
points: {text:"ABSENT"}  and  {text:"NULL", orgId:null, workspaceId:null, docId:null}

must[is_null  x3]  -> NULL            <-- only the explicit-null point
must[is_empty x3]  -> ABSENT, NULL    <-- both
```

Through the provider, with the flag set and a payload of the shape pre-T-5 ingest actually
wrote (no ACL keys at all):

```
QDRANT: flag SET, genuine pre-T-5 payload -> []
```

So on Qdrant the flag is inert for real legacy points, in the same way Chroma's is — except
Chroma's is documented and announced at boot and Qdrant's is not. It works only for a point
whose ACL keys exist and are explicitly `null`, which no writer in this codebase produces.

Not a blocker: fail-closed, no leak, and `isRowAllowed` still refuses the row so nothing
inconsistent reaches the caller. But `escapeClauseUnavailable` is currently `false` for
Qdrant, which tells an operator the flag works there. Either switch the renderer to
`is_empty` (which matches both shapes — I verified it returns `ABSENT,NULL`) with a
real-store test, or add Qdrant to `NO_ESCAPE_CLAUSE_PROVIDERS`. The first is better; the
second is at least honest.

Worth stating in general: absence-vs-null is a per-dialect question and this slice has now
produced three different answers to it (LanceDB: schema-level; Chroma: inexpressible;
Qdrant: two operators with different meanings). Pinecone's `$exists: false` and Astra's
`$exists: false` are the two I could not measure, and they are the two most likely to hold
a fourth answer.

---

## Correct, briefly

- `toStructured()` is gone. Grepped: no definition, no caller, no test. Ruling honoured.
- All five renderers return `null` for match-none and for empty scope, asserted as a table.
  This is the single most dangerous mistake available in the file and it is pinned five ways.
- Pinecone and Astra merge `$in`/`$nin` into one `docId` object rather than letting the
  allow-list overwrite the deny-list. Both mutation-verified.
- The escape clause is the conjunction of all three fields in every dialect that has one —
  no per-field leniency, asserted per renderer.
- `escapeClauseUnavailable` travels on every return path of `reportRetrievalFilterSupport`,
  including the `unsupported` one, with the reasoning recorded at the return.
- The header comment's "ADDING A PROVIDER" checklist naming both the render test and the
  real-store test is the right artefact in the right place — the next person to add a
  dialect reads that file, not the ledger. It just needs to be true of this slice's own
  five before it can be asked of the sixth.

## Reproduction

```
git worktree add --detach /tmp/tl2-1b 203471eb
cp -al /tmp/wt-50/server/node_modules /tmp/tl2-1b/server/node_modules
docker run -d --name tl2-1b-pg   -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=t5 -p 55472:5432 postgres:16-alpine
docker run -d --name tl2-qdrant  -p 56333:6333 qdrant/qdrant:v1.9.0
docker run -d --name tl2-chroma  -p 58000:8000 chromadb/chroma:1.0.0
docker run -d --name tl2-weaviate -p 58080:8080 \
  -e AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=true -e PERSISTENCE_DATA_PATH=/var/lib/weaviate \
  -e DEFAULT_VECTORIZER_MODULE=none -e CLUSTER_HOSTNAME=node1 semitechnologies/weaviate:1.24.10
cd /tmp/tl2-1b/server && npx prisma generate
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" STORAGE_DIR=$(mktemp -d) \
       SIG_KEY=aaaa SIG_SALT=bbbb API_KEY_PEPPER=$(openssl rand -hex 32) \
       MILVUS_TEST_ADDRESS=localhost:19531 \
       DATABASE_URL="postgresql://postgres:pw@127.0.0.1:55472/t5"
npx jest __tests__/security/authorization --runInBand
```

Probe scripts were written into `server/_*.js`, run, and deleted; each created its own
collection/class and dropped it. Mutations were applied to a working copy and restored from
a backup after every run.

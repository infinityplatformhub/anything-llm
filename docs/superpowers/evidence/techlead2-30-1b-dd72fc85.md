# Techlead-2 review — #30 slice 1b round 2 `dd72fc85` (diff from `4f3e3e38`)

**Verdict: PASS.** Both blockers are closed, and closed correctly — the Weaviate fix went
further than my finding did, and the extra distance is the right call. Three NITs below,
none blocking.

Same setup as round 1: independent worktree `/tmp/tl2-1b2`, `node_modules` hardlink-copied
from `/tmp/wt-30d`, `prisma generate` run, Node v22.23.1. My own containers, reused from
round 1 so the engines are the same ones that produced the FAIL: PostgreSQL 16 `:55472`,
Qdrant v1.9.0 `:56333`, Chroma 1.0.0 `:58000`, Weaviate 1.24.10 `:58080`, plus Milvus
v2.3.9 on `:19531`. Every number below I measured myself. Worktree clean, all mutations
reverted from backups.

---

## BLOCKER-1 — closed, and the fix is better than what I asked for

I proposed declaring the ACL properties and `indexNullState` at class creation, plus a
strict-predicate fallback for old classes. Dev4 measured that the fallback does not exist:
on a legacy class **the strict predicate fails too**, because the properties themselves are
undeclared. My round-1 evidence recorded only the `IsNull` failure and I did not check
`Equal` on an undeclared prop — that was a gap in my finding, and the design changed
because of it.

Measured on my Weaviate 1.24.10, driving `Weaviate.queryAuthorized`:

```
modern class props: orgId/field workspaceId/field docId/field text/word  indexNullState: true
hasAclSchema(modern): true
  modern flag=false strict -> ["MINE","GOOD","DENIED"]
  modern flag=false +deny  -> ["MINE","GOOD"]
  modern flag=true  strict -> ["MINE","GOOD","DENIED"]
  modern flag=true  +deny  -> ["MINE","GOOD"]

legacy class props: text/word orgId/word workspaceId/word docId/word  indexNullState: undefined
hasAclSchema(legacy): false
  legacy flag=false strict -> []
  legacy flag=true  strict -> []
  legacy log: class "T5Legacy" predates the ACL metadata (no orgId/workspaceId/docId
              properties, indexNullState off) and Weaviate cannot add either to an
              existing class ... Recreating the class and re-embedding ... is the only fix.
```

No throw in either state, refused with a log naming the cause and the remedy, and the
modern class filters identically in both states. That is the same answer Lance gives for a
pre-T-5 table, which makes it one rule rather than two.

**No `where` was dropped anywhere.** I checked this specifically because it is the tempting
wrong fix: the entire predicate is that one clause, so serving without it returns every
object in the class. `queryAuthorized` (`weaviate/index.js:214-236`) returns `empty` before
building `where`; there is no path that reaches `.withWhere()` with anything but a full
constraint. `git diff` confirms `withWhere(where)` is unchanged.

Mutations:

| forced | result |
|---|---|
| `invertedIndexConfig` removed from `aclClassConfig` | **3 failed** |
| `hasAclSchema` → always `true` | **4 failed** |
| legacy refuse branch disabled (`if (false)`) | **2 failed** |

## BLOCKER-2 — closed, with the over-deny direction correctly identified

`tokenization: "field"` on all three ACL properties. My round-1 numbers said `NotEqual` on
a hyphenated value returned *nothing*; the ledger's framing is sharper and matches what I
re-measured — under `word` the value becomes tokens `[doc, bad]` and `NotEqual` drops every
document sharing the token `doc`, so `doc-good` disappears alongside `doc-bad`. Same root
cause, more precisely stated. It fails toward fewer rows, which is why UUID ids hid it.

Verified through the provider with deliberately hyphenated non-UUID ids
(`doc-mine-2024` / `doc-bad-2024` / `doc-good-2024`) — the shape that broke in round 1:

```
modern flag=false +deny -> ["MINE","GOOD"]        <- GOOD survives; only DENIED is dropped
modern flag=true  +deny -> ["MINE","GOOD"]
```

Mutation `field` → `word`: **3 failed**. And `hasAclSchema` checks tokenization, not just
presence — a class declaring all three properties tokenized `word` is rejected as not
ACL-ready, which is the right reading: presence is not readiness, and such a class would
silently over-deny.

## Absent-key RED for Qdrant — present, and it is the fixture that does the work

`is_empty` replaces `is_null`, and `qdrantRealStoreAcl.test.js` carries **both** shapes as
separate points: `{text: "absent-keys"}` with no ACL keys at all, and `{text:
"explicit-null", orgId: null, ...}`. My round-1 measurement reproduces exactly, and the
suite pins the distinction itself in `is_null alone would NOT match the absent-key point`
— independent of our renderer, so a future Qdrant that changes this fails the test rather
than quietly making the two interchangeable.

Mutation `is_empty` → `is_null`: **1 failed**, and the failing test is
`flag on: a point with ABSENT keys is served` — the exact case. The test file's own comment
says it: "THE FIXTURE IS THE TEST", and a null-only fixture would have gone green while the
product was broken. Correct.

## 42P01 — now has a test, including the boundary

Three tests. The one that matters most is the third: a *different* pg error
(`code: "08006"`) still returns `{error}`, so swallowing 42P01 did not become swallowing
everything. Mutation removing the handler: **2 failed** (round 1: 0 failed). NIT-1 closed.

## UNVERIFIED wording for pinecone/astra — correct, and better than a residual

```
=== pinecone {"supported":true,...,"escapeClauseUnavailable":false}
  W| VECTOR_DB="pinecone" has an ACL filter that has never been run against a real
     pinecone instance — it is hosted-only, so this deployment is the first to execute it.
     Every other provider's predicate was rejected by its engine on first contact despite
     reading correctly (identifier quoting, placeholder numbering, operator precedence,
     tokenization). Treat retrieval results here as UNVERIFIED: confirm that a document
     you cannot read is absent from chat context before relying on this.
=== astra    (same)
=== qdrant / weaviate  (no such warning — correct)
```

The message tells the operator what to actually do, which a residual line in a repo file
cannot. Listing the four real defects as evidence is what makes it credible rather than
boilerplate.

## The Weaviate per-class boot report

Verified on a deployment holding one modern and one legacy class:

```
E| RETRIEVAL_FILTER_ALLOW_UNPROVABLE has NO EFFECT on 1 Weaviate class(es): T5Legacy2.
   They were created before the ACL metadata existed ... Weaviate refuses to add either
   afterwards ... Fixing this requires recreating the class and re-embedding its documents.
```

Per-class rather than per-provider is the right granularity: "Weaviate does not support
this" would be false for half the deployment and actionable for none of it. `staleClasses`
travels on the return.

## Suite

`__tests__/security/authorization`, `--runInBand`, all five engines reachable:
**38 suites / 435 tests, 0 failed, 0 skipped.**

Note for whoever runs this next — the real-store env var names are not what round 1's
docker instructions imply, and a wrong name silently *skips* rather than failing:

```
MILVUS_TEST_ADDRESS=localhost:19531       (host:port)
QDRANT_TEST_URL=http://127.0.0.1:56333    (URL)
CHROMA_TEST_ADDRESS=http://127.0.0.1:58000 (URL, despite "ADDRESS")
WEAVIATE_TEST_URL=127.0.0.1:58080         (host:port, despite "URL")
```

With three of them wrong I got `3 skipped, 35 passed` and it looked like a clean run.

Full mutation table (all mine, each reverted):

| mutation | round 1 | round 2 |
|---|---|---|
| qdrant `is_empty` → `is_null` | n/a | **1 failed** |
| weaviate tokenization `field` → `word` | n/a | **3 failed** |
| weaviate `indexNullState` removed | n/a | **3 failed** |
| `hasAclSchema` → always true | n/a | **4 failed** |
| weaviate legacy refuse branch disabled | n/a | **2 failed** |
| 42P01 handler removed | 0 failed | **2 failed** |
| `UNVERIFIED_PROVIDERS` emptied | n/a | 0 failed (NIT-3) |

---

## NIT-1 — `toWeaviateWhere({allowUnprovable})` is dead code

The parameter added at `vectorPredicate.js:431` has no caller. Grepped the whole tree: the
only hits are the definition and its own comment. The provider takes the earlier `return
empty` path, so the option is never exercised — including by the tests, which all call
`toWeaviateWhere()` bare.

It is harmless today (default `true`, so behaviour is unchanged) but it is a second, unused
way to express "this class cannot answer an IsNull", sitting next to the one that is
actually used. The next person to touch this has two mechanisms and no way to tell which is
live. Delete it, or wire it and drop the provider-side branch — not both.

## NIT-2 — the two new boot-report behaviours have no tests

`weaviateClassesWithoutAclSchema` / `staleClasses` and the per-class error message: no test
references either (`grep staleClasses` over `__tests__` → nothing). I verified both by hand
and they work. But this is the same shape as the 42P01 finding I raised in round 1 —
correct code, explained by a comment, held by nothing.

The stale-class list is the only thing that tells an operator *which* workspaces need
re-embedding, so it is worth a test: two classes, one modern one legacy, assert the legacy
name appears and the modern one does not.

## NIT-3 — `UNVERIFIED_PROVIDERS` emptied leaves the suite green

Same class as NIT-2 and the weakest of the three, since the consequence is a missing
warning rather than wrong filtering. One test asserting the warning fires for `pinecone`
and not for `qdrant` closes it. Worth doing because the whole point of that list is to be
noticed, and nothing currently notices if it disappears.

---

## Correct, briefly

- `aclClassConfig()` is used by both `classCreator` sites (cached and novel paths) — I
  checked both; a class created either way is ACL-ready.
- The Weaviate real-store test builds its modern class from `aclClassConfig()` itself
  rather than a hand-written copy, so a change to what the provider creates cannot pass
  the test while breaking production. Its own comment says an earlier version made exactly
  that mistake.
- `run()` in that suite checks `response.errors` explicitly, because Weaviate reports
  filter errors in the payload rather than throwing — a test reading only rows would score
  a rejected filter as "no matches". That is the trap that made BLOCKER-1 survive round 1's
  string tests, and it is now closed by construction.
- The chroma suite asserts the flag changes nothing **both** as rendered equality and as
  engine-result equality. "Does not throw" would have passed with a half-applied escape
  clause, which is the 1a bug's shape.
- `indexNullState cannot be enabled on an existing class` is pinned as a test against the
  live 422. Recording a negative result as a test is the right way to stop someone spending
  an afternoon writing the migration.
- Qdrant, Chroma and Weaviate real-store suites all skip-if-unavailable with docker
  instructions in the header, matching the Milvus pattern.

## Reproduction

```
git worktree add --detach /tmp/tl2-1b2 dd72fc85
cp -al /tmp/wt-30d/server/node_modules /tmp/tl2-1b2/server/node_modules
cd /tmp/tl2-1b2/server && npx prisma generate
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" STORAGE_DIR=$(mktemp -d) \
       SIG_KEY=aaaa SIG_SALT=bbbb API_KEY_PEPPER=$(openssl rand -hex 32) \
       MILVUS_TEST_ADDRESS=localhost:19531 QDRANT_TEST_URL=http://127.0.0.1:56333 \
       CHROMA_TEST_ADDRESS=http://127.0.0.1:58000 WEAVIATE_TEST_URL=127.0.0.1:58080 \
       DATABASE_URL="postgresql://postgres:pw@127.0.0.1:55472/t5"
npx jest __tests__/security/authorization --runInBand
```

Containers as listed at the top. Probe scripts were written into `server/_*.js`, run and
deleted; each created and dropped its own class/collection.

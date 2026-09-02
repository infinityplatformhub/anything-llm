# T-5 (#30) slice 3 recon — S-22 rehydration, S-25 cardinality, canonicalize 4 sites

Read-only. No code written; slice 2 (`4737f574`) is unmerged and must not be touched.

Scope per the PMO slice ruling: *"Slice 3: fillSourceWindow rehydration (S-22), cardinality
endpoints (S-25), canonicalize 4 sites, docVectorsCanonicalize.js:19-20 comment."*

---

## A. S-22 — citation rehydration (`fillSourceWindow`, G1)

### The gap

`utils/helpers/chat/index.js:382` reads citations back out of **stored chat history** and
re-injects them into the current turn's context:

```js
const chatSources = safeJsonParse(chat.response, { sources: [] })?.sources || [];
const validSources = chatSources.filter((source) => {
  return (
    filterIdentifiers.includes(sourceIdentifier(source)) == false &&
    source.hasOwnProperty("score") &&
    source.hasOwnProperty("text") &&
    seenChunks.has(source.id) == false
  );
});
```

Four predicates: not currently pinned, has a score, has text, not a duplicate. **None of
them is an authorization check.** The rows come from `workspace_chats.response`, a JSON blob
written when the answer was produced — so the ACL that applied is the one that was in force
*then*, not now.

The attack is the S-22 script exactly: ask a question, get a citation, have the grant
revoked, ask a follow-up **in the same thread**. The revoked document's text returns via
`contextTexts`. This is a third boundary — neither slice 1 (the provider) nor slice 2 (the
pinned path) touches it, because the text never goes near a vector store or a pinned row on
the way back.

Worth stating plainly: this path **replays a decision rather than making one**. It is the
only retrieval surface in T-5 where the data source is our own prior output.

### Call sites (5)

| Site | Note |
|---|---|
| `utils/chats/stream.js:229` | session chat |
| `utils/chats/embed.js:171` | embed visitor |
| `utils/chats/apiChatHandler.js:375`, `:776` | `/v1`, two handlers |
| `utils/telegramBot/chat/stream.js:271` | no HTTP route |

Same shape as slice 2's ten pinned sites, so the same conclusion applies: filter **inside
`fillSourceWindow`**, not at five call sites. A filter five callers must remember is one a
sixth will omit.

### The hard part: what identifies a stored source?

This is the open question, and it decides the whole design. What `curateSources` persists
(`lance/index.js:723`) is the vector's **metadata spread flat**, minus `vector` and
`_distance`:

```js
const { text, vector: _v, _distance: _d, ...rest } = source;
const metadata = rest.hasOwnProperty("metadata") ? rest.metadata : rest;
documents.push({ ...metadata, ...(text ? { text } : {}) });
```

Since slice 1a the write path stamps `orgId`/`workspaceId`/`docId` onto every vector
(`aclMetadataFor`, spread **last** so document metadata cannot shadow it), and those fields
survive `curateSources` because it copies metadata wholesale. So a source stored **after
slice 1a** carries exactly the three fields `isRowAllowed` needs.

A source stored **before** it does not — same shape as a pre-T-5 vector row, and it should
follow the same rule (`RETRIEVAL_FILTER_ALLOW_UNPROVABLE`, fail-closed by default).

**That symmetry is the recommendation: reuse `isRowAllowed(source, aclFilter)` verbatim.**
It already handles missing/partial metadata, deny lists, allow lists, `matchNone`, org and
workspace scope, and the unprovable flag — and using it means "readable" cannot drift
between a live vector and a replayed citation. Writing a second predicate here would be a
fourth definition of readable.

⚠️ **Must be measured before relying on it.** I have read that ACL fields survive
`curateSources` for LanceDB; I have **not** verified it end to end, nor for the other eight
providers, whose `curateSources` implementations differ. Chroma pushes `metadata` directly
(`chroma/index.js:194`), Weaviate destructures `...rest` plus `id`, Pinecone spreads
`match.metadata`. A provider that drops these three fields turns every one of its stored
citations unprovable — which fails **closed**, so it is an outage, not a leak, but it would
be a silent retrieval regression on that provider. **Slice 3 must assert this per provider
against a real store** — that is the §7.12 lesson from five renderers in a row.

### Design questions needing a ruling

1. **Signature.** `fillSourceWindow` currently takes no actor and no filter. Adding a
   required `aclFilter` matches the `pinnedDocs` precedent (throw when absent — an optional
   security filter is a filter plus a way to skip it). Confirm that shape.
2. **`document.read` or `document.search`?** A rehydrated citation is *replayed retrieval
   output*, which argues `document.search`; but it is injected wholesale like a pinned
   document, which argues `document.read`. **Recommendation: `document.read`**, matching
   slice 2 — the text enters the prompt entire, and the read-deny is the stricter question.
   Slice 2's M8 test showed these genuinely diverge, so this is a real choice, not a
   formality.
3. **Unprovable pre-slice-1a citations** — confirm they follow
   `RETRIEVAL_FILTER_ALLOW_UNPROVABLE` like everything else.
4. **`sources` vs `contextTexts`.** `fillSourceWindow` returns both, and `stream.js:243-244`
   sends `contextTexts` from the filled window but `sources` only from the *current* search.
   So a rehydrated citation reaches the LLM but is not shown as a citation. Filtering must
   cover `contextTexts` — the leak is in what the model is told, not only in what the UI
   renders.

### Tests

- RED: cite → revoke via `policyRepository` → follow-up in the same thread → text absent
  from `contextTexts`. Over HTTP; the #32 mint oracle and slice 2's own blocker are both
  precedent for gaps invisible below the route.
- The positive control: a still-granted citation **is** rehydrated (otherwise the feature is
  simply broken and the RED passes for the wrong reason — this bit me twice in slice 2).
- Cross-workspace and cross-org, mirroring slice 2 round 3.
- Per provider, against a real store: ACL fields survive that provider's `curateSources`.
- Unprovable citation in both flag states.

---

## B. S-25 — cardinality (G2)

Three endpoints report counts that are not scoped to the actor.

| Route | Line | Gate today | Leak |
|---|---|---|---|
| `GET /system/system-vectors` | `endpoints/system.js:484-493` | `requirePermission("system.read", orgResource)` | `?slug=` returns `namespaceCount` for **any** workspace; no slug returns `totalVectors()` for the whole instance |
| `GET /v1/system/vector-count` | `endpoints/api/system/index.js:75` | `validApiKey(scopeFor(...))` | `totalVectors()` — instance-wide, no workspace bound |
| `POST /v1/workspace/:slug/vector-search` | `endpoints/api/workspace/index.js:995-996` | gated, and the search itself uses `authorizedSimilaritySearch` | `hasNamespace`/`namespaceCount` run **before** it, and `embeddingsCount === 0` produces a distinguishable response |

The third is the subtle one and the most likely to be argued away. The *results* are
correctly filtered — slice 1 did that. But the count runs first and shapes the reply, so
"this workspace has embeddings but you may read none of them" and "this workspace has no
embeddings" are **distinguishable**. That is an existence oracle over workspace content,
which is the same class of bug as #32's mint oracle and the login/invite oracle in P0-4A.

`system-vectors` takes `system.read` at **org** scope while accepting a workspace slug — an
org-level permission answering a workspace-level question, with no check that the slug is in
scope. Structurally the same mistake slice 2 round 3 just fixed in `pinnedDocs`: the
resource comes from the request, the permission from somewhere else.

### Questions needing a ruling

1. **What does a scoped count mean?** Options: (a) count only within the actor's readable
   workspaces; (b) refuse `?slug=` outside scope (404, per `NON_DISCLOSING`); (c) both.
   **Recommendation: (c)** — (b) alone still leaks the instance-wide total.
2. **Is `totalVectors()` defensible at all?** It is inherently instance-wide. Either it
   requires an org-wide grant and returns the org total, or it is dropped from `/v1`.
   Needs a decision — it is a public API shape.
3. **Does deny-list membership change a count?** A per-actor exact count implies running the
   ACL predicate over the whole namespace — expensive on the hot path. **Recommendation:
   count within workspace scope only** (cheap, no per-document work), and record explicitly
   that the count is not deny-list-exact. A number that is right to the document is not
   worth a full scan per request; leaking *which* documents is what matters.
4. **Cost.** `namespaceCount` is called on the chat hot path (`stream.js`,
   `apiChatHandler.js`) as an "are there any embeddings" probe. Whatever replaces it must
   stay O(1)-ish per request.

---

## C. Canonicalize — T-5's own 4 sites, and the comment

PMO ruling C-1: the flag flips in **T-6**, not T-5. T-5's DoD is "its own 4 sites moved" plus
the comment correction.

**Status: the four sites appear already migrated**, by T-4b (#29) and T-6 Phase B (#28):

| # | Site | State |
|---|---|---|
| 1 | `models/vectors.js:45` `docIdVariants` | resolves legacy uuid **and** canonical id |
| 2 | `models/vectors.js:64` `forDocument` | uses `docIdVariants` |
| 3 | `models/vectors.js:83` `deleteForWorkspace` | matches both shapes |
| 4 | `models/documents.js:227` | `in: [document.docId, document.documentId]` |

All eight providers now call `DocumentVectors.forDocument` rather than
`where({docId})` — verified by grep across `utils/vectorDbProviders/*/index.js`.

**The comment at `docVectorsCanonicalize.js:14-26` is now stale in the opposite direction**
from what the slice ruling anticipated. It still says *"The job MUST NOT run until those call
sites migrate"* and names C-1 as open, while the block immediately below it says C-1 is
CLOSED by T-6 Phase B and the default is now ON. **A file that states both "must not run" and
"runs by default" is worse than one that is merely out of date** — a reader acts on whichever
half they read first. This is the one piece of C in slice 3 that is genuinely outstanding.

⚠️ Verify before editing: T-6 (#28) is another dev's issue and this file is shared. The
"default is now ON" block is not mine and must not be reverted while tidying the stale half
above it.

---

## D. Residuals that must be closed before `task.sh close --issue 30`

Carried from slices 1a/1b/2 — none is slice 3 work, but the issue cannot close over them.

| # | Residual | Disposition |
|---|---|---|
| 1 | **Weaviate legacy classes** — pre-T-5 classes cannot get `indexNullState` (422 from Weaviate); `queryAuthorized` refuses the namespace | → **#56** (re-embed). Boot report names the classes. |
| 2 | **Lance legacy tables** — no ACL columns; `hasAclColumns()` excludes them | → **#56** (backfill). |
| 3 | **pinecone + astra UNVERIFIED** — renderers unit-tested, never executed against a real engine (hosted-only, no local instance). Five providers shipped predicates that read correctly and were rejected on first contact. | Needs a PMO ruling: block #30, or ship with the boot warning that already exists. **Recommend shipping with the warning** — it is documented and loud — but it must be a stated decision, not a silence. |
| 4 | **chroma has no escape clause** — its `where` cannot express the unlabelled-row clause, so `RETRIEVAL_FILTER_ALLOW_UNPROVABLE` does nothing there; `isRowAllowed` refuses unlabelled rows regardless. In `NO_ESCAPE_CLAUSE_PROVIDERS`. | Fail-closed and documented. Confirm accepted. |
| 5 | **`RETRIEVAL_FILTER_ALLOW_UNPROVABLE` must be REMOVED after backfill**, not left flipped | → **#56**, explicitly. |
| 6 | **CI cannot run the real-store suites.** `.github/workflows/ci.yml` sets only `DATABASE_URL` and `API_KEY_PEPPER`; the four engine URLs are unset, so `describeIfMilvus`/`Qdrant`/`Weaviate`/`Chroma` all `describe.skip`. **CI is green without ever executing the tests that caught five of this issue's bugs.** | **Needs a decision before close.** Either add the four services + env vars to CI, or state in the issue that these suites are developer-run only. A suite that silently skips is the "gate that is always green" failure the skill's rationalization table names. |
| 7 | `STORAGE_DIR` is also unset in CI | Suites set it themselves, but it is the same class as #6. |

---

## E. Techlead-2 notes carried in from slice 2 (non-blocking, land in slice 3)

Both accepted. `4737f574` is not to be touched — these ride with the slice 3 commit.

1. **`pinnedDocuments()` needs a comment saying the `include` is load-bearing.** The
   `include: { document: { select: { orgId: true } } }` reads like an incidental eager-load,
   and the current comment beside it explains only why `documentId` is selected. Someone
   trimming "unused" includes would silently remove the org check's only input — and
   `row.document?.orgId` would then be `undefined`, which routes to the *unprovable* branch
   rather than throwing. Under `RETRIEVAL_FILTER_ALLOW_UNPROVABLE` that is a cross-org leak;
   without it, a total pinned-document outage. Neither announces itself. The comment must say
   the org check depends on it, not merely that it exists.

2. **Count org-mismatch refusals and report them like `unprovable`.** Today
   `String(rowOrgId) !== String(aclFilter.orgId)` returns `false` silently. `pinnedDocs`
   already tallies `unprovable` and logs it with the remedy; an org mismatch deserves the
   same, because it means something is *wrong* — either a genuine cross-tenant attempt or a
   data fault where a workspace holds another org's document. A silent zero cannot be told
   apart from an empty workspace. Same reasoning as the boot report's per-provider counts:
   a number an operator can act on beats a filter that quietly works.

   Note it is a distinct counter from `unprovable`, not an increment of it — "cannot be
   proven" and "proven to belong to someone else" are different operator problems with
   different remedies (run the backfill vs. investigate).

---

## F. PMO rulings (2026-09-02) — these settle the open questions above

Ruling: `fillSourceWindow` takes a REQUIRED `aclFilter` and throws without one, matching
`pinnedDocs`. An optional security filter is a filter plus a way to skip it, and it fails in
the direction that returns more data — the shape that let #45's keyKind gap through.

Ruling: the action is `document.read`, not `document.search`. A rehydrated citation is
injected into the prompt whole, exactly like a pinned document, so reading it is the
question being asked. Slice 2's M8 proved the two actions genuinely diverge, so this is a
real choice rather than a formality.

Ruling: S-25 takes BOTH halves — counts cover only workspaces in the actor's scope, AND
`?slug=` outside scope returns 404. Scoping the count alone still leaks the instance-wide
total; refusing the slug alone still answers "how many exist here". The 404 must be
indistinguishable from a genuinely absent workspace, or the refusal becomes the oracle it
was meant to close (`NON_DISCLOSING`, same rule requirePermission already applies).

Ruling: the count need NOT be deny-list-exact. An exact per-actor number means running the
ACL predicate across the whole namespace on a request that only asks "are there any" —
expensive on the chat hot path. Scope-level counting is cheap and closes the real exposure:
what matters is not revealing WHICH documents exist.

Ruling: `vector-search` must not use `namespaceCount === 0` as an early return that changes
the response shape. Today "has embeddings you may not read" and "has no embeddings" are
distinguishable, which is an existence oracle over workspace content — the same class as
#32's mint oracle. It returns the ordinary empty-result shape instead.

Ruling: `/v1/system/vector-count` follows #67 A+B — a bound key counts only within its own
scope; an org-wide or unbound key keeps the instance-wide total. The response shape does not
change between the two, for the same reason as above.

Ruling: the per-provider S-22 verification is NOT optional. Any provider whose
`curateSources` drops `orgId`/`workspaceId`/`docId` must be fixed to copy them, with a
real-store test (§7.12). Reading the code is what has failed five times on this issue; only
executing the predicate against the engine has ever caught it.

Ruling: `docVectorsCanonicalize.js:14-26` is corrected in slice 3 — comment only, no
behaviour change, and the "C-1 CLOSED / default ON" block below it (T-6 #28's) is not
touched.

Ruling: pinecone and astra SHIP unverified, with the existing boot warning, rather than
blocking #30. Recorded in `docs/superpowers/residual-risks.md` and on the issue so it reads
as a decision that was made rather than a gap nobody noticed.

Ruling: a separate issue adds the four engine services to CI. Until it lands, the real-store
suites are dev/QA-run only and QA-2's evidence stands in for CI — stated on #30 rather than
left implicit, because a suite that silently skips is the "gate that is always green"
failure the skill's rationalization table names.

---

## G. Size

S-22 ~60 lines + 12-15 tests (per-provider real-store assertions dominate).
S-25 ~80 lines across 3 endpoints + 10-12 tests.
Canonicalize: comment only, ~15 lines.

Roughly slice 2's size. The per-provider verification for S-22 is the long pole, and it is
the part that should not be cut — it is exactly where this issue has lost time five times.

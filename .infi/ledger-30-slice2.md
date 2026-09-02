# T-5 (#30) slice 2 — G17 context injection (S-21)

Slice 1 closed `performSimilaritySearch`. Two paths still put document text into the prompt
without touching a vector store, so the ACL it built was bypassed for anything reached
through them: `DocumentManager.pinnedDocs()` (no actor, no ACL, at all — 10 call sites) and
`WorkspaceParsedFiles.getContextFiles()` (userId filter applied only when a caller passed
one — 4 call sites).

Ruling Q1 (PMO): pinned documents are filtered with the EXISTING `DocumentAclFilter`, at
one point inside DocumentManager. Calling the engine per document was rejected: a second
definition of "readable" alongside seam 02's, free to drift, plus an N+1 query per chat
turn.

Ruling Q2 (PMO): `document_acl` keys on `document_id` (Int canonical), verified in
schema.prisma — `@@unique([document_id, principal_type, principal_id, action])` — and
`buildDocumentFilter` populates `deniedDocumentIds` with `String(row.document_id)`, so a
pinned row's `documentId` stringifies to match directly. A row whose `documentId` is NULL
(pre-canonicalize) is UNPROVABLE and follows the unlabelled-vector rule: excluded by
default with a log, admitted only under RETRIEVAL_FILTER_ALLOW_UNPROVABLE. "No match found,
therefore allow" is forbidden — that inversion turns an id mismatch into a silent leak
instead of a visible outage.

Ruling Q3 (PMO): `getContextFiles` REQUIRES `user` and throws without one. An optional
security filter is not a filter, it is a filter plus a way to skip it, and it fails toward
returning MORE data — the same shape as #45's optional keyKind. A caller with genuinely no
user passes `{ systemActor: true }` and gets [], never everything.

Ruling Q4 (PMO): the agent paths are IN this slice. An agent acts on behalf of a user and
reads what that user reads; an agent with no user gets a match-none filter. Excluding them
would have shipped a closed front door beside an open side one.

Ruling (found while implementing, not in the brief): the filter is built for
`document.read`, NOT the `retrievalFilterFor` default of `document.search`. A pinned
document is not retrieved by a query — it is injected wholesale — so reading is the action
that governs it. My first RED run passed the default and the deny did not appear in
`deniedDocumentIds`: the filter was present, correctly built, and answering the wrong
question. A filter that enforces the wrong action looks identical to a working one at every
call site.

Ruling: all 10 pinned call sites go through one bridge, `authorizedPinnedDocs`, for the
same reason slice 1 has `authorizedSimilaritySearch` — ten copies of a two-step sequence
fail by one copy missing a step, silently, which is how this path came to bypass the ACL to
begin with.

Note (test-side, worth keeping): a deny written with a raw `prisma.document_acl.create`
does not bump the policy version, and `FilterCache` keys on that version — so the cache
serves a pre-deny filter and the test fails for a reason unrelated to the code under test.
Denies go through `policyRepository.grantDocumentAcl`. That is a realistic production bug
shape too: any write that skips the repository leaves every cached filter stale.

Residual: `document.read` vs `document.search` now matters at every context-injection site.
Any future path that injects document text must pick the action deliberately rather than
inheriting a default.

SHA: 41458cbb (branch approof/t5-slice-2, base 1ed51510)

## Slice 2 — rebase onto f738590e (Techlead-2 blocker + QA-1 mutation survivors)

Ruling (Techlead-2 BLOCKER, my bug): `collectPinnedDocs` takes `actor` as a PARAMETER. It
referenced `streamResponse`'s `actor`, which is not in its scope, so every Telegram chat
threw ReferenceError before reaching retrieval — the channel was down, not degraded.
`node --check` cannot catch this: an undefined identifier is a runtime error, not a syntax
error. Only executing the line finds it.

Ruling: the Telegram test drives the exported handler, not a unit. §7.9 asks for the real
entry point; Telegram has no HTTP route, so the handler IS the entry point. Three attempts
were needed because `stream.js` destructures its imports — `spyOn` on a module object never
reaches the reference the file already holds — and the handler otherwise dies on "No OpenAI
API key" before the fixed line. A test that stops short of the fix proves nothing about it.
Mutation-verified: removing the parameter fails 2 of 3.

Ruling (M3): an explicit allow-list is tested with a pinned document OUTSIDE it. Flipping
the check to allow-all survived mutation before, because nothing exercised the case the
check exists for — a filter that is applied but never tested against its own failing input.
Same class as #41 NIT-1. The empty allow-list is covered too: [] means allow nothing, and
reading it as "no restriction" turns the most restrictive filter into the least.

Ruling (M7): a raw `prisma.document_acl.create` does not bump `policy_versions`, and
`FilterCache` keys on that version — so every cached filter keeps serving pre-change policy
and cannot tell it is stale. Two tests pin both directions. Not a test-only trap: any write
that bypasses the repository leaves a revoked grant effective for the cache TTL. Documented
at the `document_acl` model itself, where someone about to add a raw write will be looking.
No new API — `grantDocumentAcl({effect})` and `revokeDocumentAcl` already bump correctly
(PMO confirmed option ค).

Ruling (M8): one document with ALLOW on `document.search` and DENY on `document.read`. The
read filter excludes it; the search filter — `retrievalFilterFor`'s DEFAULT — lets it
through. This turns the implementation finding into a regression test, and pins the bridge
to `document.read` in its own source, since all ten call sites inherit that choice.

Ruling (Techlead-2 NIT): the dead `allowUnprovable` parameter is removed from
`toWeaviateWhere`. It became dead when refusing the namespace replaced it. A never-false
flag reads like a live decision point and invites a caller to pass it.

Ruling (Techlead-2 NIT, found a real gap): all success returns of
`reportRetrievalFilterSupport` go through one builder. Two of the four hand-written returns
dropped `staleClasses`, and Weaviate always takes one of them — it has no count support —
so a Weaviate deployment reported nothing at all about its unfixable classes. The NIT asked
for a test; the test found the bug.

Ruling (Techlead-2 NIT): `UNVERIFIED_PROVIDERS` is asserted non-empty, so emptying it
cannot silently promote pinecone and astra to "supported".

SHA: (final commit below)

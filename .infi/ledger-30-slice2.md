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

SHA: (below)

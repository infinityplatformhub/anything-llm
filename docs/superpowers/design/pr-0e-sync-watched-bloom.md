# PR-0e — `sync-watched-documents` cross-workspace bloom matches on basename

Status: **hotfix spec, dispatch-ready. Does not wait on P0-5.**
Author: Dev 2 (architect). Date: 2026-09-02. Origin: gap G3 in `p0-5-authorization-recon.md` §5c.

## The defect

`server/jobs/sync-watched-documents.js:156-193`. After re-syncing a watched document, the job fans ("blooms") the new content out to other workspaces:

```js
const moreReferences = await Document.where({
  id: { not: document.id },
  filename: document.filename,   // <-- basename only
});
```

`Document.where` is an unscoped `prisma.workspace_documents.findMany` (`server/models/documents.js:61-76`), and `filename` is the **basename**, not the path: `Documents.addDocuments` sets `filename: path.split(/[/\\]/).pop()` while `docpath: path` keeps the folder (`server/models/documents.js:123-124`).

So the match is on basename across the entire instance. For each row matched, the job runs `deleteDocumentFromNamespace` then `addDocumentToNamespace` on that workspace's namespace (`:177-190`) with the newly fetched content — **no actor, no workspace check, no confirmation that it is the same document.**

Two distinct failures:

1. **Wrong-document overwrite (data integrity + confidentiality).** Two unrelated documents that happen to share a basename — `report.json`, `readme.json`, `index.json`, anything from a connector that names files after the source page — are treated as the same document. Workspace B's document is deleted from its namespace and replaced with the content of workspace A's URL. Workspace B now serves workspace A's content as its own, attributed to B's original filename.
2. **No actor on a cross-tenant write.** Even where the match is correct, the write crosses a workspace boundary with no principal, which seam 02 forbids for jobs.

Severity is (1). It is a live corruption path, not only an authorization gap: the target document's vectors are destroyed, and the replacement is another tenant's content.

## Minimal fix

**Match on `docpath`, not `filename`:**

```js
const moreReferences = await Document.where({
  id: { not: document.id },
  docpath: document.docpath,
});
```

**Do not scope the query to the source workspace.** That was the intuitive fix and it is wrong here. The bloom exists because `updateSourceDocument(document.docpath, …)` (`jobs/helpers/index.js:23-28`) rewrites **one physical file on disk**, which every workspace referencing that same `docpath` reads. Dropping the fan-out leaves those workspaces' vectors stale against changed disk content — which reintroduces exactly the pinned-document/chunk drift that `server/__tests__/jobs/sync-watched-documents.test.js` was written to guard. `docpath` is the identity that matches what was actually rewritten; `filename` is a coincidence.

This is a two-word change and it closes failure (1) completely.

Failure (2) — the missing job actor — is **not** fixed here. It belongs to P0-5 T-4b, which gives jobs explicit actors. Recording the boundary so the hotfix is not mistaken for closing G3: after PR-0e the job still writes across workspaces without a principal, but it can no longer write to the *wrong* document.

## Tests

`server/__tests__/jobs/sync-watched-documents.test.js` already mocks `Document.where` and asserts the bloom fires (two existing cases). Add to the same file, same mock style:

- **Attack case (must be RED before the fix).** `Document.where` mock returns a row with the **same basename but a different `docpath`** — e.g. queue doc `custom-documents/watched.json`, other row `connector-abc/watched.json`. Assert `addDocumentToNamespace` is called **once** (the source workspace only) and never for the foreign namespace. Pre-fix this fails: the current query would have matched it, and the job would call it twice.
- **Regression case.** Other row with the **same `docpath`** in another workspace → still bloomed, still stamped with the same `sourceIdentifier` as the on-disk payload. This is the existing second test, re-pointed at `docpath`; it must stay green so the fix is not a silent feature removal.

Both assert on `mockVectorDatabase.addDocumentToNamespace.mock.calls`, matching the file's existing convention.

## Scope boundary

Touches `server/jobs/sync-watched-documents.js` (one clause) and `server/__tests__/jobs/sync-watched-documents.test.js` (one added case, one amended). No schema, no queue, no middleware. Independent of #4/#5 and of every P0-5 task; no file collision with T-4a/T-4b/T-5.

# Techlead-2 review — #30 slice 2 `78cdbecb` (diff from `f738590e`)

**Verdict: FAIL.** One HIGH blocker: `pinnedDocs` enforces the filter's deny-list but not
its workspace/org scope, so a user can read the pinned documents of a workspace they are
not a member of. Reproduced end to end against real PostgreSQL, and the HTTP reachability
confirmed against the real authorization engine.

Everything from the previous round is closed, and closed well — the Telegram blocker, all
three 1b NITs, and the six QA-1 mutation survivors. The staleClasses bug that surfaced
while consolidating the return builder was a real one and worth the detour.

Independent worktree `/tmp/tl2-s2b` (`git worktree add --detach`), `node_modules`
hardlink-copied from `/tmp/qa1-64`, `prisma generate` run, Node v22.23.1, own PostgreSQL 16
on `:55472`. Probe suites were written into `__tests__/security/authorization/_tl2probe*.test.js`,
run, and deleted; each created and dropped its own database. Worktree clean.

---

## BLOCKER-1 (HIGH) — `pinnedDocs` applies the deny-list without the scope

`DocumentManager/index.js` reads exactly three things off the filter: `matchNone`,
`deniedDocumentIds`, `allowedDocumentIds`. It never consults `workspaceIds`, `orgWide` or
`orgId`. The rows themselves come from `pinnedDocuments()`, which selects on
`workspaceId: this.workspace.id` — the workspace the **request addressed**, not one the
actor has read scope in.

So the effective policy on this path is *"every pinned document in the addressed
workspace, minus the explicit denies"*. The vector path, built from the same filter object,
pushes down `orgId = …` **and** `workspaceId IN (…)` (`vectorPredicate.js:141-145`). The
pinned path is strictly weaker.

### Measured — the leak itself

Two workspaces, one pinned document in B, actor is a `viewer` of A only, no deny row
anywhere:

```
FILTER: {"workspaceIds":["1"],"orgWide":false,"matchNone":false,"denied":[]}
PINNED DOCS RETURNED FOR WORKSPACE B: ["SECRET OF WORKSPACE B"]
```

The filter correctly says "your scope is workspace 1". `pinnedDocs` returns workspace B's
document anyway, in full.

### Measured — it is reachable over HTTP

`POST /workspace/:slug/stream-chat` gates on `requirePermission("chat.send",
workspaceBySlug)` (`endpoints/chat.js:132`), and `validWorkspaceSlug` is explicitly a
loader, not a gate — its own comment says so (`middleware/validWorkspace.js:6-12`). The
question is therefore whether `chat.send` authorizes a non-member for another workspace.
Asked of the real engine, with the org-wide `member` grant the T-1 backfill hands every
legacy user:

```
chat.send on workspace A: allowed=true reason=allowed_by_role
chat.send on workspace B: allowed=true reason=allowed_by_role
```

`member` is an **org**-scoped role (`workspace_id NULL`) carrying `chat.send`
(`prisma/seeds/permissions.js:155`), granted org-wide to every legacy `manager`/`default`
user by migration `20260902020000` and to new users by `legacyRoleGrants`. The engine reads
a NULL-workspace grant as "every workspace". That is deliberate and correct for
`chat.send` — the seed comment explains at length why `chat.read` was kept off this role
for exactly this reason — but it means the slug in the URL is not a scope check.

Chain: mallory (member of A only) POSTs to workspace B's slug →
`chat.send` allowed → `authorizedSimilaritySearch` returns **0 rows** (predicate does its
job) → `authorizedPinnedDocs({workspace: B, user: mallory})` returns **B's pinned documents
in full**, prepended to the prompt and echoed in `sources`. Same shape on `/v1`
(`apiChatHandler.js:302`, `openaiCompatible.js:88`).

This is precisely the asymmetry the slice exists to remove: the filter is present at the
call site, looks complete, and enforces a weaker question than the path beside it.

### Why nothing caught it

`pinnedContextAcl.test.js` uses one workspace, `W1`, for every fixture and every
assertion. There is no cross-workspace case in the file, so no mutation of the scope check
could fail — the check does not exist to be mutated.

### Minimum to lift the FAIL

After fetching rows:

```js
if (aclFilter.orgWide !== true) {
  const scope = new Set((aclFilter.workspaceIds ?? []).map(String));
  if (!scope.has(String(this.workspace.id))) return [];
}
```

plus the org half — `pinnedDocuments` needs to join `documentId` → `documents.orgId` so a
row from another tenant is dropped even when the workspace id collides. RED: actor scoped
to A, pinned document in B, no deny row, expect `[]`. A second case with `orgWide: true`
should still return them, or the fix over-corrects for service principals.

---

## Everything else — closed, and verified

### The Telegram blocker

Fixed as `collectPinnedDocs(workspace, LLMConnector, actor)` with the argument passed at
`:125`. Executed the helper in isolation with a stub bridge:

```
OK, bridge got: {"workspace":{"id":1},"maxTokens":100,"actor":{"type":"telegram","id":"T1"}}
```

No ReferenceError, and the actor arrives intact. The comment above the function records
why `node --check` could not see the original defect, which is the part a future reader
needs.

`telegramPinnedActor.test.js` drives the real `streamResponse` far enough to touch the
line, with the LLM and vector store stubbed. Three tests, and the mocking choices are
correct for the reason stated: `stream.js` destructures `authorizedPinnedDocs` at import,
so a `spyOn` on the module object would never reach it — module-boundary `jest.mock` is
the only thing that works here. The second test pins the *shape* of the fix (the signature
must name `actor`), which stops a future refactor reintroducing an outer-scope read that
happens to pass today. The third re-asserts the W-11 contract that `actor` stays required.

### QA-1 mutation survivors M3 / M3b / M8 / M8b / M7 / M7b

All six are real tests of behaviour, not restatements of the code:

- **M3** exercises an allow-list with a document deliberately *off* it — the case the check
  exists for, which nothing previously covered.
- **M3b** pins `[]` meaning "allow nothing", the single most dangerous misreading available
  in that file.
- **M8** is the best test in the suite. One document, two ACL rows — ALLOW on
  `document.search`, DENY on `document.read` — then it runs the *same* `pinnedDocs` call
  with each filter and shows the search filter lets it through while the read filter does
  not. That proves the action matters through the database rather than by assertion, and
  it directly answers my round-1 observation that nothing exercised the bridge's choice.
- **M8b** pins the bridge source itself, with a stated reason for asserting on source
  rather than mocking (same destructure-at-import problem).
- **M7/M7b** document that a raw `document_acl` write leaves `FilterCache` serving pre-change
  policy for the whole TTL, because only the repository bumps the version. Recording that as
  a passing test — "this is what the wrong path looks like" — is more useful than a comment.

### The three 1b NITs

- **`toWeaviateWhere({allowUnprovable})`** deleted. The replacement comment explains why a
  never-false flag is worse than no flag, which is the right lesson to leave behind.
- **`report()` builder** replaces four hand-written return objects — and consolidating found
  a real bug, not a hypothetical one: two of the four dropped `staleClasses`, and Weaviate
  *always* takes the "cannot count" path, so the stale-class list this codebase computes was
  never actually reported to anyone. That is exactly the drift the NIT predicted, one step
  worse than I guessed.
- **Staleness test** added.

### Prefetch principal reuse — not a leak, but a live functional regression

I flagged this shape in round 1; it resolves as fail-closed, with a cost.

`embed.js:313` calls `resolveProviderConnector` **without a `user`**:

```js
await resolveProviderConnector({
  workspace, prompt: message,
  chatHistoryOverride: embedHistory,
  messageCountOverride: embedMessageCount + 1,
});          // <- no user, no actorRef
```

So `gatherRoutingContext` runs `authorizedPinnedDocs({workspace, user: null})` →
`buildDocumentFilter` returns `matchNoneFilter` (`documentFilter.js:60`) → `pinnedDocs`
returns `[]`. That `[]` is then handed back as `prefetchedContext.pinnedDocs`
(`embed.js:329`), and `embed.js:102` takes it via `??` — which short-circuits the branch at
`:104` that carries the correct `actorRef: {type: "embed", …}`.

Net effect: on a workspace whose `chatProvider` is `anythingllm-router`, an embed gets no
pinned documents at all, and the embed-specific principal the slice added is never used.
Safe direction, but the branch that was written for S-12 is dead on that path, and "no
pinned documents" will read as a content problem rather than a wiring one.

The other three prefetch callers (`stream.js:68`, `agents/index.js:522`,
`ephemeral.js:238`) pass the same `user` they later use, so there is no cross-principal
reuse anywhere.

### Also checked, clean

- Every changed call site references in-scope bindings — I swept all ten for the Telegram
  shape. `telegramBot/chat/stream.js` was the only one, and it is fixed.
- `getContextFiles`'s `{systemActor: true}` escape: the flag is not a column on `users`, no
  request-shaped object reaches that parameter, and a truthy non-user object falls through
  to `userId: undefined`, which narrows rather than widens.
- `documentId === null` returns `allowUnprovable`, not `true`, and logs when the flag is
  off. Both sides of the id comparison are `String()`-normalized against an Int column.
- `maxTokens` accumulation happens after filtering, so the cap can only drop
  already-authorized documents.
- `path.resolve(this.documentStoragePath, row.docpath)` — `docpath` is DB-written at upload
  time and its use is unchanged from before this diff.
- 16/16 in `pinnedContextAcl` + `telegramPinnedActor` on real PostgreSQL, no skips.

## Reproduction

```
git worktree add --detach /tmp/tl2-s2b 78cdbecb
cp -al /tmp/qa1-64/server/node_modules /tmp/tl2-s2b/server/node_modules
cd /tmp/tl2-s2b/server && npx prisma generate
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" STORAGE_DIR=$(mktemp -d) \
       SIG_KEY=aaaa SIG_SALT=bbbb API_KEY_PEPPER=$(openssl rand -hex 32) \
       DATABASE_URL="postgresql://postgres:pw@127.0.0.1:55472/t5"
npx jest __tests__/security/authorization/pinnedContextAcl.test.js \
         __tests__/security/authorization/telegramPinnedActor.test.js --runInBand
```

The two blocker probes created their own databases (`tl2p_*`, `tl2p2_*`), asserted the
outputs quoted above, and were deleted along with their databases.

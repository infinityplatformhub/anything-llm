# Techlead — #61 V9 chat search, `e29d3d84`

Reviewed: `e29d3d84` (Dev5, worktree `.claude/worktrees/v9`, clean tree)
Range: `approof/main...e29d3d84` (recon `6ea03f3f` → impl `258e9978` → fixes `e29d3d84`)
Skill: `security-review` invoked earlier this session (see §hook note in techlead-53).
Verdict: **NOT MERGEABLE AS-IS** — 1 open finding carried from the pre-review, unfixed at this SHA.
Everything PMO listed as a review point passes.

Diffstat: 8 files, +1028/-2 — migration `20260902100000_chat_search_trigram`, `models/workspaceChats.js`,
`endpoints/workspaces.js`, `utils/middleware/requestControls.js`, `schema.prisma`, recon, 2 test suites.

## FINDING-1 (medium, OPEN at e29d3d84) — `response_text` goes stale on chat edit

`workspaces.js:648,654` and `workspaceThreads.js:254,260` write an edited assistant message through
`WorkspaceChats._update`, which is a bare `prisma.workspace_chats.update({where:{id}, data})` passthrough
(`workspaceChats.js:364`). Neither writes `response_text`. The sole writer of the projection is
`WorkspaceChats.new:43`.

Consequence: a user edits an answer to remove text they did not intend to persist. The UI and
`convertToChatHistory` show the corrected text; `response_text` still holds the pre-edit string, so
`GET /workspace/:slug/chats/search` keeps matching it and `workspaces.js:538` (`response: chat.response_text`)
returns the old content verbatim in the API body. The redaction holds everywhere except the surface this PR
adds. The mirror case — new text not findable — is the benign half.

Fix: derive the projection at every writer of `response`, not at one call site. Either handle
`data.response` inside `_update`, or add `WorkspaceChats.updateResponse(id, responseObject)` used by both
edit routes, applying `new`'s rule (`typeof response?.text === "string" ? response.text : null`).

Test that would catch it: edit a chat, then search the OLD string. `chatSearchSelfOnly.test.js` seeds
exclusively through `new` and has no edit case — 466 lines, 16+ tests, none touch either edit route.

## FINDING-2 (nit) — no EXPLAIN/index-scan test exists

`grep -rn EXPLAIN server/__tests__` returns nothing on this tree. PMO listed an EXPLAIN index-scan test as a
review point; it is not in the diff. Without it, a planner that falls back to a sequential scan leaves every
test green. Not a security issue and not a merge blocker on its own — recording it because the review point
was asked for and the artifact is absent.

## Checked and correct

**Migration `20260902100000`**
- `ALTER TABLE ADD COLUMN "response_text" TEXT` + guarded backfill:
  `WHERE pg_input_is_valid("response",'jsonb') AND jsonb_typeof("response"::jsonb->'text')='string'`.
  Correct choice over `GENERATED ... STORED`, and the comment gives the actual reason: a stored generated
  column evaluates the cast for every existing row at migration time and aborts on the first malformed
  value. Malformed values demonstrably exist — `convertToChatHistory` already skips records whose
  `data.text` is not a string. A row that cannot render is not made findable, which is the right default.
- `CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public` (was unqualified at `258e9978`). This is the fix
  that matters for this repo specifically: several suites connect with `?schema=<name>`, which puts that
  schema first on the search_path, so an unqualified `CREATE EXTENSION` installs pg_trgm where the tables
  are not, `gin_trgm_ops` fails to resolve from `public`, and the next statement dies 42704 — leaving a
  failed-migration state that blocks every later migration. The comment also names the sharp edge correctly:
  `IF NOT EXISTS` is schema-blind and will NOT repair a database that already has pg_trgm somewhere
  unhelpful.
- Both GIN indexes use `public.gin_trgm_ops`, matching the pinned install.
- `workspace_chats_user_workspace_idx (user_id, workspaceId, id DESC)` — pre-existing gap, correctly
  attributed in the comment as not V9's bug.
- Privilege: same one the deployment already exercises for pgvector (`CREATE EXTENSION IF NOT EXISTS vector`
  at pgvector/index.js:49). Verified, not asserted.

**`searchForUser` (`workspaceChats.js:95-132`)**
- `userId` required; `if (!workspaceId || !userId) return []`. There is no unfiltered branch to reach —
  structurally different from the `forWorkspaceByUser`/`forWorkspace` pair the route layer picks between on
  a boolean, which is the failure mode this shape avoids. The comment says exactly this.
- `api_session_id: null` + `include: true` — dev-API chats and reset history excluded, asserted by test.
- `beforeId` only ever narrows (`id: {lt}`) inside the same `where`; it cannot escape `user_id`.
- Length bounds enforced in the model as well as the route, so a future caller cannot bypass them.
- `chat.read_others` does not widen. Test asserts it AND guards the premise (`decision.allowed === true`
  for Carol before asserting empty results) — without that guard the test would pass for the wrong reason.
  `e29d3d84` adds `syncLegacyRoleGrant` in the fixture precisely because a raw `users.create` carries no
  grant; that is the §7.7 correction and it is right.

**Input handling**
- q: 2–200 after trim, 400 at the route, `[]` at the model. Floor is justified by the index (a 1-char needle
  has no trigram, so GIN cannot serve it), not by taste.
- `escapeLike` escapes `\ % _` with the backslash FIRST, so it does not re-escape its own escapes. Postgres'
  default LIKE escape is backslash, so no `ESCAPE` clause is needed and Prisma `contains` has nowhere to put
  one — correct reasoning. Test proves `_o` returns nothing and `00%` returns exactly one, which is the
  non-vacuous form.
- Cursor: `Number.isInteger(beforeId) && beforeId > 0`, else 400. Malformed cursor refused rather than
  silently restarting the walk — tested.
- `userFromSession` → 401 when absent; the searching user is never named in the request.

**Data exposure**
- Indexing `response_text` rather than raw `response` is the security-relevant decision here, and it is the
  right one: a trigram index over the raw JSON would match `sources[].title`, surfacing document names the
  searcher may have no access to. `retrieval metadata inside response is NOT searchable` pins it with a
  real `sources[]` payload.
- Cross-workspace and cross-user both asserted with rows that exist and would be returned if the predicate
  were dropped (the RED names the leaked owner, not a crash).

**Route gate** — `[validatedRequest, chatSearchRateLimit, requirePermission("chat.read", workspaceBySlug)]`,
byte-identical to the two existing chat-history reads, so concealment, key binding and the R5 impersonation
blanket all come from the engine unchanged. `chatSearchRateLimit` (60/min, ipKey) is new and correctly
scoped — the neighbouring history reads return a bounded page and need none.

**`chatReadGrantMigration.test.js`** — now tracked (it was untracked at pre-review). Migrate-only, no seed,
which is the right shape: an upgraded instance never re-seeds, so "the seed supplies it" and "the migration
supplies it" are different questions. `migratedChatReadHolders` is captured immediately after
`migrate deploy` and before the idempotency test re-runs the INSERT — without that capture the idempotency
test would repair the state a later test is trying to observe, and the suite would pass on a tree with no
migration at all. Assertion is exact (`toEqual`, not containment) so org `member` cannot creep back in;
that is the #63 leak asserted directly.

## What I did not verify
Did not run the suite (1611/155 reported by Dev5 via PMO; `task.sh check` reported passing). Review is of
the diff and the working tree only.

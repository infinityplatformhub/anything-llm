# Recon — V9 chat history search (#61)

Owner: Dev5. Base `approof/main` @ `3691c5aa`. Migration slot **100000**.

Backlog line (program-backlog.md:44): *V9 | ค้นหาประวัติแชท | P0-2 | 1 cw | ค้นเจอในแชทตัวเอง เร็ว <1s ที่หมื่นข้อความ*

## 1. What exists today

There is **no search of any kind** over chat history. The two read paths are whole-history dumps:

| Route | File | Gate | Model call |
|---|---|---|---|
| `GET /workspace/:slug/chats` | `endpoints/workspaces.js:427` | `validatedRequest` + `requirePermission("chat.read", workspaceBySlug)` | `WorkspaceChats.forWorkspaceByUser(ws.id, user.id)` in multi-user; `forWorkspace(ws.id)` in single-user |
| `GET /workspace/:slug/thread/:threadSlug/chats` | `endpoints/workspaceThreads.js:145` | same + `validWorkspaceAndThreadSlug` | `WorkspaceChats.where({workspaceId, user_id, thread_id, api_session_id: null, include: true})` |

Both funnel through `convertToChatHistory` (`utils/chats/index.js:197`), which parses `response` as JSON and reads `data.text`.

The `/v1` twins already map to the same action in `utils/apiKeySecurity/scopes.js:29,40`.

## 2. The storage shape, and why it decides the design

`workspace_chats` (`schema.prisma:195-209`):

- `prompt String` — the user's message, plain text.
- `response String` — **a JSON blob**, not the assistant's text. `{text, sources[], attachments[], type, ...}`. The readable answer is `data.text`; the rest is retrieval metadata (document names, paths).
- `thread_id Int?` — deliberately **no relation** ("No relation to prevent whole table migration", schema comment).
- `api_session_id String?` — dev-API partitioning. Never shown in the frontend.
- `include Boolean` — soft exclusion.

**The table has no index except the primary key.** Not even `(workspaceId, user_id)`, which every existing read filters on. At today's volumes a sequential scan is survivable; adding a substring predicate on top of it is not.

## 3. Why trigram, not tsvector

This is the load-bearing decision, and it is a language decision rather than a performance one.

PostgreSQL's full-text search segments on whitespace and punctuation before applying a dictionary. **Thai does not put spaces between words.** `to_tsvector('simple', 'ค้นหาประวัติแชท')` yields one lexeme covering the whole phrase, so a query for `ประวัติ` matches nothing. There is no Thai dictionary or segmenter in core Postgres, and no `pgroonga` on the target (checked: `pg_available_extensions` lists `pg_trgm 1.6`, `unaccent 1.1`, `vector 0.8.6` — no `pgroonga`). A tsvector index here would be an index that never matches a Thai query, which is worse than no index because it *looks* like search.

Trigram matching is language-agnostic: it indexes character triples, so a substring query works identically in Thai and English. `gin_trgm_ops` accelerates `ILIKE '%needle%'`, which is exactly the query shape a chat-history search needs.

What is given up, stated plainly: no relevance ranking, no stemming, no phrase proximity. Ordering is by recency (`id DESC`), not by match quality. That is acceptable for "find that thing I said last week" and would not be acceptable for V10's org-wide document search, which is a different issue with a different index.

`CREATE EXTENSION IF NOT EXISTS pg_trgm` needs the same privilege the deployment already exercises for pgvector — `utils/vectorDbProviders/pgvector/index.js:49` runs `CREATE EXTENSION IF NOT EXISTS vector;` against the operator's database, and `pgvector/SETUP.md:20,124` documents it as a setup step. The precedent holds; the requirement is recorded for the O2 installer.

## 4. `response_text`: why a plain column and not an index on `response`

Indexing raw `response` with trigrams would make the search match text the user never saw — document filenames, source paths, and attachment metadata inside the JSON. A query for a colleague's surname would surface chats whose *sources* mention a file with that name. That is both a false-positive problem and a metadata-disclosure problem.

A generated column (`response::jsonb->>'text'`) would be the tidy answer, but the cast is not safe over existing rows: `response` is written by `safeJSONStringify` and read back with a documented tolerance for malformed values (`convertToChatHistory` skips records whose `data.text` is not a string, which means such records exist in practice). A `STORED GENERATED` column would evaluate the cast for every row at migration time and abort the whole migration on the first bad one.

So: a plain nullable `response_text TEXT`, written by the model at insert time from `data.text`, and backfilled in the migration under `pg_input_is_valid(response, 'jsonb')` (PG16+; the target is PG17). Rows whose JSON does not parse get `NULL` and are simply not searchable — a row that already fails to render in the UI does not need to be findable.

## 5. ACL — two layers, and why one is not enough

**Layer 1, the gate (engine).** `requirePermission("chat.read", workspaceBySlug)` — byte-identical to the two existing chat routes. The route names an action and a resolver and decides nothing itself (T-4a contract, `middleware/requirePermission.js`). This buys, for free: 403-vs-404 concealment for non-disclosing reasons, `keyWorkspaceBinding` enforcement (`engine.js:76`), and the impersonation rule (`chat.read` is already in `READ_ACTIONS`, `engine.js:27`, so a view-as-user admin may search but the blanket mutation denial still applies).

**Layer 2, the rows.** The engine does not filter rows for chats — there is no `documentFilter` equivalent for `workspace_chats`. The `user_id` predicate lives in the model, and it is a **required parameter, not an option**. This is the specific shape of the existing bug in `forWorkspaceByUser` vs `forWorkspace`: the route picks between a filtered and an unfiltered function based on `multiUserMode`, so the unfiltered one is one wrong branch away at all times. `searchForUser` takes `userId` as a required argument and returns `[]` when it is absent — the failure mode of a missing user is "no results", never "everyone's results".

`chat.read_others` (held by admins, `engine.js:28`) deliberately has **no effect** in V9. The backlog scopes this to "แชทตัวเอง". Reading other users' chats is V10's problem, where the leak tests are part of the DoD. A test pins this: an actor holding `chat.read_others` still sees only their own rows.

`api_session_id: null` and `include: true` carry over from the existing reads — dev-API chats must not surface in the frontend, and soft-excluded rows stay excluded.

## 6. Query shape

```sql
SELECT id, "workspaceId", prompt, response, thread_id, "createdAt"
  FROM workspace_chats
 WHERE user_id = $1
   AND "workspaceId" = $2
   AND api_session_id IS NULL
   AND include = true
   AND (prompt ILIKE $3 OR response_text ILIKE $3)
   AND ($4::int IS NULL OR id < $4)
 ORDER BY id DESC
 LIMIT 50;
```

Input handling: `q` is trimmed, then required to be 2–200 characters (400 otherwise — a one-character trigram query cannot use the index and would scan the table). `%`, `_` and `\` are escaped before being wrapped in `%...%`, so a user searching for `100%` searches for that string rather than for everything.

Thread attribution (Q4) is one extra `IN (...)` query over `workspace_threads` for the distinct `thread_id`s in the page, not a join — `thread_id` has no relation by design and adding one would be the whole-table migration the schema comment warns off.

## 7. Indexes (migration slot 100000)

```sql
CREATE INDEX workspace_chats_user_ws_idx ON workspace_chats (user_id, "workspaceId", id DESC);
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX workspace_chats_prompt_trgm   ON workspace_chats USING gin (prompt        gin_trgm_ops);
CREATE INDEX workspace_chats_resptext_trgm ON workspace_chats USING gin (response_text gin_trgm_ops);
```

The first index is not strictly V9's — it serves the two existing reads, which have been unindexed since the initial schema. It is here because this is the migration that finally looks at this table's access patterns.

Write cost: two GIN indexes maintained on every chat insert. At chat-message volumes this is the right trade; it is recorded so a future high-volume deployment knows where to look.

## 8. Performance DoD (Q5)

"<1s at ten thousand messages" is a wall-clock claim, and a wall-clock assertion in CI is a flake generator — the same code passes on an idle machine and fails under a parallel test run. So it splits:

- **Asserted, deterministic**: `EXPLAIN` on the search query shows a Bitmap Index Scan over the trigram index, not a Seq Scan. If the index stops being used — a predicate change, a lost extension, a planner regression from a wrong cast — the test goes red for the right reason.
- **Evidence, not assertion**: a 10k-row timing measured locally and recorded in the ledger.

## 9. RED

Drop the `user_id` predicate from `searchForUser` and the leak test must go red: user B's chat containing the search term appears in user A's results. Red for the right reason (§7.9) means the failure is the leaked row, not a crash or a 500.

## 10. Out of scope

- Cross-workspace search → V10 (PMO ruling Q1).
- Searching other users' chats → V10, with leak tests.
- Ranking / stemming / synonyms — trigram gives none, and V9 does not claim them.
- Frontend UI is a separate slice; this issue lands the route, the model, and the migration.

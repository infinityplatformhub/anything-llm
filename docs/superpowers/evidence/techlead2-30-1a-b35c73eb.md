# Techlead-2 review — #30 slice 1a `b35c73eb` (diff from `05e18e79`)

**Verdict: PASS**, with two findings for follow-up and one test-coverage NIT. Neither
finding is a hole in the ACL; both are in the diagnostic and in a provider this round
never executed.

Second reviewer, independent worktree `/tmp/tl2-30` (`git worktree add --detach`),
`server/node_modules` symlinked from `/tmp/wt-30c`, `@lancedb/lancedb` 0.15.0, Node
v22.23.1, own PostgreSQL 16 container `tl2-30-pg` on :55471. Nothing in main or any dev
worktree was touched. Every number below I measured myself; nothing is taken from the
ledger, from QA-2, or from Techlead-1.

---

## The four checkpoints PMO named — all PASS

### (1) `toJsonbSql` reserve-before-push, executed on real pg

`bind()` (`vectorPredicate.js:230-233`) pushes first and returns `startIndex +
params.length - 1`, so the number returned is always the slot the value actually landed
in. It is the only thing that touches `params` — the ordering question the old `next()`
lost to is removed rather than answered.

Executed, not read. `pgvectorJsonbSql.test.js` against `postgresql://…:55471/t5`, real
table, real rows, asserting the ROW NAMES returned:

```
Test Suites: 1 passed        Tests: 9 passed, 9 total
```

**Mutation (my own, not the ledger's).** Restoring the exact old expression
`` `$${startIndex + params.length}` ``:

```
✕ workspace scope returns only the actor's workspace
✕ org-wide grant returns the whole org, not the whole table
✕ deny list excludes the denied document
✕ allow list narrows to the listed document
✕ all four clauses at once
✕ a legacy row is excluded by default
✕ the flag admits the legacy row and nothing else
✕ placeholders are numbered contiguously from startIndex
✕ a non-default startIndex still lines up
Tests: 9 failed, 9 total
```

9/9. The ledger's claim reproduces exactly. The two structural tests
(`placeholders are numbered contiguously`, `a non-default startIndex still lines up`) are
the ones that generalise — they assert the SQL's `$n` set equals the params' index set, so
a future clause added without `bind()` fails without anyone needing to think of the shape.

### (2) `table.schema()` branch — ruling B option (ข)

Correct, and the premise is real. My own probe on lancedb 0.15, table created as
`{id, vector, text}`:

```
WHERE  `orgId` = '1'                            -> THROWS  No field named "orgId". Valid fields are id, vector, text, _distance
WHERE  `orgId` IS NULL                          -> THROWS  No field named "orgId"
WHERE  ((`orgId` IS NULL AND `workspaceId` IS NULL AND `docId` IS NULL) OR (`orgId` = '1'))
                                                -> THROWS  No field named "orgId"
countRows("orgId IS NULL")                      -> THROWS  No field named orgid      (case-folded)
countRows("`orgId` IS NULL")                    -> THROWS  No field named "orgId"    (not folded, still absent)
```

So the escape clause could not have served the tables it exists for, and quoting was never
the lever. `hasAclColumns` (`lance/index.js:~336`) asks the Arrow schema before any
predicate is built, which is the only question that can be answered on such a table.

Flag off → `empty` plus a log naming both the cause and the variable; flag on → the search
runs with no `where()` and `#collect` applies `isRowAllowed` to every row. The predicate is
untouched in both directions, which is the half of ruling B that mattered: post-T-5 tables
keep the strict path.

`#collect` is shared by both branches, so the row check cannot drift into a second, laxer
copy. I checked the legacy branch reproduces the rerank widening and the
`similarityThreshold` / `filterIdentifiers` handling — it does, via the same function.

**Mutations:**

| forced | result |
|---|---|
| `hasAclColumns` → always `true` (schema branch dead) | **5 failed** / 13 |
| `hasAclColumns` → always `false` | **4 failed** / 32 (incl. `lanceRealTableAcl`, `queryAuthorized`) |
| legacy branch serves with the flag unset (`if (false)`) | **1 failed** / 13 |
| `retrievalSupport` drops the `hasAclColumns` guard | **1 failed** / 13 |

Both directions of the branch are load-bearing, and the "always false" mutation is caught
by the *modern*-table suites, which is the assertion that stops the legacy branch becoming
a general loosening.

**The RED comes from the right table.** `lanceLegacySchema.test.js:50-57` creates
`{id, vector, text}` with `createTable` — no ACL columns — and the paired `modernTable()`
has them. This was the specific defect of the previous round's file, and it is fixed.
`test("the raw predicate DOES throw on such a table")` pins the premise itself, so if a
future lancedb stops throwing the branch is revisited rather than left forever.

### (3) `unprovableVectorCount` three outcomes — no silent null

`{unlabelled,total}` / `{unsupported:true}` / `{error:message}`, and the `catch` carries
`error.message` (`retrievalSupport.js:94-98`). Missing-column tables count as 100%
unlabelled via `hasAclColumns` rather than erroring (ruling C). Reporting splits by
outcome: error → `logger.error` with the message, unsupported → `logger.warn`.

**Mutations:**

| forced | result |
|---|---|
| bare `countRows("orgId IS NULL")` (FINDING-2 revert) | **1 failed** / 13 |
| `catch` → `return null` | **2 failed** / 13 |
| `{unsupported:true}` → `null` | **2 failed** / 13 |

The "column absent" vs "column present but NULL" pair QA-2 asked for is present and both
halves count correctly (`unlabelled: 2, total: 2` and `unlabelled: 1, total: 2`) — I ran
them against real tables through `unprovableVectorCount`, not against a mock.

### (4) What the 22 new tests actually prove

All 22 pass on a clean run (`Tests: 22 passed, 22 total`), and the whole authorization
directory is green: **30 suites / 291 tests, 0 failed, 0 skipped**, `--runInBand`.

Both new files are genuinely load-bearing rather than green-for-the-wrong-reason: every
mutation table above is a defect the suite catches, and each one names the behaviour rather
than the implementation. `pgvectorJsonbSql` asserts row names, never `JSON.stringify` —
the thing that hid the placeholder bug. `lanceLegacySchema` opens real tables; a mock has
no Arrow schema and no planner and therefore cannot produce this class of failure at all.

Note for whoever runs these next: `pgvectorJsonbSql.test.js` self-skips without a
`postgresql://` `DATABASE_URL`, and the authorization directory needs `API_KEY_PEPPER`
(≥32 bytes) or 5 unrelated suites fail on a missing pepper. A run reporting "22 passed"
with pg absent has actually run 13.

---

## FINDING-1 (minor, diagnostic) — a fresh pgvector deployment boots with a red ERROR

`unprovableVectorCount`'s pgvector branch queries `approofworkspace_vectors` directly. That
table is created lazily by `updateOrCreateCollection` (`pgvector/index.js:514`), so on a
deployment that has never embedded anything it does not exist yet. Measured against my own
empty pg:

```
ERROR: [authorization] failed to count vectors missing ACL metadata for "pgvector":
relation "approofworkspace_vectors" does not exist. This is a fault in the diagnostic,
not a statement about your data — ...
```

Nothing is wrong there: the correct answer is `{unlabelled: 0, total: 0}`. LanceDB gets
this right — a fresh `STORAGE_DIR` returns `{"unlabelled":0,"total":0}` because
`tableNames()` is simply empty.

The cost is exactly the failure mode ruling C2 exists to prevent, one level up: every new
pgvector install prints a red diagnostic-is-broken line on first boot, so an operator
learns that line is noise, and the real `No field named orgid` case — the one C2 was
written for — arrives at an audience already trained to skip it.

Not a blocker: no security effect, and the fix is small (treat `42P01 undefined_table` as
`{unlabelled: 0, total: 0}`, or probe `to_regclass` first). Recorded so it is fixed in 1b
rather than rediscovered as "the boot error nobody reads".

## FINDING-2 (major, follow-up) — Milvus is claimed supported and has never been executed

`SUPPORTED_PROVIDERS` includes `milvus`, `MilvusDb.queryAuthorized` is wired
(`milvus/index.js:420-462`), and `toMilvusExpr` renders `metadata["orgId"] == '1'` /
`in [...]` / `not exists metadata["orgId"]`. Grepped the whole test tree: the only Milvus
coverage is `legacyRowFlagHttp.test.js:175`, which asserts the rendered string DIFFERS
between flag states, and two `retrievalSupport` tests asserting `{unsupported:true}`. No
test has ever handed a Milvus expression to a Milvus parser.

That is the same shape as the two defects this issue has already produced — LanceDB's
backticks and pgvector's placeholders were both predicates that looked correct, passed a
string comparison, and could not execute. Milvus is the third of the three providers slice
1a claims, and it is the one with no execution evidence at all. `not exists` in particular
is the construct with the least margin: it is version-sensitive in Milvus, and it is only
reachable in the flagged state, so a deployment would meet it exactly when it is already in
its degraded pre-backfill window.

Fail direction is closed (Milvus rejects an unparseable expression rather than ignoring
it), which is why this is not a blocker on 1a. But "supported" should mean "executed once".
Recommend: a real-store Milvus test in slice 1b alongside the five object-DSL providers,
or — if standing up Milvus in CI is not worth it — an explicit residual saying Milvus's
pushdown is rendered but unverified, so nobody reads the boot report's "supported" as
"proven".

## NIT (test coverage) — `every` vs `some` in `hasAclColumns` survives mutation

Changing `ACL_COLUMNS.every(...)` to `.some(...)` leaves all 13 tests green. The shipped
code is right; what is missing is the half-migrated table — ACL columns partially present.
Measured on a table created as `{id, vector, text, orgId}`:

```
WHERE `orgId` = '1'                              -> OK, 1 row
WHERE `orgId` = '1' AND `workspaceId` IN ('7')   -> THROWS  No field named "workspaceId"
```

So under `some()` that table would be called labelled and every real query on it would
throw. Behaviour today is correct and fail-closed in both flag states (I drove
`queryAuthorized` on such a table: flag on → `[]` via `isRowAllowed`, flag off → refused
with the log), but the `every` is untested and a future edit could flip it silently. One
table with a partial schema in `lanceLegacySchema.test.js` closes it.

Second-order: the refusal log for that table says "predates the ACL metadata", which is not
quite what a half-migrated table is. Worth a word once #56's backfill can produce that
shape mid-flight.

---

## Things I checked and found correct, briefly

- **Not a leak, though it looks like one at first.** Flag set + legacy table + an actor
  carrying `allowedDocumentIds` or `deniedDocumentIds`: every row is served, allow-list
  included. I confirmed it with a real embed-shaped filter scoped to `doc-public` on a
  legacy table — both legacy rows came back. This is ruling B/C behaving as written: an
  unlabelled row has no `docId`, so it can be checked against neither list, and the flag's
  whole meaning is "serve rows whose provenance cannot be established". `isRowAllowed`
  returns `allowUnprovable` before the list checks for exactly that reason. Also
  unreachable in production today — no caller passes `allowedDocumentIds`
  (`grep` over `server/` outside `utils/authorization/`: zero hits). Recording it because
  it is the first thing a fifth reviewer will flag, and because #56's backfill must land
  before any embed path starts passing an allow-list.
- `ACL_FIELDS` is one frozen list consumed by all three renderers and by `hasAclColumns`,
  so a renderer cannot check two of three. The all-or-nothing conjunction holds in
  `toSqlString`, `toMilvusExpr` and `toJsonbSql` alike.
- `toJsonbSql`'s escape clause adds no parameters, so `startIndex` accounting is unchanged
  between states — the pgvector call site's `$${3 + constraint.params.length}` for LIMIT
  stays correct in both. Covered by the `startIndex 3` test.
- `hasAclColumns` errs to `true` when `schema()` itself throws. Right direction: a wrong
  `true` yields a failed query, a wrong `false` on a flagged deployment would serve a
  labelled table with no predicate.
- `add()` silently dropping fields absent from the schema reproduces exactly (create
  `{id,vector,text}`, add a row with all three ACL fields → `add()` resolves, schema
  unchanged, field gone on read-back). Correctly out of 1a's scope per ruling D — flagging
  only that #56 cannot be written as an insert-only backfill and needs a schema evolution.

## Reproduction

```
git worktree add --detach /tmp/tl2-30 b35c73eb
ln -s /tmp/wt-30c/server/node_modules /tmp/tl2-30/server/node_modules
docker run -d --name tl2-30-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=t5 -p 55471:5432 postgres:16-alpine
cd /tmp/tl2-30/server
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" STORAGE_DIR=$(mktemp -d) \
       SIG_KEY=aaaa SIG_SALT=bbbb API_KEY_PEPPER=$(openssl rand -hex 32) \
       DATABASE_URL="postgresql://postgres:pw@127.0.0.1:55471/t5"
npx prisma generate && npx jest __tests__/security/authorization --runInBand
```

Probe scripts were written into `server/_p*.js`, run, and deleted; each created its tables
under `mkdtempSync`. The mutations above were applied to a working copy and reverted from a
backup after each run — `git status` in the worktree is clean.

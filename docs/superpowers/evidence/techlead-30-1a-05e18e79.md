# Techlead re-review — #30 slice 1a `05e18e79` (diff from `aa437ade`)

**Verdict: FAIL.** The backtick fix is correct and the real-table test is the right test.
Two defects found by running LanceDB 0.15 directly, both in the same class as the bug this
SHA fixes — a predicate that is right in a mock and wrong against a real table.

All measurements below were taken by me, on `@lancedb/lancedb` 0.15.0 from this checkout's
`server/node_modules`, against real tables.

---

## The two things PMO asked about — both PASS

### OR-unlabelled still matches ruling (ก) in every dialect after the backticks

Yes. `toSqlString` (`vectorPredicate.js:150-154`) now builds the escape clause from the same
`ident()` helper as the strict half, so all three identifiers inside it are backticked too —
which is the half that would have been easy to miss. `toMilvusExpr` (`not exists
metadata["k"]`) and `toJsonbSql` (`metadata->>'k' IS NULL`) are unchanged and correctly
untouched: both address these fields as string keys inside a JSON document, so DataFusion's
identifier folding does not apply. The asymmetry is documented at both `ident()` and
`toSqlString`, which is what stops someone "tidying" it later.

All-or-nothing is intact in all three: one conjunction of three absences, ORed with the
whole strict predicate. No per-field leniency anywhere.

Verified by execution rather than by reading:

```
`orgId` = '1'                                                     -> OK, 2 rows
((`orgId` IS NULL AND `workspaceId` IS NULL AND `docId` IS NULL)
 OR (`orgId` = '1' AND `workspaceId` IN ('7')))                   -> OK, 1 row
`orgId` = '1' AND `docId` NOT IN ('doc-mine')                     -> OK, 1 row
orgId = '1'                                                       -> THROWS  (No field named orgid)
"orgId" = '1'                                                     -> OK, 0 rows   <-- silent
```

The ledger's three-way measurement reproduces exactly. The `NOT IN` deny form parses too,
which the ledger did not claim but which the new test covers.

### The new mock evaluator is not looser than the old one

Not looser. Old:

```js
if (predicate.startsWith("((orgId IS NULL")) { if (unlabelled) return true; return org && ws; }
if (unlabelled) return false;
return org && ws;
```

New:

```js
const lenient = /IS NULL.*IS NULL.*IS NULL/.test(predicate);
if (unlabelled) return lenient;
return String(row.orgId) === "1" && String(row.workspaceId) === "3";
```

Same truth table, one branch instead of two, and the labelled-row path is now written once
so the two states cannot drift. The regex is a fair reading of "contains the three-absence
escape clause": three `IS NULL`s in one predicate is only ever produced by that clause —
the strict predicate has none. It is *stricter* in one respect, since the old `startsWith`
would have accepted a predicate beginning with the clause regardless of what followed.

Worth stating in the file, because it is the thing a future reader will not know: this
evaluator's job is only to answer "does this predicate distinguish the two states". The
question "does this predicate parse" now belongs entirely to `lanceRealTableAcl.test.js`,
and the split is the correct one.

---

## FINDING-1 (blocker) — on a pre-T-5 table the escape hatch throws, and so does everything else

Slice 1a's whole subject is the row written before T-5. Those rows do not live in a table
with null ACL columns; they live in a table whose **Arrow schema has no ACL columns at
all**, because the table was created before the fields existed.

Measured, on a table created as `{id, vector, text, title}`:

```
`orgId` = '1'                                                     -> THROWS (No field named orgId)
`orgId` IS NULL                                                   -> THROWS (No field named orgId)
((`orgId` IS NULL AND `workspaceId` IS NULL AND `docId` IS NULL)
 OR (`orgId` = '1' AND `workspaceId` IN ('7')))                    -> THROWS (No field named orgId)
```

So on exactly the deployment the flag exists for, setting
`RETRIEVAL_FILTER_ALLOW_UNPROVABLE` does not serve those rows — every query throws. Same
failure mode QA-2 just found, in the branch that was added to fix the *previous* version of
this same problem.

The mixed case works, and that is why the test suite is green:

```
table created WITH labelled rows, second row all-null ACL fields
  strict  -> 1 row (labelled)
  lenient -> 2 rows (labelled + legacy)
```

`lanceRealTableAcl.test.js` creates its table from two fully labelled rows, so the schema
always has the columns. The "unprovable-rows escape clause also parses" test therefore
proves the clause parses **against a post-T-5 schema** — it cannot reach the case the clause
exists for. That is §7.9: the green does not name the behaviour.

Worse, and this is the part I did not expect: **`table.add()` silently drops fields absent
from the table's schema.**

```
create table {id, vector, text}
add row {id, vector, text, orgId, workspaceId, docId}
-> add() resolves OK
-> schema unchanged: id, vector, text
-> both rows read back with no orgId
```

So an existing deployment's workspace tables never acquire ACL metadata through normal
ingest. New documents embedded into an old table are written unlabelled, silently, with
`aclMetadataForNamespace` having resolved them correctly and `updateOrCreateCollection`
(`lance/index.js:355-363`) taking the `collection.add(data)` branch. The unlabelled
population grows after T-5 ships, and neither the backfill (#56) nor this flag can help
while the schema stays as it is.

What I am NOT claiming: that slice 1a must solve this. Migrating an Arrow schema is a
`mergeInsert`/rewrite, plausibly its own issue. What slice 1a must not do is ship a flag
that is documented as the pre-backfill escape hatch and that throws on every pre-backfill
table — that is the same "flag does nothing" defect in a new form, one step further along.

Minimum to lift the FAIL, either:

- **(a)** make `toSqlString` tolerate the missing-column schema, and prove it with a test
  whose table is created without ACL columns; or
- **(b)** keep the predicate as is, but have the LanceDB read path detect the pre-T-5 schema
  (`table.schema()` has no `orgId`) and take a defined branch — refuse with a clear reason
  when the flag is unset, serve when it is set — with the schema-drop behaviour of `add()`
  recorded as a residual on #56, since the backfill cannot be written without knowing it.

I lean to (b): (a) invites a predicate that is lenient for the wrong reason.

Either way the RED must come from a table created **without** the ACL columns. Every test in
this file currently creates one with them.

## FINDING-2 (major, same root) — the boot report's count is always "unknown" on LanceDB

`retrievalSupport.js:60`:

```js
unlabelled += await table.countRows("orgId IS NULL");
```

A bare identifier — the exact spelling this SHA fixed everywhere else. Measured:

```
countRows("orgId IS NULL")    -> THROWS (No field named orgid)
countRows("`orgId` IS NULL")  -> 1
```

The throw is swallowed by `unprovableVectorCount`'s outer `catch { return null }`, so on
LanceDB — **the default provider** — the report always takes the `counts === null` branch
and prints "could not count vectors missing ACL metadata". The number the whole module
exists to produce is never produced, and the failure is indistinguishable from a provider
being unreachable.

One-character fix in the same style as the rest of this commit:

```js
unlabelled += await table.countRows("`orgId` IS NULL");
```

Note the fix alone is not sufficient: on a pre-T-5 table this still throws (FINDING-1's
schema case), which is the *only* table where the count would be non-zero. So the count is
still null exactly when it matters, and the branch must handle the missing-column schema —
`table.schema()` answers it directly, and a table with no `orgId` field is 100% unlabelled
by definition, which is a better answer than "unknown".

---

## Everything else in the diff — correct

- `ident()` is applied to all four clause builders in `toSqlString`, including `NOT IN`.
  Nothing bare remains in that renderer.
- The comment at `ident()` records all three spellings and why the double-quote form is the
  dangerous one. That is the right place for it — the next person to touch this reads the
  helper, not the ledger.
- Two live mutation tests (bare must throw; double-quoted must return zero) rather than a
  note saying the mutation was checked once. Correct per §7.9, and they will announce it if
  DataFusion's folding rules change.
- The real-table rows are written through `aclMetadataFor()`, so a field rename breaks this
  test rather than breaking retrieval quietly.
- The `providerDocIdCallSites.test.js` timeout the ledger flags: I did not reproduce it, but
  the reasoning (a `beforeAll` that shells out to `prisma migrate deploy` against a 5s
  timeout) is sound and it is recorded rather than hidden, which is what matters.

## Reproduction

All probes ran from `server/` on Node 22 with this checkout's `node_modules`; each created a
fresh table under `mkdtempSync`. Nothing in the repository was modified. The probe scripts
were deleted after running — they are four `lancedb.connect` + `createTable` + `.where()`
calls and are reproducible from the tables described above.

# Techlead — #61 V9 chat search, `54dcdc34`

Reviewed: delta `e29d3d84..54dcdc34` only (Dev5, worktree `.claude/worktrees/v9`, clean).
Prior verdict on `e29d3d84`: NOT MERGEABLE — FINDING-1 open.
Verdict: **PASS. FINDING-1 is closed, and closed at the right layer.** One NIT.

Diffstat: 6 files, +636/-4 — `models/workspaceChats.js` (+64/-4), `chatSearchSelfOnly.test.js` (+281),
`chatSearchThaiLocale.test.js` (new, 155), `utils/chatSearch/localeSupport.js` (new, 95),
`utils/boot/index.js` (+10), migration `100000` (+31).

## FINDING-1 — closed

Two helpers at the top of the model: `responseTextOf(response)` for the object form, and
`withResponseTextFrom(data)` for a payload whose `response` is already stringified. Applied at all
four write paths — `new:88` (`responseTextOf`), `_update:414` (`withResponseTextFrom(data)`),
`bulkCreate:466` (`withResponseTextFrom(chatData)`), `upsert:497` (`responseTextOf(data.response)`).

The placement is what I asked for and the comment gives the right reason: derived in `_update` rather
than at the two edit routes, because "a rule that lives in the callers is a rule the next caller does
not know about". Both edit routes reach it unchanged; neither route file was touched, which is the
correct shape.

Three details I checked rather than took on trust:
- `withResponseTextFrom` returns `data` untouched when `response` is absent (`hasOwnProperty`, not
  truthiness — so an explicit `response: undefined` still takes the derivation path rather than
  silently skipping it). Without this, flipping `include` or `feedbackScore` would blank the row's
  searchable text as a side effect. Test `an update that does not touch response leaves the searchable
  text alone` pins it.
- Unparseable JSON stores NULL rather than throwing. Correct: failing the update would turn a
  malformed legacy row into an un-editable one, and `convertToChatHistory` already skips such rows, so
  they need not be findable.
- Non-string `text` stores NULL, not `"[object Object]"` — asserted by
  `an edit to a response whose text is not a string stores NULL, not a coerced value`, which also
  searches for `"object"` and expects nothing.

**Two write paths beyond the two I named.** `upsert` is the agent chat-history overwrite
(`utils/agents/aibitat/plugins/chat-history.js`) and `bulkCreate` is the import path. Both are real
instances of the same defect that I did not find; QA-3 did (F2/F3). Each has its own test.

## The scan test — not vacuous, but it does not cover every path

`no write path sets response without deriving response_text` reads the model source, splits on
`prisma.workspace_chats.(create|update|upsert)`, and asserts no 600-char window contains a literal
`response:` without a derivation nearby. It carries its own guard (`literalResponseWrites >= 2`) so an
emptied filter cannot pass silently, plus two literal assertions that the payload-shaped paths are
wired.

I ran the four mutants against the actual regex rather than reasoning about it:

| mutant | scan test |
|---|---|
| `new`'s `response_text` removed | **FAILS** (caught) |
| `_update` reverted to `data` | **FAILS** (caught) |
| `bulkCreate` reverted to `data: chatData` | **FAILS** (caught) |
| `upsert`'s `response_text` removed | **PASSES** (missed) |

The `upsert` gap is structural: its `response:` sits in the `payload` object several lines *above* the
`prisma.workspace_chats.upsert(` call, so the 600-char window that starts at the call never contains
it, and the chunk registers as "no literal `response:`" — nothing to flag. Chunk 8 (`bulkCreate`)
matches `response:` only by coincidence, from the *default parameter* of `upsert`'s signature bleeding
into its window.

This is not a defect in `54dcdc34` — behaviour is correct at all four paths, and `upsert overwriting a
response updates the searchable text` covers it behaviourally. It is a limit on what the scan test
proves, and since that test exists precisely to catch a *fifth* path added later, a fifth written in
`upsert`'s shape (build a payload, then write it) would slip through. See NIT-1.

## F2 — the EXPLAIN test, and why it is per-column

Present, and the reasoning is better than the review point asked for. The comment records a
measurement: at 10k rows the planner picks a Seq Scan and is *right* to — the table is 56kB. So
"the plan contains Index Scan" is a property of table size and statistics, not of the schema, and
asserting it at the DoD's volume would be the flake Ruling Q5 set out to avoid.

What it asserts instead: with `SET LOCAL enable_seqscan = off` inside a `$transaction`, each trigram
index individually serves an `ILIKE` on its own column. Two things right here:
- `SET LOCAL` outside a transaction is a silent no-op, and the EXPLAIN would then return the ordinary
  plan while the test looked like it had forced something. The `$transaction` wrapper is deliberate and
  commented.
- `enable_seqscan=off` does not force an unusable index into a plan; it raises scan cost and the
  planner still refuses an index that cannot answer the predicate. So an index scan here does mean the
  index covers this query shape.
- One assertion per column rather than one on the OR predicate — with both indexes available the
  planner may reach rows through the composite index and filter, which says nothing about the trigram
  index on the other column.

Also `the trigram operator class resolves from the search path` asserts `pg_trgm` is in `public` via
`pg_extension`/`pg_namespace` — pinning the 42704 defect that `e29d3d84` fixed.

## F5 — the Thai/`LC_CTYPE` finding

This is the significant addition and it is a real finding, not a nicety. `pg_trgm` tokenises using
`LC_CTYPE`; on a `C`-locale database — initdb's default with no locale in the environment, and the
usual state of a slim container image — every non-ASCII byte is non-alphanumeric, so Thai yields zero
trigrams. Nothing errors: the index builds, `ILIKE` returns the correct rows, by scanning. Thai search
loses its index in silence, for this product's primary language.

The handling is right on every axis:
- **Detection, not repair.** A database's collation is fixed at creation, so the fix is
  initdb/`CREATE DATABASE` plus a reindex — an operator action a migration must not take behind their
  back.
- **`RAISE WARNING`, not `EXCEPTION`.** Failing would leave an operator with a migration they cannot
  apply and no way forward; English search still works and the rest of the migration is still wanted.
- **Repeated at boot**, so it is not one line lost in migration output.
- **`array_length` of an empty array is NULL, not 0** — handled explicitly (`?? 0`), and the comment
  says why: the C-locale case is exactly the one returning NULL, so reading it as "unknown" would
  invert the finding.
- **The detector's own failure is reported as a fault in the diagnostic**, not as a statement about the
  data — correct, since search returns right answers either way.

The test creates **both** kinds of database (`TEMPLATE template0`, required to pick a differing
locale) and pins the difference. `the planner reaches Thai rows through the index on UTF-8 and by
scanning on C` is deliberately run *without* `enable_seqscan=off`, with the reason stated: forcing the
planner would make it pick the trigram index even on the C database, where the index contains no Thai
trigrams, so the two databases would appear to agree and the finding would be hidden. That is the
opposite convention from the English test in the same PR, and both are right for their own question.
The boot-message test asserts three things an operator needs — what is wrong (`LC_CTYPE="C"`), what it
costs (scans the whole table), what to do (`TEMPLATE template0`) — rather than "it logged".

Residual recorded at `residual-risks.md:111` with the O2 installer as the enforcement owner.

## NIT-1 (mine) — the scan test's window misses the `upsert` shape
Demonstrated above: removing `response_text` from `upsert`'s payload leaves the scan test green. The
600-char window starts at the `prisma.workspace_chats.upsert(` call and `response:` is above it.
Splitting on the enclosing function name, or widening the window backwards from the call, would close
it. Behaviour is correct today and a behavioural test covers `upsert`, so this bounds what the guard
guards, not the fix.

## Everything from the `e29d3d84` review still holds
`searchForUser` has no unfiltered branch; `api_session_id`/`include` exclusions; q 2–200 at both
layers; `escapeLike` backslash-first; `chat.read_others` does not widen (with the premise guarded);
cursor validation; `response_text` indexed rather than raw `response` so `sources[].title` cannot
surface; route gate byte-identical to the existing chat reads. Untouched by this delta.

## What I did not verify
Did not run the suite (1611/155 → Dev5 reports the new counts through PMO). The mutation table above
is mine, executed against the real regex and the real model source. Did not run the migration or the
locale tests — no `DATABASE_URL` in this session.

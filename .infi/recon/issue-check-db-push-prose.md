# `check-db-push` flags `db push` written in a comment

**Type:** bug · **Tier:** plain (a lint gate's matcher; changes what the gate
reports, not what any test asserts or any route decides)

## The claim, measured

`scripts/check-db-push.sh` enforces §7.1a: a test database is built by
`migrate deploy`, never `db push`, because `db push` shapes the schema from
`schema.prisma` without running migration files and so skips every INSERT they
carry — a suite built that way runs against an empty `permissions` table where
the engine answers `unknown_action` for everything, and its tests pass with the
engine deleted.

The gate's matcher does not distinguish a CALL from the same words in PROSE.
Measured on `46eb6256f`:

```
$ git grep -n --untracked -E '"db",[[:space:]]*"push"|prisma[[:space:]]+db[[:space:]]+push|db:push' -- 'server/__tests__'
directorySyncPermission.test.js:422:  // what `prisma db push` + `node prisma/seed.js` produces — the dev-reset path.
directorySyncPermission.test.js:445:      `npx prisma db push --schema ${SCHEMA} --skip-generate --accept-data-loss`,
```

**445 is the call. 422 is a comment.** The gate reports both, and its allowlist
counter prints `2 allowlisted file(s)` for one file with one call.

## This is a known bug that was half-fixed

`27999f906` ("fix(check-db-push): match the call, not the words") already
addressed this once. Its message says T-4a converted five suites to
`migrate deploy` and left comments explaining why, and the loose alternation
matched those comments — "the gate crying wolf about the very fix it asked for".

The fix narrowed `db push` to `prisma[[:space:]]+db[[:space:]]+push`. That
stopped matching T-4a's phrasing, and it still matches any comment that spells
out the full command — which is exactly what a comment explaining the rule tends
to do. The claim in the script ("Match the CALL, not the words") is now stated in
the file and not true of the file.

Worth being precise about the severity: this has never produced a WRONG verdict.
It over-reports, and the over-report is resolved by allowlisting. That is the
actual harm — see below — not a missed `db push`.

## Why it matters more than a cosmetic count

The remedy a developer reaches for is the ALLOWLIST, and an allowlist entry is a
permanent, file-scoped waiver of the rule. A file that mentions `db push` in a
comment and never calls it would be allowlisted to silence the gate — and would
then keep its waiver if someone later added a real `db push` call to it. The
false positive manufactures exactly the waiver that hides a true positive.

The allowlist has one entry today (`directorySyncPermission.test.js`, #138),
which genuinely calls it. The risk is the next entry.

## Proposed fix

Match the call shape, not the phrase. Two options, in order of preference:

**A. Require a process-spawn context on the same line.**

```sh
git grep -n --untracked -E \
  '(execSync|execFileSync|spawnSync|spawn|exec)\(.*(prisma[[:space:]]+db[[:space:]]+push|"db",[[:space:]]*"push")|db:push' \
  -- 'server/__tests__'
```

Catches `execSync(\`npx prisma db push ...\`)` and the argv form
`["db","push"]`; does not catch the words in a comment. Fails on a call split
across lines (the argv array form usually is) — so option B is stricter.

**B. Strip comments before matching.** Feed each file through a filter that
drops `//` line comments and `/* */` blocks, then apply the current regex. More
robust and slower; a shell gate doing this correctly for template literals and
strings starts to want a real parser, which is more than this is worth.

Recommendation: **A**, with B's stripping only if A proves leaky in practice.

## The test this fix requires

A gate change must come with a negative control, or it is a claim (§7.17 —
"a gate that never goes red proves nothing"). Two fixture files, and the gate run
against both:

1. `comment-only` — a file whose ONLY occurrence is `// prisma db push` in a
   comment. Gate must **pass** (exit 0, file not listed). This is the regression
   the fix is for, and it fails on today's matcher.
2. `real-call` — a file with `execSync(\`npx prisma db push ...\`)`. Gate must
   **FAIL** (exit 1, file listed). This is the assertion that the fix did not
   simply make the gate quieter — the most likely way to "fix" this wrong.

Both fixtures must be outside the allowlist, or neither test measures anything.

Add a third if option A is taken: a file with the argv form
`["db", "push"]` split across lines, asserting the KNOWN limitation rather than
pretending it does not exist — a documented gap is a decision, an undocumented
one is a hole.

## Not in scope

`#138`'s allowlist entry stays either way: that file calls `db push` for real, on
purpose, and the entry carries its reason. Fixing the matcher drops its reported
count from 2 to 1; it does not remove the need for the waiver.

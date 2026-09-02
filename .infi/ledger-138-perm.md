# ledger — #138 permission slice (`directory.sync`)

Branch `approof/138-directory-sync-permission` off `approof/main` 624380eca.
Lane: `server/prisma/seeds/permissions.js`, one migration, one test,
`vocabulary-diff` pin. No route change — Dev3 owns the sync-now route and
confirmed in writing he will not touch these files.

## Counts

- RED baseline (seed reverted, migration removed): **7 failed / 3 passed of 10**.
- GREEN: **10/10**.
- `ALL_ACTIONS` dependents — `grep -rln ALL_ACTIONS __tests__` gave 6 files, all
  run: **6 suites, 50/50 green**.

## Mutants — 10 run, all caught

| mutant | red |
|---|---|
| G-a migration drops the super_admin grant INSERT | 2 |
| G-d migration drops the permission INSERT | 4 |
| G-e migration drops the policy_versions bump | 2 |
| G-f grant goes to setup_admin TOO | 2 |
| G-g grant goes to setup_admin INSTEAD | 3 |
| G-h `DIRECTORY_ACTIONS` defined, not spread into `ALL_ACTIONS` | 3 |
| G-i seed grants it to setup_admin as well | 2 |
| G-j action renamed in seed only (seed/migration drift) | 3 |
| A-c engine asked with a wrong actor signature | 2 |

G-h is the one QA-3 asked to be caught by a HOLDER assertion rather than a
literal: with the spread removed, `DIRECTORY_ACTIONS` still contains the string,
so a check against that constant passes while `super_admin.permissions` — which
IS `ALL_ACTIONS` — loses the action. The holder test reads the role, not the
group constant, and goes red.

## Rulings

Ruling: `directory.sync` is its own action rather than a use of `user.manage` —
a run calls `applyDirectoryPlan`, which deactivates every user absent from the
snapshot, and Lark has no delta API so absence is the only departure signal
(applyDirectoryPlan.js:8-12). If wrong, the cost is a role that manages users
also being able to suspend the organisation in one call.

Ruling: setup_admin is DENIED, per TL-1 38287c1cf. #137 widened that role into
system.write/system.read/user.read so it can finish an installation, which
includes configuring the directory provider. Granting it the sync as well would
put "configure the provider" and "fire the run" in one role. If wrong, an
installer has to ask a super_admin for the first sync.

Ruling: the super_admin grant is written as its own INSERT rather than relying on
the CROSS JOIN in 20260902020000:295 — that join covers permissions existing when
it ran. If wrong (i.e. if it were covered), the INSERT is a no-op under
ON CONFLICT. Omitting it is bug #63's exact shape.

Ruling: deny is asserted WITH a super_admin allow control in the same test, per
QA-3 — a wrong actor signature returns `missing_actor` for every question, so a
deny-only assertion passes for the wrong reason. Confirmed by mutant A-c.

Ruling: `ORG_CAPABILITIES` deliberately NOT touched. Dev3's sync-now route gates
on the string with a stubbed grant, and whether the button is client-gated is his
call. If it should appear in the sidebar's capability map, that is a one-line
follow-up in his lane, not this one.

## Residual — the policy_versions pin is merge-order dependent

`POLICY_VERSION_ROWS_AFTER_MIGRATIONS = 12` counts 11 rows from earlier
migrations plus this one. **#137 (20260902140000) adds a twelfth and is not
merged.** When #137 lands ahead of this branch the number becomes 13 and this
test goes red — deliberately. An exact count is the only assertion that can see
one missing row among eleven identical `('grant','org:1')` rows; the cost is that
it must be updated when another migration bumps the version, and that failing is
how the merge order gets noticed rather than silently absorbed.

The same applies to `vocabulary-diff`: this branch pins `ALL_ACTIONS.length` at
**63** (main is 62). #137 also moves it to 63. **Whichever merges second must
change 63 to 64, in both `vocabulary-diff.test.js` and nothing else** — the pin
is a single literal and the suite names it precisely.

## Process note against myself

The first idempotency test split `migration.sql` on `;` and then filtered
comment-only chunks. A `;` inside a comment split that comment into fragments,
which were then executed as SQL — `syntax error at or near "a"`. It read as a
migration defect and was a defect in how the test replayed it. Comments are now
stripped before splitting, and the statement count is asserted (`toHaveLength(3)`)
so a future edit that changes the statement count cannot silently replay the
wrong thing.

---

# Commit 2 — TL-1's column fix, and the defect it uncovered

## What TL-1 asked for

The migration's `INSERT INTO permissions` named only `("action","description")`;
every prior permission migration sets `category`, and 102000 also sets `scope`.
Fixed: `category = 'directory'`, `scope = 'org'`, with
`ON CONFLICT ... DO UPDATE` so a row created by an earlier partial run is
corrected rather than left.

`scope = 'org'` needed a second edit TL-1 did not name: `ACTION_SCOPES` in the
seed is the JS half of that column, and `orgMemberAction.test.js` asserts the two
agree. Setting the column without the map entry turns that test red. Both done.

## The wider defect — different from the one reported

QA-3 reported category = '' for `directory.sync` on a migrate+seed database.
That did not reproduce: measured on a real database, category was already
'directory' on both the migrate+seed and migrate-only paths, and
`count(*) WHERE category=''` was 0.

The real gap is the **seed-only** path (`prisma db push` + `node prisma/seed.js`,
the dev-reset shape), and the column is **`scope`**, not `category`:

```
before: directory.sync | directory | any
        org.member     | org       | any     <-- pre-existing, not mine
after:  directory.sync | directory | org
        org.member     | org       | org
```

`seed.js:34` wrote `category` and never `scope`, so on a seed-only database every
action came out 'any' — including `org.member`, whose entire purpose is that the
engine REFUSES it against a workspace resource. Migrated installs got the right
value from migration 102000, so the two deployment shapes disagreed and only the
migrated one was ever asserted.

Ruling: fixed in `seed.js` for ALL actions via `ACTION_SCOPES`, not just for
`directory.sync`. Scoping the fix to my own action would have left `org.member`
broken on the same path, which is the bug that was actually there. `update:` now
carries the columns too — an upsert that only fixes new rows leaves an
already-seeded database wrong.

## Tests added (16 total, was 10)

- C-a: a `db push` + seed database, asserted SEPARATELY from the migrate-only
  one. Neither existing describe covered it.
- C-b: cross mutants. Seed reverted with migration intact → 3 red (all in
  describe D); migration reverted with seed intact → 4 red (describe C + the
  cross-check). Each path is covered independently.
- C-c: `category === ''` swept across the whole table, on both paths.
- Set equality on `(action, category, scope)` tuples between the two paths.
- `orgMemberAction.test.js`'s scoped-action list now DERIVES from `ACTION_SCOPES`
  instead of pinning one literal entry, so adding a scoped action is one edit.

Negative controls for the column assertions, before accepting them: bare
`(action,description)` → 2 red; wrong category → 2 red; scope left 'any' → 2 red.

Counts: 16/16 on the branch; 12 suites / 144 tests green across every
`ALL_ACTIONS` and `ACTION_SCOPES` consumer.

## Note on tooling

Switched to `/opt/homebrew/opt/node@22/bin/node ./node_modules/.bin/jest` from
`npx` (Dev3's #142 lesson) — `npx` re-resolves to node 26 even when invoked from
node@22's bin. The `execSync` calls INSIDE the test files still use `npx prisma`;
they inherit the parent's environment and ran correctly here, but they are the
same hazard and are worth converting repo-wide rather than file by file.

---

# Scope statement (TL-1 ruling, evidence 6996d7d55): #138 fixed a defect outside its own scope

Stated plainly because it is not visible from the issue title, and a reader who
only sees "add `directory.sync`" would not expect `prisma/seed.js` in the diff:

**#138 fixed a pre-existing defect that belongs to #53, not to #138.**
`prisma/seed.js` wrote `category` and never `scope`, so on any database built by
`prisma db push` + `node prisma/seed.js` — the dev-reset shape, with no
migrations — every permission row came out `scope = 'any'`. That includes
**`org.member`**, the action #53 introduced, whose entire purpose is that the
engine REFUSES it when asked against a workspace resource. At `scope = 'any'`
that refusal never happens: the question is answered instead, and every user
holds an org-wide `member` grant, which the engine reads as matching every
workspace. That is the 044000 shape #53 exists to prevent.

It has been true of every seed-only database since #53 shipped. Migrated installs
took the correct value from migration `20260902102000`, so the two deployment
shapes disagreed and only the migrated one was ever asserted — which is why
nothing caught it.

TL-1 ruled the fix STAYS in #138 rather than being split out. The reasoning I
gave and TL-1 accepted: the fix is three lines in `seed.js`, and splitting it
would ship a seed that writes `scope` for `directory.sync` and not for
`org.member` on the identical code path — half-right on one line, with the
follow-up issue touching the same line again.

## The real check, run with psql against real databases

Not the jest assertions — those are in the suite and could share a wrong
assumption with the code. These are the two deployment shapes built from
scratch and read back with `psql`:

```
seed-only    (db push + seed):        directory.sync|directory|org
                                      org.member|org|org
migrate+seed (migrate deploy + seed): directory.sync|directory|org
                                      org.member|org|org

rows in permissions: 63 on both
category = '' :       0 on both
tuple equality on (action, category, scope), sorted, diffed: IDENTICAL
```

Before the fix, the same command against the seed-only shape returned
`directory.sync|directory|any` and `org.member|org|any` — i.e. the `scope<>'any'`
query returned NOTHING at all, which is the finding.

The 63 tuples are the count on this branch in isolation (62 on main +
`directory.sync`). After the rebase onto #137 it becomes 64; see the merge-order
residual above.

QA-3 independently confirmed PASS on a4f2a5753 with the same seed-only check —
`qa3-138-a4f2a5753.md`, cited here rather than restated.

## Follow-up this leaves open

Anything that already ran `seed.js` before this change still holds the wrong
`scope` for `org.member`. The `update:` branch of the upsert now corrects it on
the next seed run, so a dev box self-heals — but a long-lived database that never
re-seeds does not, and nothing in this branch detects that state. Worth an issue
against #53 rather than widening this one further.

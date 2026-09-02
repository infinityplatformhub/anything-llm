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

# Techlead-1 — #138 permission slice `9445a6716` (auth): **PASS with one required fix**

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist —
privilege escalation via a new action, grant blast radius, duty separation. `infi-lessons` not
invoked.

§7.14: no suite run. Probes are in-process `node -e` and source reads in a detached worktree
(`/tmp/tl-138p` at `9445a6716`, Node 22).

---

## Checklist (a)–(h) from `71a9cbbdd`

**(a) Seed vocabulary — PASS, verified by running.**
```
ALL_ACTIONS len: 63   has directory.sync: true
super_admin === ALL_ACTIONS: true      ← so it gains it structurally
setup_admin has directory.sync: false
```
`DIRECTORY_ACTIONS` is its own category constant flowing into `ALL_ACTIONS`, the `AUDIT_ACTIONS`
shape.

**(b) Explicit `super_admin` grant row — PASS.** `migration.sql:32-39`, with the CROSS-JOIN
reason written out and #63 named as the shape it avoids.

**(c) Both build paths agree — PASS, re-derived independently.** Scanning every `migration.sql`
for inserted actions minus the `sso.issue` deletion: `set equality: true`, `db-only: []`,
`seed-only: []`. (`audit.purge` is absent from both because this branch predates #137 — consistent,
and the reason the rebase is required.)

**(d) `vocabulary-diff` pin 62→63 — PASS**, updated not removed, with the action's reason in the
approved list.

**(e) Timestamp — PASS on this branch** (`20260902150000`, after `130000`, no prefix collision).
**Sequencing note below.**

**(f) `setup_admin` deny with a `super_admin` allow control, asked of the engine — PASS**, and in
**one test** (`:152`), with the reason stated: a deny-only assertion is satisfied by an action in
no role at all, and a wrong actor signature returns `missing_actor` for every question. The
non-vacuity test (`:166`) pins both directions on actions #138 does not touch — so a blanket
`false` or a blanket `true` from `decide` fails.

**(g) `ORG_CAPABILITIES` untouched — PASS**, correct per Dev3's server-only answer.

**(h) No other role gains it — PASS**, and the HOLDER assertion (`:193`) is the right shape:
asserted on the **role's** resolved permission set rather than on the literal, which is what QA-3's
mutant G-h (drop from `ALL_ACTIONS`, keep `DIRECTORY_ACTIONS`) reds.

Beyond the checklist, three things are right that are easy to get wrong: the pinned
`POLICY_VERSION_ROWS_AFTER_MIGRATIONS = 12` rather than `> 0` (seven migrations write an identical
`('grant','org:1')` row, so an existence check survives deleting this one); the idempotency test
asserting that the **permission and grant** counts do not move while deliberately *not* pinning
`policy_versions`, with the reason — a second application is a second invalidation event; and the
migrations-only database, which is the real upgrade path.

---

## FINDING (fix before merge) — the migration omits `category`, so the two build paths write different rows

Measured:

```
seed.js would set category: "directory"      (cat() derives it: seed.js:30)
migration sets category:    ""               (column DEFAULT — not in the INSERT)
```

Every prior permission-inserting migration specifies it — `020000`, `040000`, `041000`, `042000`,
`043000`, `050000` all use `("action", "description", "category")`, and `102000` adds `"scope"`.
**This one is the first to use `("action", "description")` alone.** So a fresh install seeds
`category = "directory"` and a migrated instance holds `category = ""`, for the same action.

`permissions.category` carries an index (`schema.prisma`) and nothing reads it today, so this is
not a live defect — which is exactly why it should be fixed now rather than found later: it is a
silent divergence between the two deployment shapes, and the set-equality test compares **actions
only**, so nothing in the suite can see it. Same class as #137's F-1, one column over.

**Fix: add `"category"` with value `'directory'` to the INSERT.** One line.

While there: consider `"scope"` too. `102000` added the column and the engine enforces it
(`engine.js:166-176` — an `org`-scoped action asked against a workspace resource is a
**contract error**, not a denial). `directory.sync` defaults to `'any'`, so a miswired route that
asked it against a workspace resource would get a decision instead of an error. `'org'` is the
correct scope for it and would make that route bug loud. Not blocking — the route does not exist
yet — but it is cheaper here than in a follow-up migration.

## Sequencing — agreed, and the rebase must redo two numbers, not one

#137 first is right (both claim 62→63 and both write a `policy_versions` row). On rebase:
`vocabulary-diff` becomes **64**, and `POLICY_VERSION_ROWS_AFTER_MIGRATIONS` becomes **13** — the
second is easy to miss because it lives in this file rather than in the shared pin, and the test
comment already flags that adding a version-bumping migration means updating it deliberately.
Re-run the both-directions set equality after the rebase; that is the check that catches whichever
of the two gets forgotten.

## Verdict

**PASS**, conditional on the `category` line. The duty-separation reasoning in both the migration
header and `DIRECTORY_ACTIONS`' comment states *why* `setup_admin` is refused — the role that
configures the provider must not fire the run that suspends the organisation — which is the half a
future regrant will need and the half nobody writes down.

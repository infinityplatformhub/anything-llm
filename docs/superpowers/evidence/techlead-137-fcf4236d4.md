# Techlead-1 — #137 `fcf4236d4` (auth): **REJECT — one line, and it breaks a merged test**

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist —
privilege escalation, authz bypass, audit integrity. `infi-lessons` not invoked here.

§7.14: no suite run. Probes are in-process `node -e` and a throwaway PostgreSQL database in
detached worktrees (`/tmp/tl-137b` at `9c7bcdca3`, `/tmp/tl-137c` at `fcf4236d4`, Node 22).

---

## F-1 (REJECT) — `audit.purge` is in the migrations and NOT in the seed vocabulary, so `t1-authz-migration.test.js:186` fails on merge

Measured. `prisma/seeds/permissions.js` at this SHA:

```
ALL_ACTIONS has audit.purge: false     (length 62, unchanged)
seed super_admin has audit.purge: false
```

`super_admin.permissions === ALL_ACTIONS` (identity, verified), so **the seed grants
`super_admin` every action except the one this issue creates.** The migration grants it; the seed
does not. Those are the two build paths, and they now disagree.

Derived the vocabulary each path produces, scanning every `migration.sql` for inserted actions and
applying `20260902090000`'s `DELETE FROM "permissions" WHERE "action" = 'sso.issue'`:

```
in migrations but NOT in seed ALL_ACTIONS: [ 'sso.issue', 'audit.purge' ]
```

`sso.issue` is expected — it is the retired one `t1-authz-migration.test.js:184` names in
`RETIRED_BY_LATER_MIGRATIONS`. `audit.purge` is not. Simulating that test's assertion:

```
t1:186  actions.filter(not retired) toEqual [...ALL_ACTIONS].sort()  → false
extra in db: [ 'audit.purge' ]
```

**This is a merged test on `approof/main`, not a new one.** Its name is
*"vocabulary table == seed file (single source)"*, and it exists precisely to catch a permission
that reaches the database without reaching the seed. It is doing its job. This SHA cannot merge
green.

**Fix, one line:** `AUDIT_ACTIONS` (`seeds/permissions.js:100`) becomes
`["audit.read", "audit.purge"]`. That flows into `ALL_ACTIONS` (`:120`) and therefore into
`super_admin` (whose list *is* `ALL_ACTIONS`), matching the migration exactly. `setup_admin` has an
explicit literal list and is untouched — measured: `setup_admin` does not contain `audit.purge`
and would not gain it. `audit.read` set this precedent at `20260902050000` and is in the seed;
`audit.purge` is the same shape and should follow it.

## F-2 (also REJECT-blocking, and it is the more interesting one) — block F is named for a claim it does not test

`describe("F: seed and migration agree")` asserts three actions are present in `setup_admin`'s
seed literal and that `audit.purge` is absent from it. That is one role, four strings. **The
direction in which they actually disagree — the vocabulary — is not asserted anywhere**, which is
why a green local run and a red `t1` are both consistent with this file.

This is the §7.9f shape with a title on it: the block's *name* makes the strong claim, its
*assertions* make a weak one, and the name is what a reviewer trusts. A comment that lies is worse
than no comment, and a `describe` string is a comment with a test's authority.

Add to F, after the one-line fix:

```
RF-F2 : the set of actions in `permissions` after `migrate deploy` ALONE, minus
        RETIRED_BY_LATER_MIGRATIONS, equals ALL_ACTIONS exactly — set equality,
        printing both directions on failure
mut   : the current seed (audit.purge in the migration, absent from ALL_ACTIONS)
why   : every assertion in block F today is green under that mutation — it IS
        that mutation. Block E's `actionsOf("super_admin")).toContain("audit.purge")`
        is green too, because it reads the migration-built database. Only a
        seed-vs-database set comparison separates them, and block F is where a
        reader will look for it.
```

Block E already builds a migrations-only database, so this costs no new fixture.

## The migration rename (`120000` → `140000`): **accept, but the stated reason is not the real one**

Measured directly rather than reasoned about. Built a throwaway database with Prisma 5.3.1 (the
pinned version), applied `20260902110000_a` and `20260902130000_c`, then added
`20260902120000_b` and re-ran `migrate deploy`:

```
All migrations have been successfully applied.
_prisma_migrations, a, b, c
20260902110000_a  22:02:44
20260902130000_c  22:02:44
20260902120000_b  22:02:58   ← applied later, no error, no warning
migrate status → "Database schema is up to date!"
```

**So `prisma migrate deploy` applies a new earlier-named migration without complaint.** The
pending-earlier-name concern does not reproduce on the pinned version; the rename was not required
for correctness, and it would be wrong to record it as "we would have shipped a broken upgrade".

Accept it anyway, for a different and real reason: `20260902120000` was already taken by
`groups_external_id_unique`. Two directories sharing a timestamp prefix makes the applied order
depend on the suffix sort — deterministic, but the ordering of two migrations now depends on their
*names*, which nobody thinks of as load-bearing. `140000` removes that. Write **that** in the
ledger, not the deploy-failure story, or the next person renames a migration to avoid a problem
that does not exist.

## What is right, and materially so

- **`audit.purge` on `DELETE /system/event-logs`** (`system.js:1763-1768`) with the reasoning in the comment, and the listing left on `system.read`. The split I ruled for, implemented as ruled.
- **The `super_admin` grant row is explicit** in the migration, with the CROSS-JOIN-ran-earlier reason written out. Without it the route would be gated on an action nobody holds — dead for everyone, the #63 shape. This is the half that is easy to omit.
- **The policy-version bump is in the migration**, with `FilterCache` named as the reason. A running process would otherwise serve pre-grant decisions until TTL — works on a fresh boot, not on a live instance.
- **Block E exists because mutants survived without it.** The comment says so and names them (G-a, G-b): the seed masked the migration completely, so a migration with an emptied action list left the suite green. Building a second, seed-free database is the correct response, and it is also the real upgrade path — existing installs run migrations and do not re-run the seed (confirmed: `docker/docker-entrypoint.sh:74` runs `migrate deploy` and never `seed.js`).
- **`POLICY_VERSION_ROWS_AFTER_MIGRATIONS = 12` is pinned, not `>= 1`.** Seven migrations write a `('grant','org:1')` row; an existence check passes with this migration's INSERT deleted, and the comment records that mutant G-f survived exactly that. Pinning is the only assertion that can see one missing row among identical ones. Correct, and the maintenance cost is named rather than hidden.
- **Non-vacuity is present where it matters**: `chat.read_others` false for the same actor through the same call; `audit.purge` denied to `setup_admin` **and** allowed to `super_admin` in one test; the permission row asserted separately because the engine answers false for a nonexistent action and an ungranted one alike.
- **RF-D is red and not skipped**, with the #121 dependency written into the test. A skip is invisible in a green run — right call.
- **No `role_permissions` query stands in for a decision** in blocks A–D: every allow/deny goes through `engine.authorize` or the mounted route. Block E's two `actionsOf` reads are the deliberate exception and are the existence check, on a database the engine is not attached to. That matches what the file's header claims.

## Verdict

**REJECT on F-1** (one line in `AUDIT_ACTIONS`), **and F-2 before GREEN** — block F must assert the
claim its name makes, on the database block E already builds. Everything else stands; re-verdict is
a re-read of two hunks, not a re-review.

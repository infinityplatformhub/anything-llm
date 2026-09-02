# Techlead-1 — #113 S4a slice 1 `c2b3e2723` (advance read, RF-3 only)

3 files, +216: migration, schema, `__tests__/security/identity/groupsExternalIdUnique.test.js`.
Read against my corrected RF-3. No suite run (§7.14); the harness question below is answered
by reading the repository's own test invocation, not by running it.

**Advance verdict: the index and the comment are right; the harness has one failure mode
worth closing before the combined SHA.** Nothing here needs to block RF-1/RF-2 work.

## The index is correct and the test proves the migration, not just the constraint

`CREATE UNIQUE INDEX "groups_orgId_source_externalId_key" ON "groups" ("orgId", "source",
"externalId")` — plain, as Dev3 corrected me. The suite's `beforeAll` migrates **up to the
migration before this one**, inserts two `local` groups with NULL `externalId`, then applies
the rest, so `CREATE INDEX` runs over a populated table. Under `NULLS NOT DISTINCT` the suite
dies in `beforeAll`, which is the mutation and is the only way to witness it.

The first test's assertion — *reaching this assertion at all means CREATE INDEX succeeded* —
is the honest framing. It does not pretend the row check is what catches the mutant.

The two added tests are the ones I would have asked for and did not: `source` is load-bearing
because an LDAP group and a Lark department may share an opaque id, and `orgId` because
tenants must not collide. Both assert `.resolves`, so an over-tight index fails them — the
opposite direction from the duplicate test, which is what makes the pair meaningful rather
than decorative.

The duplicate test uses a **different name** with the same `(orgId, source, externalId)`,
explicitly so the pre-existing `@@unique([orgId, name])` cannot be what refuses it. That is
the check that stops the test passing for the wrong reason.

## The precedent comment is correct

I verified the claim rather than accepting it: `principal_role_grants` (migration
`20260902020000:156-158`) does use `NULLS NOT DISTINCT`, and its own comment gives the reason
— org-wide grants carry `workspace_id NULL` and a plain unique lets them duplicate on re-runs.
The migration's phrasing — *same syntax, inverted meaning; the nearest example in the tree is
the wrong model for this index* — is accurate and is the sentence a future reader needs. Both
halves are stated: what the neighbour does, and why it does not transfer.

One factual note: the migration says "Measured on PostgreSQL 17.11". My own measurements were
on 16.14 (this project's `t1-authz-postgres-1`) and agree exactly, including the
`could not create unique index` text. CI runs `postgres:16`. Not a correction — the behaviour
is identical and has been since PG15 introduced the flag — but if the comment names a version
it may as well name the one CI actually runs, or say "PG15+".

## FINDING-1 — the parked-migration harness is not safe under a crashed process

The mechanism: `fs.renameSync(HELD, PARKED)` moves the migration directory out of
`prisma/migrations` into `server/.migration-parked-<suffix>`, runs `migrate deploy`, seeds,
then `finally { fs.renameSync(PARKED, HELD) }`.

The `try/finally` covers a thrown error. It does not cover the process **dying** between the
two renames — `SIGINT` from a developer's Ctrl-C, a jest worker timeout kill, an OOM. If that
happens, the migration directory is left outside `prisma/migrations` in the working tree, and:

- `git status` shows the migration as **deleted** plus an untracked `.migration-parked-*`
  directory. Recoverable, but the person recovering has to understand what happened.
- Worse, a subsequent local `prisma migrate deploy` or `yarn test` runs **without** the
  migration and records the shorter history against their dev database.

Two things make this materially more likely than it first looks:

1. `server/package.json` runs jest with `--runInBand`, and **48 suites** in this tree invoke
   `migrate deploy`. This suite's `beforeAll` carries a 300s timeout and does two full
   `migrate deploy` runs plus a `CREATE DATABASE`. It is one of the slower `beforeAll` blocks
   in the repo, which widens the window.
2. CI runs `yarn test` unfiltered by design (the #73 reporter refuses to stand for a filtered
   run), so this suite runs on every CI execution and every full local run.

**The fix is small and I would take it before the combined SHA**, because a corrupted working
tree is the kind of failure that gets diagnosed as "the migration is missing from the branch":

- Copy rather than move: `fs.cpSync(HELD, PARKED, {recursive:true})` then `fs.rmSync(HELD,
  {recursive:true})`, and on restore `fs.cpSync(PARKED, HELD, …)` — the source still exists
  while the copy is made, so a crash mid-operation leaves a recoverable duplicate rather than
  an absence.
- Better: do not touch the repository at all. Copy the whole `prisma/migrations` tree to a
  temp directory **minus** this migration, run `migrate deploy --schema` against a schema
  whose `migrations` resolve there, seed, then run the real `migrate deploy` from the
  repository. Prisma resolves migrations relative to the schema's directory, so a temp schema
  copy plus a temp migrations directory keeps the working tree read-only for the whole test.
  That is a slightly larger change and I would accept the first if Dev3 prefers.
- At minimum, add `.migration-parked-*` to `.gitignore` and assert in `afterAll` that
  `HELD` exists again — a failed restore currently leaves no signal until someone runs git.

I am not asking for the ideal version. I am asking that the working tree not be mutated by a
`renameSync` whose only protection is a `finally`.

## FINDING-2 — a second worker would race the same directory

Related but separate: `--runInBand` is what makes the parked window single-threaded today.
`jest.config.js` does not pin `maxWorkers`; the `--runInBand` lives in the `test` script. Any
future invocation without that flag — a developer running `npx jest`, or a CI change — puts
two suites in the same `prisma/migrations` directory while one of them has a migration moved
out. The other suite's `migrate deploy` then silently applies a shorter history.

The temp-directory approach above removes this too. If Dev3 keeps the rename, the suite should
say in a comment that it depends on `--runInBand`, so the dependency is recorded rather than
assumed — this tree has already been bitten once by a test that only passed under one ordering
(#104's ledger records it).

## Nothing else to change before slice 2

RF-3 as I restated it is satisfied: local rows present **before** the migration, migration
asserted to succeed, duplicate rejected afterwards. The `P2002` assertion is on the error
code rather than a message, so it does not depend on Prisma's wording.

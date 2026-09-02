# Techlead-1 — pre-read: S4b slice 2 (apply + checkpoint), on recon `0cd2a6bd5`

Read: `.infi/recon/recon-s4b-slice2.md`, `utils/authorization/policyRepository.js:23-24`
(`inTransaction`) and `:628-660` (`addGroupMember`/`removeGroupMember`),
`utils/jobs/CoreJobWorker.js:10-29`, `utils/events/index.js:18-33`,
`utils/events/PostgresEventBus.js:18-35`, `utils/jobs/PostgresJobScheduler.js:64`.

The recon adopts my refused-plan ruling with a better argument than the one I gave — mine was
"a run whose destructive half is untrusted has a suspect input"; theirs is *both readings come
from the same enumeration*, which is the mechanism rather than the intuition. §7 (the
fixture-never-reached-the-guard pattern, three times, each caught by a mutant not by reading) is
the most useful thing any dev has written down on this program.

No structural objection. One finding that changes the write path, three notes, and the fixtures.

## FINDING-1 — `addGroupMember` opens its own transaction, so "batch per entity" is already
decided, and slice 2 must not pass it a `tx`

`inTransaction:23-24`:

```js
const inTransaction = (db, fn) =>
  typeof db?.$transaction === "function" ? db.$transaction(fn) : fn(db);
```

`addGroupMember({..., db})` calls it, so passing `prisma` gives one transaction per membership
write — which is what §3 wants. But the same helper means passing a **`tx`** (no `$transaction`
method) silently runs the body *inline in the caller's transaction*, with no error and no sign
at the call site. That is the "batch per run" shape §3 argues against, reachable by accident
from a caller that thinks it is being tidy by reusing a transaction it already has.

The consequence is not just a long lock: every membership change in the run would then publish
into one outer transaction, and `bumpVersion`'s per-change invalidation collapses — the exact
loss §3 names, arriving through the parameter rather than through a design decision.

**Ask for it explicitly in the contract:** slice 2 passes `prisma` (the client), never a `tx`,
to `addGroupMember`/`removeGroupMember`, with the reason written at the call site. And a test:
two membership changes in one apply produce **two** `policy_versions` rows, not one. That test
also happens to be the strongest form of the recon's "membership writes go through the
repository" check.

## N-1 — the outbox assertion needs to be per-change, not per-run

§6 asks for "a `policy_versions` row and an `event_outbox` entry per membership change". Worth
making the counting explicit, because the natural assertion (`event_outbox` is non-empty) is
green under the FINDING-1 collapse. `PostgresEventBus:18-35` keys on `event.eventId`, and
`publishOperationalEvent:19` generates a fresh UUID per call, so N changes must produce N rows —
assert the count equals the number of membership changes in the plan, not that rows exist.

## N-2 — `enumerateDirectory` must not be the only thing standing between a failed run and the
brand; state what it does with a driver that *returns* rather than throws

§2 is right that both halves are required. One gap in the stated design: it says
`enumerateDirectory` "either returns the branded result or throws", which is correct for a
driver that throws. #113's driver does throw — `_enumerate` never returns a prefix, and a
`cursor` is refused. But `enumerateDirectory` should not *assume* that; it is the boundary
between a third-party object and a value the whole safety argument rests on.

Cheap and worth it: after both calls, assert the shape it was promised (`hasMore === false`,
`nextCursor === null`, `principals` an array) before branding, and throw if not. A future
driver — LDAP's, or a mocked one in slice 4 — that returns a partial result without throwing
would otherwise get the brand. The brand certifies provenance, and provenance is only as good
as what the producer checks.

## N-3 — the `coreJobs` witness test should drive the real actor path, not a literal

§3 wants S4b's own test that `coreJobs` can call `addGroupMember`. Make it resolve the actor
the way the runtime does rather than passing `SERVICE_PRINCIPALS.coreJobs` inline:
`CoreJobWorker.claim:14-19` re-resolves `job.actor` through `identityStore.resolveActor` and
**fails the job if the resolved actor is missing or `active === false`**. A test that passes the
constant proves the repository exempts the name; it does not prove the job runtime can still
produce that actor. Those are the two ways directory sync can stop working, and only one of them
is covered by a literal.

## REQUIRED RED FIXTURES

```
RF-1 : a refused plan applies NOTHING — assert zero rows written across users, groups,
       group_members, policy_versions AND event_outbox
mut  : apply the constructive half (create + addMembership + createGroups) when refused
why  : asserting "no deactivations" is green under the mutant, and so is asserting
       "no group_members deleted". The row counts that move under the mutation are
       the CREATE-side ones, so the fixture must have pending creations — the recon's
       own §1 probe shape (60 new principals) is the fixture.
```
```
RF-2 : two membership changes in one apply produce TWO policy_versions rows and TWO
       event_outbox rows
mut  : pass the caller's `tx` to addGroupMember instead of `prisma`
why  : FINDING-1 — the mutant writes the memberships correctly and publishes into one
       transaction, so every "the membership changed" and "an event exists" assertion
       is green. Only the COUNT separates them.
```
```
RF-3 : enumerateDirectory whose SECOND call throws produces no branded value, and the
       first call's principals do not reach diffDirectory as complete
mut  : brand whatever was collected before the throw
why  : a test that only asserts "it throws" is green under a mutant that throws AFTER
       branding and storing. Assert the diff never sees a complete enumeration —
       drive the real diffDirectory and assert deactivate is empty.
```
```
RF-4 : interrupt mid-apply, re-run, converge with no duplicates AND no skipped work
mut  : add run-id bookkeeping that skips a run already seen
why  : the "no duplicates" half alone is green under the skip mutant — skipping
       produces no duplicates either. The discriminating assertion is that the
       UNFINISHED work completes on the second run.
```
```
RF-5 : a refused run and a no-op run are distinguishable in the checkpoint
mut  : record only `completed`, dropping the refusal reason
why  : both runs write nothing, so every row-count assertion is identical between
       them. Only reading the checkpoint separates them — which is what §1's
       "loud refusal" depends on.
```
```
RF-6 : coreJobs resolved through the runtime path (identityStore.resolveActor) drives
       addGroupMember successfully; a deactivated actor row fails the job instead
mut  : tighten isExemptPrincipal (N-3's first failure) — and separately, make
       resolveActor return null
why  : the literal-constant version of this test is green under the second mutation,
       which is the half CoreJobWorker:14-19 actually guards.
```

## On the lock (slice 3, recorded here)

§5's warning that the `pg_advisory_xact_lock` precedent does not transfer is correct and worth
repeating in slice 3's contract verbatim — `PostgresJobScheduler.js:64` takes it inside the
materialize transaction, which is short by construction, and slice 2's apply is deliberately
*not* one transaction. Of the two options, the lock-row-plus-heartbeat is the one that composes
with per-entity batching; a session-level advisory lock held across an apply that spans many
transactions is a connection-lifetime resource guarding a multi-transaction operation, and its
failure mode (connection dies, lock vanishes, second run starts mid-apply) is exactly the case
the lock exists for. Not my ruling to make here, but the asymmetry should be in the contract.

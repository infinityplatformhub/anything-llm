# Recon — S4b slice 3: scheduling, concurrency, and the "sync now" endpoint

Dev 3. **Docs only, no code written.** Depends on #134 (slice 2), held at `f75f39462`.
Written on TL-1's slice-3 ruling: `pg_advisory_xact_lock` inside a short claim
transaction that writes a checkpoint `running` row and commits; concurrency decided by
that row's status + timestamp; a crashed owner leaves a visible stale `running` row.

The ruling is sound and I am not relitigating it. This recon reports what it costs to
build, three things that must be decided before it is, and one finding that may make
most of it unnecessary.

---

## 1. The finding that comes first: the job queue ALREADY does this

Before slice 3 builds a claim protocol, it should be established why the existing one
is not enough — because the shape TL-1 described is, almost line for line, what
`PostgresJobQueue.claim` already implements.

`PostgresJobQueue.js:87-114`, inside one `$transaction`:

- selects candidates that are `pending`, **or** `running` with `leaseUntil < now`
- flips each to `running` with a `workerId` and a `leaseUntil`, guarded by a
  conditional `updateMany` whose `count === 1` is what proves this worker won the race
- returns only the rows it actually claimed

And `CoreJobWorker.run` (`CoreJobWorker.js:35-49`) renews that lease on a timer at
`leaseMs / 2`, in a `finally`-cleared interval — a heartbeat, already built, already
running for every core job.

So the properties TL-1's ruling wants exist one layer down:

| TL-1's requirement | already provided by |
|---|---|
| only one runner at a time | conditional `updateMany`, `count === 1` |
| a crashed owner does not block forever | `leaseUntil < now` makes the row claimable |
| a crashed owner is VISIBLE | `state: running` with a stale `leaseUntil` |
| liveness while work continues | `queue.heartbeat` at `leaseMs / 2` |

**The gap is real but narrower than "S4b needs a lock".** `leaseMs` is hardcoded to
30_000 in `JobRuntime.tick` (`JobRuntime.js:41`), and a directory sync of a large org
runs far longer than 30s. The heartbeat renews it — but only while the process lives,
which is exactly the crash case. So the honest statement of the problem is not "there
is no mutual exclusion", it is **"the existing lease is tuned for 30-second jobs and
S4b is not one"**.

That reframes slice 3's first question from "which lock?" to **"can the sync run as a
core job with a longer lease, and if not, precisely which property does the queue
fail to provide?"** I do not think a second, parallel claim protocol living in the
directory-sync module should be built until that question has a written answer —
two mechanisms deciding who may run is how they disagree.

I am not overriding the ruling on this; TL-1 may have a reason I cannot see from the
code. But building it without recording this is how the duplication becomes permanent.

## 2. What the ruling costs in slice 2's schema

**TL-1's shape requires a migration, and it changes something #134 just pinned.**

`directory_sync_checkpoints` has a CHECK constraint admitting exactly three statuses:

```sql
CHECK ("status" IN ('completed', 'refused', 'failed'))
```

A `running` row is a fourth. It also breaks the second constraint's assumption: the
paired CHECK says a reason is present exactly when status is `'refused'`, which a
`running` row satisfies (it has no reason), so that one survives — but `finishedAt`
is `NOT NULL DEFAULT CURRENT_TIMESTAMP`, and a `running` row has not finished. It
would carry a finish time that is a lie, and every "when did the last sync finish"
query would read it.

So the migration is: add `'running'` to the status CHECK, and make `finishedAt`
nullable with a paired CHECK that it is NULL exactly when status is `'running'`. That
is a small, honest change — but it must be a MIGRATION, not an edit to #134's file,
because #134 will have merged. Editing an applied migration is the failure mode where
a fresh database and an upgraded one have different schemas.

**Consequence worth stating plainly:** the checkpoint stops being purely a record of
what happened and becomes partly a lock table. Those are different jobs — one is
append-only history, the other is mutable current state — and merging them means
every reader of the history must now filter out in-progress rows. Every query in
slice 2's comments ("what did the last run do?") becomes "what did the last
*finished* run do?". That is a real cost and I would rather it be chosen than
discovered.

## 3. Three things the ruling does not settle

1. **What makes a `running` row stale?** The ruling says a crashed owner leaves a
   visible stale row and operators see it. Visible is not the same as recovered: does
   the NEXT run refuse to start (safe, but one crash blocks syncing until a human
   acts), or does it take over after a timeout (recovers itself, but needs exactly the
   expiry rule the lock-row-plus-heartbeat design was rejected for needing)? This is
   the question that decides whether the design is simpler than what it replaced.
2. **What advisory lock KEY?** `PostgresJobScheduler.js:64` uses the bare integer
   `1_347_579` with no comment on where it came from. A second hardcoded constant that
   silently collides with it would serialise directory sync against schedule
   materialisation — no error, just two unrelated things taking turns. If slice 3 adds
   one, the two constants belong in one named place.
3. **Is the lock per provider or global?** `directory_sync_checkpoints` is keyed
   `(orgId, provider)`. Two providers (lark and ldap) syncing concurrently is
   plausible and probably fine; the same provider twice is not. A single global key
   makes them wait on each other for no reason; a per-provider key needs the key
   derived from the provider name, which is a hash, which is a collision question.

## 4. The rest of slice 3

Smaller, and unblocked by the above:

- **Scheduling.** `registerCoreSchedules` (`handlers.js:22-33`) is the existing
  pattern — one `queue.schedule` call with a cron and a `systemActor`. A
  `directory.sync@1` handler alongside `retention.purge@1` is a few lines, and would
  put the sync on the same actor-resolution path #134's RF-6 already tests.
- **"Sync now".** An admin endpoint that enqueues rather than executes, so the
  request returns immediately and the run is subject to the same concurrency rule as
  the scheduled one. Executing inline would be a second way to start a sync, which is
  the thing the whole slice exists to prevent.
- **Alerting on a refusal.** #134 made a refusal loud in the database; nothing reads
  it yet. This is what §R5's "a refusal nobody sees is an outage with extra steps"
  was pointing at, and it is where `refusedReason` finally earns its column.

## 5. Evidence contract I would propose

- **Two concurrent runs do not interleave** — the acceptance test. Start two applies
  against the same provider and require exactly one to do the work, with the counts
  proving it: the loser applies NOTHING, not "the same thing twice harmlessly". A
  reconciler that is merely idempotent passes a weaker version of this, which is why
  the assertion is on the loser's checkpoint, not on final state.
- **A crashed owner does not block forever** — kill the winner mid-run, then require
  the next run to reach a decision (whichever §3.1 rules). Mutant: never expire the
  claim; the test must fail, or the expiry rule is untested.
- **A stale `running` row is distinguishable from a live one** — the operator-facing
  half of the same property, and the reason `running` is being added to a table whose
  purpose was history.
- **The advisory key does not collide with the scheduler's** — a source-level
  assertion that the two constants differ, in the same file that defines them.
  Cheap, and the failure it prevents is silent.
- **The status CHECK still refuses a typo'd status after `running` is added** — the
  migration widens an enum-by-constraint, and widening is exactly when someone
  replaces the list with nothing.

Mutation testing is the bar (§7.9). Carried forward from #134, where five mutants
survived the first suite: every fixture must sit where the named guard is the only
thing that can decide the outcome. For concurrency that is harder than usual —
a test where the two runs never actually overlap passes no matter what the lock does,
so the overlap itself has to be asserted, not assumed from timing.

## 6. Evidence

- Existing claim protocol: `PostgresJobQueue.js:87-114`, read directly.
- Existing heartbeat: `CoreJobWorker.js:35-49`; `leaseMs: 30_000` hardcoded at
  `JobRuntime.js:41`.
- Advisory lock precedent and its bare constant: `PostgresJobScheduler.js:64`.
- Schedule registration pattern: `handlers.js:22-33`.
- The status and `finishedAt` constraints slice 3 must migrate:
  `server/prisma/migrations/20260902130000_directory_sync_checkpoint/migration.sql`.

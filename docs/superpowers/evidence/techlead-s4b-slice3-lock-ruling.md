# Techlead-1 — S4b slice 3: lock ruling, on recon `cb9b42f86`

**Skills invoked:** `requesting-code-review` (design read of the recon and the job runtime);
`security-review` checklist applied to the concurrency question (two concurrent syncs are an
authorization-correctness failure, not just a data race). `infi-lessons` not invoked — no §7.17
line added here.

Read: `utils/jobs/PostgresJobQueue.js:87-115` (`claim`) and `:178-184` (`heartbeat`),
`utils/jobs/CoreJobWorker.js:10-45`, `utils/jobs/JobRuntime.js:41`,
`utils/jobs/PostgresJobScheduler.js:64`, `prisma/schema.prisma:665-686`.

## The recon is right, and it makes my previous ruling obsolete

I ruled "rung-0 advisory lock in a short claim transaction, plus a `running` checkpoint row".
Dev3 points out that `PostgresJobQueue.claim` **already is** that shape, and measured against the
source they are correct:

```js
// :102-109
const result = await tx.jobs.updateMany({
  where: { id: job.id, OR: [{state:"pending"}, {state:"running", leaseUntil:{lt: now}}] },
  data: { state:"running", workerId, leaseUntil, attempts:{increment:1} },
});
if (result.count === 1) claimed.push(...)
```

A conditional update whose `count === 1` is the claim; a lease with an expiry; and
`CoreJobWorker.run:34-38` renewing at `leaseMs/2` through `heartbeat`, which itself re-checks
`workerId` and `leaseUntil > now` and throws `LeaseLostError` if the lease was stolen. That is a
complete, tested, already-shipped lease protocol.

**Ruling: S4b sync is a core job. Do not build a second mechanism.** My `running` checkpoint row
would have been a lease reimplemented next to a working one — the same objection I raised against
the heartbeat-table proposal, which I did not notice applied to my own replacement. Two lock
mechanisms in one system is worse than either alone, because the one that is not the job queue's
will drift out of maintenance.

This also collapses the migration Dev3 flags: no `running` status, no `CHECK`, no
`finishedAt NOT NULL DEFAULT now()`. The checkpoint stays a **record of what happened**, and
concurrency is the queue's problem. That separation is worth stating in the contract, because the
checkpoint's shape currently invites the other reading.

## The lease length is the real question, and 30s is wrong for this job

`JobRuntime.js:41` hardcodes `leaseMs: 30_000` in both the `claim` and the `run` call. For S4b
that is far too short as a *claim* horizon and irrelevant as a *liveness* horizon, and those are
two different things worth separating:

- **Liveness is already handled.** The heartbeat renews every 15s for as long as the process is alive, so a 3-hour apply holds its lease fine. The 30s value is not a deadline on the job; it is how long a dead worker's job stays unclaimable.
- **That second meaning is the one that matters here.** If the sync process dies mid-apply, another worker picks the job up 30 seconds later and starts a second apply while the first one's writes are still settling — or worse, while the first process is alive but stalled (a hung HTTP call to Lark, which is precisely what this driver does a hundred times per run).

**Recommendation: give S4b its own lease, and make it a property of the job type rather than of the runtime.** `JobRuntime.js:41` passing one constant for every handler is the actual defect the recon found; S4b just makes it visible. A per-type lease (a map beside `handlers`, defaulting to 30s) is a small change and it stops the next long-running job from rediscovering this.

I would not pick the number here — it depends on the largest expected org and the driver's own
timeouts, which slice 3 will know. What the contract should say: **the lease must exceed the
longest plausible stall in a single driver call, not the length of a run** (the heartbeat covers
the run), and the choice must be written down with its reasoning.

## Stale rule: take over, do not refuse — the queue already decides this

`claim:94,105` treats `state:"running"` with `leaseUntil < now` as claimable. So takeover is the
existing behaviour and S4b inherits it. **Do not add a refuse-on-stale rule**, for two reasons:

1. Refusing means a crashed worker blocks all future syncs until a human intervenes. For a directory sync that runs on a schedule, that is an outage with a silent onset — nobody notices sync stopped until something downstream is wrong.
2. Takeover is *safe here specifically* because #133/#134 made the apply idempotent by construction: the second run re-derives the plan from current state, finds the first run's writes applied, and produces the remainder (RF-4 pins exactly this). Takeover on a non-idempotent applier would be dangerous; on this one it is the correct recovery.

That second point is worth writing into the contract, because it is a dependency: if a future
change makes the apply non-idempotent, the takeover rule becomes unsafe and nothing about the
queue would say so.

## Advisory key: not needed, and the bare constant is a separate small issue

With the sync as a core job, no advisory lock is required at all — `PostgresJobScheduler.js:64`'s
lock guards *materialization* (turning schedules into job rows), which S4b uses unchanged.

Two things worth doing anyway, neither in slice 3's critical path:

- **`1_347_579` is uncommented.** A bare magic number that must not collide with any other advisory key in the system, and nothing says what it is or that it is a namespace. One comment.
- **Materialization already dedupes** by `@@unique([type, idempotencyKey])` (`schema.prisma:685`) with the key built as `${schedule.id}:${runAt.toISOString()}`. So two schedulers cannot enqueue the same run twice regardless of the lock. Worth confirming S4b's schedule uses that path rather than enqueueing directly, which would bypass the dedupe.

## Per-provider or global: **per-provider**

A sync for Lark and a sync for a future LDAP directory touch disjoint `identity_links` rows and
different groups; serialising them buys nothing and makes a slow Lark tenant delay everyone.
With the job-queue framing this is nearly free: make the provider part of the job `type` (or of
the idempotency key), and the queue's per-row claim gives per-provider exclusion automatically.

The one caveat: two providers **can** collide on a shared user — the Q4 case, where Lark and LDAP
both claim one person by email. That is a real conflict and it is not a locking problem; it is the
matching rule, which slice 4 owns and Q4 has not answered. Locking globally would hide it rather
than solve it, and would hide it in a way that makes the eventual Q4 test harder to write.

## Summary for the contract

1. S4b sync is a core job; no second lock mechanism, no `running` checkpoint status, no migration.
2. Lease length becomes per-job-type; S4b's exceeds the longest plausible single-driver-call stall; the number is written down with its reasoning.
3. Stale leases are taken over, not refused — and the contract records that this is safe *because* the apply is idempotent, so the dependency is visible.
4. Per-provider exclusion via the job type / idempotency key; global locking is rejected, and the cross-provider identity collision is named as Q4's, not slice 3's.
5. Separately and not blocking: comment `PostgresJobScheduler.js:64`'s advisory key.

# Contract — S4b slice 3: scheduling, concurrency, and "sync now"

Dev 3. Depends on #134 (merged, `825139ce6`). Written on TL-1's lock ruling
`885f339df` (`docs/superpowers/evidence/techlead-s4b-slice3-lock-ruling.md`), which
withdrew the claim-row proposal and accepted the core-job reframe from recon
`cb9b42f86`.

**Tier: auth.** Two concurrent syncs are an authorization-correctness failure, not
just a data race — the apply path writes grants-bearing group membership.

**Q4 is not touched.** Cross-provider identity collision is slice 4's, and §5 states
why locking must not hide it.

---

## R1. The sync is a core job. No second lock mechanism.

`PostgresJobQueue.claim` (`PostgresJobQueue.js:87-115`) already is the shape the
earlier ruling described: a conditional `updateMany` whose `count === 1` is the claim,
a lease with an expiry, and `CoreJobWorker.run:34-38` renewing at `leaseMs / 2` through
`heartbeat`, which re-checks `workerId` and `leaseUntil > now` and throws
`LeaseLostError` if the lease was stolen.

**So slice 3 builds no lock, no `running` checkpoint status, and no migration.** The
checkpoint stays what #134 made it: a record of what happened. Concurrency is the
queue's problem.

Write that separation into the module, because the checkpoint's shape invites the
other reading — it has a `status` column, and adding `running` to it is the obvious
wrong turn for the next person.

## R2. The lease becomes per-job-type, and S4b's number needs a prerequisite

`JobRuntime.js:41` passes one hardcoded `leaseMs: 30_000` for every handler, to both
`claim` and `run`. That constant is the defect; S4b only makes it visible.

**Deliverable: a per-type lease map beside `handlers` (`handlers.js`), defaulting to
30s**, so the next long-running job does not rediscover this.

The two meanings of the lease must be separated in the comment, because they pull in
opposite directions:

- **Liveness** is already handled — the heartbeat renews every `leaseMs / 2` for as
  long as the process lives, so a 3-hour apply holds its lease.
- **The claim horizon** is what the number actually sets: how long a DEAD worker's job
  stays unclaimable. So the lease must exceed the longest plausible stall in a SINGLE
  driver call, not the length of a run.

### R2a. The prerequisite TL-1's rule exposes: there is no fetch timeout

"Longest plausible single-call stall" is currently **unbounded**, and that makes the
lease number unwritable rather than merely hard to pick.

`LarkIdentityProvider._page:148-161` forwards a `signal` to `_fetch`, but the signal is
optional and **no production caller supplies one** — `listPrincipals`/`listGroups` pass
`input` straight through, and nothing constructs an `AbortController`. Grep for
`AbortSignal`/`timeout` in that file returns only the backoff `setTimeout`. Its retry
loop covers a *dropped socket* (`_backoff`, max 2s, `DEFAULT_MAX_RETRIES = 3`) but a
socket that stays open and never answers is not a dropped socket: it waits forever.

**So slice 3 sets a request timeout on the driver's fetch before choosing a lease**,
and the lease is then derived from it and written down with the derivation:

```
lease > (per-request timeout x (maxRetries + 1)) + backoff total, with headroom
```

That is a real number rather than a guess, and it is the only way the contract's own
rule ("exceed the longest plausible stall") can be satisfied rather than asserted.

**If the timeout turns out to belong to S4a's driver rather than slice 3**, that is a
legitimate split — but then slice 3 blocks on it rather than picking a lease against
an unbounded stall, and says so.

## R3. Stale leases are taken over, not refused — and that depends on idempotency

`claim:94,105` already treats `state: "running"` with `leaseUntil < now` as claimable,
so takeover is inherited, not chosen. **Do not add a refuse-on-stale rule:** a crashed
worker would then block every future sync until a human intervened, and a scheduled
sync that silently stops is an outage with no onset.

**Contract requirement, and the reason this is written rather than left implicit:**
takeover is safe here *because* the apply is idempotent by construction — the second
run re-derives the plan from current state and produces only the remainder (#134 RF-4,
and RF-4b for the applier's own idempotency). That is a DEPENDENCY, not a property of
the queue. If a future change makes the apply non-idempotent, takeover becomes
dangerous and nothing in the job runtime would say so.

State it in the handler, next to the code that would break.

## R4. Per-provider exclusion, through the job type or idempotency key

A Lark sync and an LDAP sync touch disjoint `identity_links` rows and different groups.
Serialising them buys nothing and lets a slow tenant delay everyone.

Make the provider part of the job `type` (or of the idempotency key); the queue's
per-row claim then gives per-provider exclusion for free, with no lock to write.

**The caveat is named, not solved:** two providers CAN collide on a shared user — the
Q4 case, where Lark and LDAP both claim one person by email. That is the matching rule,
which slice 4 owns. Global locking would hide it, and hide it in the way that makes
Q4's eventual test harder to write.

## R5. Scheduling goes through materialization, not a direct enqueue

`registerCoreSchedules` (`handlers.js:22-33`) is the existing pattern — a
`queue.schedule` call with a cron and the system actor, materialized by
`PostgresJobScheduler.materialize`.

That path dedupes on `@@unique([type, idempotencyKey])` (`schema.prisma:685`) with the
key built as `${schedule.id}:${runAt.toISOString()}`, so two schedulers cannot enqueue
one run twice **regardless of the advisory lock**. A direct `enqueue` bypasses that
dedupe, which is the whole protection.

## R6. "Sync now" enqueues; it never executes inline

An admin endpoint that enqueues and returns, so a manual run is subject to exactly the
same claim rule as the scheduled one. Executing inline would be a second way to start a
sync — the thing this slice exists to prevent — and it would run outside the lease, so
nothing would stop it racing the scheduled run.

The idempotency key must make "sync now" distinguishable from the scheduled run without
letting a button-mashing admin queue ten of them.

## R7. Not blocking, done here because it is one line

`PostgresJobScheduler.js:64` uses a bare `1_347_579` as its advisory key with no
comment. It must not collide with any other advisory key in the system, and nothing
says so. One comment naming it as a namespace.

---

## Evidence contract

- **RF-1: two concurrent runs do not interleave.** Exactly one does the work; the
  loser applies NOTHING. Assert on the LOSER (its checkpoint, or its absence), not on
  final state — a merely idempotent applier passes a final-state assertion while both
  runs wrote. **The overlap itself must be asserted, not assumed from timing:** a test
  where the two runs never actually overlap is green whatever the claim rule does.
  This is the trap this issue's fixtures are most likely to fall into.
- **RF-2: a crashed owner's job is taken over after the lease expires, and the takeover
  CONVERGES.** Not just "is claimable" — the second run must finish the outstanding
  work, which is what makes takeover safe rather than merely possible.
  Mutant: make the lease never expire → the work is stranded.
- **RF-3: the per-type lease is actually used.** S4b's job claims with its own lease,
  not 30s. Mutant: drop the map and fall back to the constant; a test asserting only
  "a lease exists" stays green, so the assertion is on the VALUE.
- **RF-4: two providers sync concurrently without excluding each other**, paired with
  RF-1's same-provider exclusion. Without the pair, a global lock passes RF-1 and the
  per-provider ruling is untested.
- **RF-5: the schedule goes through materialization** — two materialize calls for one
  `runAt` produce ONE job row. Mutant: enqueue directly, bypassing the unique.
- **RF-6: "sync now" enqueues rather than executing**, and a second click while one is
  running does not start a second apply.
- **RF-7: the driver's fetch has a bounded timeout** (R2a), with the lease derived from
  it. Mutant: remove the timeout → a hung call stalls past the lease, which is the
  precondition for a duplicate apply.

Mutation testing is the bar (§7.9): every guard needs a named mutant killed by a named
test, and survivors are recorded with whether they were reachable.

**Carried forward from #134**, where five mutants survived the first suite and every one
was a fixture that never reached the guard it named: the fixture must sit where the
named guard is the only thing that can decide the outcome. For concurrency that is
harder than usual, which is why RF-1 asserts the overlap rather than trusting a sleep.

## Out of scope

- Identity matching, `identity_links` re-pointing, cross-provider collision — slice 4,
  Q4-blocked.
- Alerting on a refusal. #134 made refusals loud in the database and nothing reads them
  yet; that is a consumer, and it wants a decision about where operators see it.

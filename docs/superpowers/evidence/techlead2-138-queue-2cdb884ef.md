# Techlead-2 security review — #138 queue half `2cdb884ef`

**Skills invoked:** `security-review` (auth tier as dispatched — a claim seam in the
authorization-adjacent job runtime, and a lease that decides whether two workers can apply
a directory sync at once). `requesting-code-review` does not resolve by name in this
session (`Unknown skill`, bare and `superpowers:`-namespaced), so the reviewer template
was read from disk. No `infi-lessons` line.

TL-1 did the code read; this is the threat model on the three questions asked. Worktree
`/tmp/tl2-138q`, own scratch database `t138q`. **Baseline 9 passed, 9 total.** Tree clean;
probe removed.

**Summary: no exploitable finding in the seam. One real gap — a lost lease does not stop
the in-flight handler, so takeover CAN run two applies concurrently. Measured, not
argued.** That is a pre-existing property of `CoreJobWorker.run`, not something
`2cdb884ef` introduces, but this is the slice whose stated purpose is preventing a
concurrent apply, so it belongs in this review rather than a later one.

---

## Q1 — Can the test-only seam be reached in production? Is a source assertion sufficient?

**Not reachable, and the source assertion is sufficient here — for a reason specific to
this seam's shape, not as a general rule.**

`afterCandidates` is a constructor option with no default (`undefined`), awaited
unconditionally: `if (this.afterCandidates) await this.afterCandidates(candidates)`. So
production passes nothing and the branch is dead. Reaching it requires *constructing* a
`PostgresJobQueue` with the option — there is no environment variable, no request-shaped
input, and no config path that can supply it. An attacker who can call `new
PostgresJobQueue({afterCandidates})` already has arbitrary code execution in the server
process, at which point the seam is not the interesting capability.

The only production construction is `JobRuntime`'s default parameter
(`JobRuntime.js:18`, `queue = new PostgresJobQueue()`) — no options object at all. I
verified by grep across `utils/`, `endpoints/`, `models/` and `index.js`: one
construction site, and it passes nothing.

**Why the source assertion is enough here.** My general position (from #119 and #124) is
that a source assertion is weaker than a behavioural one and needs justification. It is
justified in this case because the property is *syntactic*: "no production file passes
this option" is a statement about source text, and there is no runtime observation that
could establish it more directly — a behavioural test can only show the seam was not used
on the paths it exercised, which is the weaker claim. RF-S walks `utils/` and `endpoints/`,
strips block and line comments first, and filters to files that construct the class. That
is the right shape.

**Two limits worth recording**, neither blocking:

- RF-S covers `utils/` and `endpoints/` only. `models/` and `index.js` are not walked. No
  construction exists there today (I checked), but the assertion's scope is narrower than
  its name suggests. Widening the roots is a one-line change.
- A construction reached through indirection (`new (require(x).PostgresJobQueue)(opts)`)
  would not match `new PostgresJobQueue`. Not a realistic concern for this codebase's
  style; noted so the next reader knows the grep's shape.

**The stronger half is RF-S's second test**, and it is the one I would keep if forced to
choose: the seam is detected *by being called*, not by being accepted. I confirmed it —
**M2** (store the hook, never invoke it) reds three fixtures including that one. A seam
that is accepted and ignored is indistinguishable from no seam, and would let RF-1 certify
a concurrency guarantee it never exercised. That failure mode is closed.

## Q2 — Can a wedged worker's takeover run two applies concurrently?

**Yes. Measured.**

The claim/heartbeat/`LeaseLostError` ordering is correct *at the database*: takeover
requires the lease to have expired, and after takeover the old worker's `heartbeat`,
`complete` and `fail` all fail closed on `workerId` + `leaseUntil > now`. RF-2 asserts
exactly this and it holds. **M1** (drop the conditional-update guard in `claim`) reds RF-1,
so the mutual exclusion is genuinely pinned.

What none of that covers: **`LeaseLostError` is raised where the worker reports, not where
it computes.** `CoreJobWorker.run` awaits `handler(job)` to completion and only then calls
`complete`. Losing the lease produces an error *after* the handler has already run to the
end. Nothing cancels the in-flight handler.

I built the scenario rather than reasoning about it — worker 1 claims with a short lease
and starts a 400ms handler, the lease expires, worker 2 takes over and starts its own:

```
worker-2 took over: true
CONCURRENT APPLIES IN FLIGHT: 2
run1: w1-err:LeaseLostError | run2: { ok: true }
```

Two applies in flight at once. Worker 1 then correctly fails with `LeaseLostError` — but
its side effects have already landed. For a directory sync whose apply writes group
membership and role grants, that is two concurrent writers to the same rows, with the
loser's failure arriving after its writes.

**This is not a defect `2cdb884ef` introduces** — `run` has always had this shape, and the
lease work in this slice makes the window *narrower*, not wider. I am recording it because
the slice's stated purpose is "the concurrent apply this slice exists to prevent" (the
comment in `JobRuntime.tick`), and as measured, the lease prevents two workers from
*owning* the job, not from *applying* it.

**What would close it**, for whoever writes the apply half: the handler must observe the
lease, not just the worker. Either (a) pass an abort signal that the heartbeat's
`LeaseLostError` triggers, and have the apply check it between batches, or (b) make the
apply's writes conditional on still holding the lease — the same
`updateMany({where: {workerId, leaseUntil: {gt: now}}})` pattern the queue already uses,
applied at the write site. (b) is the more robust of the two because it needs no
cooperation from the handler's control flow.

**NIT-1 (non-blocking):** **M3** — remove `leaseUntil: {gt: now}` from `heartbeat`'s
predicate, so a worker whose lease already expired can renew it — **survives 9/9**. That
mutation lets worker 1 reclaim the lease *after* worker 2 took over, producing two workers
each believing they hold it. RF-2 does not catch it because RF-2 asserts the heartbeat
throws when the row's `workerId` has already changed — the `workerId` clause alone
satisfies that. A fixture where the lease expires but *no one else takes over*, then the
original worker heartbeats, would separate the two clauses. Worth adding while the apply
half is being written.

## Q3 — Does the per-provider job type let one tenant's stall starve another?

**No, and RF-4 is the right test for it.** Per-type exclusion rather than a global lock:
two providers claim concurrently, both inside the window (`latch.reached === 2`), both
succeed. RF-4 is explicitly paired with RF-1 so that a global lock — which would satisfy
RF-1 alone — fails here. That pairing is the correct construction.

Two structural observations:

- `JobRuntime.tick` uses `Promise.allSettled`, so one handler's rejection cannot prevent
  the others in the same tick from completing. Good.
- `tick` is guarded by `if (this.running) return`, so a slow *batch* delays the next tick
  for every type. That is head-of-line blocking at the tick level rather than starvation
  at the claim level: a stalled provider's job holds a slot in the batch of 10 and the next
  tick waits for the whole batch. With `limit: 10` and one runtime per process it is
  bounded and self-clearing, so I do not consider it a starvation vector. Recorded because
  it is the nearest thing to one.

## Finding: the 160s lease is not live yet, and the numbers should be read accordingly

Measured from the driver's own constants:

```
DEFAULT_TIMEOUT_MS 10000  BACKOFF_CEILING_MS 2000  MAX_RETRY_AFTER_MS 30000  MAX_RETRIES 3
LARK_ENUMERATION_CEILING_MS = (10000 + max(2000,30000)) * 4 = 160000 ms = 160 s
DIRECTORY_SYNC_LEASE_MS     = 160000
```

The derivation is correct and RF-3 recomputes it from the same exports rather than pinning
a literal — the right construction, and it kills the "two places encode the same mistake"
failure.

But **`directory.sync` has no registered handler**. `handlers` contains
`telemetry.flush@1` and `retention.purge@1` only. `JobRuntime.tick` derives its `types`
from `Object.keys(handlers)`, so:

```
claim lease = max over registered types = 30000   (not 160000)
```

The per-type lease is correct machinery that nothing exercises in production yet. That is
expected for a slice landing ahead of the apply half, and RF-3a drives `claim` directly so
the assertion is still real. Recorded so a reader does not take "160s lease" as a
description of the running system.

**Related, and worth catching before the apply half:** `leaseMsFor` is an exact-key
lookup, and the concurrency fixtures use per-provider types like `directory.sync:lark`.

```
leaseMsFor("directory.sync")       -> 160000
leaseMsFor("directory.sync:lark")  -> 30000   <- the fallback
```

So if the apply half registers per-provider types (which RF-4's shape suggests it will),
every one of them silently gets the 30s default and the derived lease applies to nothing.
The fix is a prefix match or a normalisation step in `leaseMsFor`. Flagging now because it
will look like a lease regression later and the cause will be three files away.

## Mutation summary

| # | mutation | result |
|---|---|---|
| M1 | drop the conditional-update guard in `claim` | RF-1 red |
| M2 | seam stored but never invoked | RF-1, RF-4, RF-S-called red |
| M3 | `heartbeat` ignores lease expiry | **survives — NIT-1** |

## Reproduction

```
git worktree add --detach /tmp/tl2-138q 2cdb884ef
cp -al /tmp/tl2-136f12/server/node_modules /tmp/tl2-138q/server/node_modules
cd /tmp/tl2-138q/server && npx prisma generate
CREATE DATABASE t138q TEMPLATE t98b
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" STORAGE_DIR=$(mktemp -d) \
       SIG_KEY=$(openssl rand -hex 32) SIG_SALT=b API_KEY_PEPPER=$(openssl rand -hex 32) \
       JWT_SECRET=$(openssl rand -hex 32) \
       DATABASE_URL="postgresql://postgres:pw@127.0.0.1:55472/t138q"
npx jest __tests__/security/jobs/directorySyncConcurrency.test.js --runInBand
```

The concurrent-apply probe ran as a standalone script inside the worktree's `server/`
directory (claim with a 60ms lease, 400ms handler, takeover after 150ms, counting handlers
in flight) and was deleted afterwards.

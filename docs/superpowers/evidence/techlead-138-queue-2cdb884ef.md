# Techlead-1 — #138 queue half, early read of `2cdb884ef` (auth): **two findings, both blocking**

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist —
authorization correctness (two concurrent applies), test seam reachable from production.
`infi-lessons` not invoked.

§7.14: no suite run. Probes are in-process `node -e` against the real `handlers.js` in a
detached worktree (`/tmp/tl-138q` at `2cdb884ef`, Node 22).

---

## Confirmations first — my `f9d206ad8` points landed, and two landed better than asked

**Both `JobRuntime.js` sites are fixed** (`:51` `Math.max(...types.map(leaseMsFor))` for claim,
`:55` `leaseMsFor(job.type)` for run). The claim-side `Math.max` is the right shape and I did not
specify it: a single claim covers many types, so the longest lease is the only safe one.

**The derivation is an expression on exported constants** (`handlers.js:33-35`), not a literal,
and the comment explains the `Math.max` between the two backoff paths — a 429 on every page
(160s) versus our own capped backoff (~41.5s). It also states why the lease is the ceiling with
**no multiplier**, citing my heartbeat measurement: the lease never spans a run, only the longest
gap in which a live worker might fail to renew. That is the reasoning I wanted written down.

**RF-3 split, and QM-5 proves the split was needed** — a run-site-hardcoded mutant reds RF-3b
only. RF-3a asserts on the **row's** `leaseUntil`, not the argument passed.

**RF-S is both halves**: a source assertion over `utils/` and `endpoints/` with comments
stripped, plus QA-1's CALLED-detection control. The second is what makes the first mean
something — a stored-and-ignored hook reads as absent, and RF-1's `reached === 2` would be
unreachable.

**RF-1** asserts `latch.reached === 2` before anything else, and carries the row witness
`attempts === 1` — so a queue that double-claims and reports honestly still fails. **RF-4** uses
the same latch in the direction where the right answer is "both proceed", which is what fails a
global lock. **RF-5** lets the *database* refuse the duplicate rather than application logic.

---

## FINDING 1 (blocking) — the lease map never fires for a real job. `leaseMsFor` keys on `"directory.sync"`; every per-provider type falls through to 30s

Measured:

```
DIRECTORY_SYNC_LEASE_MS: 160000
  directory.sync            -> 160000
  directory.sync:lark       ->  30000   (FALLBACK)
  directory.sync:ldap       ->  30000   (FALLBACK)
```

`LEASE_MS_BY_TYPE` (`handlers.js:47-50`) has the single key `"directory.sync"`, and
`leaseMsFor:53` is a plain lookup with a default. But **the per-provider ruling makes the
provider part of the job `type`** — this file's own fixtures use `directory.sync:lark-…` and
`directory.sync:ldap-…` in RF-1, RF-2, RF-4 and RF-5. So in production every directory-sync job
takes the 30s fallback, which is **the exact defect RF-3 exists to catch**, shipped green.

**RF-3a does not catch it because it is the one test that uses the bare type**
(`:226 const type = "directory.sync"`). Four fixtures use the real shape and one uses the shape
the map happens to key on — and RF-3 is that one. This is a fixture that is green for an unrelated
reason, in the place that certifies the number.

Fix: `leaseMsFor` resolves by **type prefix** (match up to the first `:`), or `LEASE_MS_BY_TYPE`
is consulted with the provider stripped. Then:

```
RF-3c : leaseMsFor("directory.sync:lark") === DIRECTORY_SYNC_LEASE_MS, asserted for a
        PROVIDER-QUALIFIED type — and leaseMsFor("telemetry.flush") is still the fallback
mut   : today's exact-key lookup
why   : RF-3's existing assertions all pass under the mutation, because they ask about
        the bare type. Only a provider-qualified key separates them, and the
        provider-qualified key is the only one production ever uses.
```

RF-3a should also switch to a provider-qualified type, or it keeps certifying a value no real job
receives.

## FINDING 2 (blocking) — RF-2 proves takeover is *possible*, not that it *converges*

The contract's RF-2 is explicit: *"a crashed owner's job is taken over after the lease expires,
**and the takeover CONVERGES**. Not just 'is claimable' — the second run must finish the
outstanding work, which is what makes takeover safe rather than merely possible."* PMO's brief
asks for a `policy_versions` **exact delta**.

The test asserts: second claim returns the job, `w-1` is refused on `heartbeat` and `complete`,
`row.workerId === "w-2"`, `attempts === 2`. Every one of those is about **ownership**. Nothing
runs the handler, so nothing shows the second worker finishes the first's outstanding work — and
`grep policy_versions` over the file returns nothing.

That matters more here than usual, because takeover is only safe *because* the apply is idempotent
(my `885f339df` ruling, RF-4 of #134). RF-2 as written is green against an applier that has stopped
being idempotent, which is precisely the dependency the ruling said must stay visible.

```
RF-2b : the takeover run APPLIES the outstanding half — assert an exact policy_versions
        delta against a baseline captured after worker 1's partial work, and that the
        directory state converges
mut   : takeover claims the job and applies nothing (return early on attempts > 1)
why   : every ownership assertion in RF-2 is green under that mutation. And the delta
        must be exact, not `>= N`: the takeover's own writes bump too, so a lower bound
        is satisfied by a run that redid everything — which is the non-idempotent case
        the assertion exists to exclude. `membershipsAdded` counts calls and is not a
        witness (QA-1, #134).
```

## Smaller notes, not blocking

- **RF-5 does not exercise `PostgresJobScheduler.materialize`.** It writes the idempotency key by hand and asserts the unique constraint refuses the second row. That proves the constraint works; it does not prove the schedule *goes through* materialization, which is the contract's wording ("Mutant: enqueue directly, bypassing the unique"). A direct-enqueue mutant survives this test. One assertion that S4b's schedule is registered via `queue.schedule` / reaches `materialize:73` would close it.
- **RF-2's `leaseMs: 50`** is fine and honest — the comment explains that no heartbeat is ever sent, which is what a killed process looks like from the database's side, and my coalescing measurement is recorded verbatim beside it. That was the point of the ruling: the fixture reads as simplified rather than fictional.

## Disposition

Everything I asked for in `f9d206ad8` landed, and the lease derivation is better written than I
specified. But **the map does not fire for any type production uses**, and **RF-2 does not assert
convergence** — both are the same class this program keeps finding: a fixture green for a reason
other than the one it is named for. Fix both before the final SHA.

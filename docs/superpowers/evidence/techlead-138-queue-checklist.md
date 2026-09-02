# Techlead-1 — #138 queue half: verdict checklist, pre-written

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist —
authorization correctness (two concurrent applies), new-action gating, test seam reachable from
production. `infi-lessons` not invoked.

Written before the SHA so the read is a tick-through and so the bar is fixed in advance rather
than fitted to what arrives. §7.14 applies: `node -e` probes only, and `/opt/homebrew/opt/node@22/bin/node`
directly if anything beyond that (per #142 — `npx` re-resolves to node 26).

Each line names **what makes it fail**. A row I cannot make fail on the SHA is a row I report as
unverified, not as passed.

---

## Concurrency

- **RF-1** — `latch.reached === 2` asserted **before** the winner check, plus the row witness `attempts === 1`. *Fails if:* the two claims serialise (reached 1), or both updates land (attempts 2) while the loser honestly returns `[]`.
- **RF-2** — `LeaseLostError` on **both** `heartbeat` and `complete` for the evicted worker, and `row.workerId` is the new one. *Fails if:* takeover leaves worker 1 able to write — two owners of one job.
- **RF-2b** — the takeover **converges**: exact `policy_versions` delta on a baseline captured after worker 1's partial work, **and** the `group_members` end state. Both witnesses, limits stated. *Fails if:* the second run claims and applies nothing. Exact, not `>=` — the takeover's own writes bump, so a lower bound is satisfied by a run that redid everything, which is the non-idempotent case the assertion exists to exclude. `membershipsAdded` counts calls and is not a witness (#134).
- **RF-2c** — late writes from the evicted worker are **REFUSED** by the per-entity re-check. See the ruling below.

## Lease

- **RF-3** split claim-side and run-side. *Fails if:* one site keeps a constant — the split exists because a single "a lease is derived" test passes with the other site unfixed.
- **RF-3c** — a **provider-qualified** type (`directory.sync:lark`) resolves to the derived value, with `telemetry.flush` still the fallback as the negative control. *Fails if:* `leaseMsFor` keys the bare type — measured 30s on `2cdb884ef`, and RF-3a was the only fixture using the bare type while four others used the real shape.
- **RF-3d** — a `telemetry.flush` row's `leaseUntil` is the directory-sync value with `directory.sync` registered, pinning the accepted inheritance, plus the tick comment saying non-sync types wear the max until their first heartbeat **and why** (the two error directions are not symmetric: too long delays takeover of a dead worker, too short starts a concurrent apply while the first is alive).
- **Ledger** — the lease is an **expression on the exported constants**, not a literal; the heartbeat mechanism correction is recorded (a hung fetch does *not* stop the heartbeat — measured 9 beats); `320000 → 160000`.

## Scheduling

- **RF-4** — two providers claim concurrently, same `runAt`, one claim call, `reached === 2` in the direction where both proceed. *Fails if:* a global lock — which RF-1 alone would pass.
- **RF-5** — dedupe **through `PostgresJobScheduler.materialize`**, not a hand-written idempotency key. *Fails if:* a direct-enqueue mutant survives, which it did on `2cdb884ef`. Off-boundary freeze and the RF-5b source assertion are the guards on the key derivation.
- **RF-S** — both halves: the source assertion over `utils/`+`endpoints/` with comments stripped, **and** the CALLED-detection control. Without the second, a stored-and-ignored hook reads as absent and RF-1's `reached === 2` becomes unreachable.
- **M3/RF-8** fixture present.

## The sync-now route

- Gated on the **`directory.sync` string** — the literal, not a variable that could resolve elsewhere.
- **202 on a second click**, stable idempotency key.
- `traceId` fix; the failure log carries **name + code + message** (a bare message loses the class).
- **`setup_admin` deny with a stubbed grant** — and the test must say in its comment that this proves **the route's gate**, not the seed. Granting the action to `setup_admin` in the fixture and still getting a refusal is the only shape that separates "the route asks the right action" from "the seed happens not to grant it". Without the stub the test passes for the seed's reason and would go green on a route gated on any action `setup_admin` lacks.
- **Lark unregistered → 404 pinned**, distinguishable from a missing secret (#141's fail-closed pair).

## Ruling carried in: per-entity re-check is **acceptable for this slice**

Not because one entity is small — because the apply is **idempotent by construction** (#133/#134),
so a one-entity overlap rewrites the same row rather than producing a wrong state. That is the same
dependency my lock ruling `885f339df` already rests takeover on.

Two conditions:

1. **The residual names the dependency, not just the window.** "One entity wide" is the measurement; *"this is safe because `applyDirectoryPlan` is idempotent, and stops being safe if that changes"* is the reason. A future non-idempotent apply turns the window into a real defect and nothing about its size would say so.
2. **RF-7b must be a control that can fail** — the predicate **admits** the legitimate write, not only blocks the stale one. A re-check that refuses everything satisfies RF-7 alone.

The follow-up (predicate inside `policyRepository`'s writes) is Dev5's lane, sequenced after #136;
say so in the residual so the two are visibly connected rather than rediscovered.

## What would make me withhold a PASS

Any row above I cannot make fail; a fixture whose green state is explained by something other than
the property it names; or a residual that states a measurement where it needs to state a
dependency.

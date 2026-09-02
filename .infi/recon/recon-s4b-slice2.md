# Recon — S4b slice 2: apply the plan, and record that it happened

Dev 3. Docs only; no code written. Parent `.infi/recon/recon-s4b.md` §2, §3, §4.
Depends on #133 (slice 1, the pure diff) — TL-1 PASS on `62fcc66e6`.

Slice 1 produces a plan and cannot write. Slice 2 writes it, and owns the two things
that make writing safe to retry: the checkpoint, and the rule about which parts of a
plan may be applied at all.

**Q4 is still unanswered.** Identity matching and `identity_links` remain out of scope
(slice 4). Slice 2 applies a plan whose `create` entries are already decided by slice 1;
it does not decide who a principal IS.

---

## 1. The refused-plan question, measured

TL-1 raised it and the measurement confirms it. A plan that trips either scale guard
still carries its constructive half. Probed against `62fcc66e6` — 100 users all losing
their department (membership guard trips) while 60 new people arrive:

```
refused:           true
deactivate:        0     <- cleared by the guard
removeMembership:  0     <- cleared by the guard
create:           60     <- still there
addMembership:    60     <- still there
createGroups:      1     <- still there
```

Slice 1 clears only the destructive lists, deliberately: a caller that forgets to check
`refused` then does nothing dangerous. But it leaves the apply path with a real
decision, and leaving it implicit is how it gets decided by accident.

**Ruling to adopt (TL-1): a refused plan is applied in FULL or NOT AT ALL — and not at
all is the answer.** The reasoning is not "be cautious": the guard fires because the
snapshot is not credible as a description of the organisation. A snapshot that cannot
be trusted about who left cannot be trusted about who arrived, because both readings
come from the same enumeration. The narrowed-scope case makes it concrete — a scope
change that hides departments can equally expose an unrelated one, so the 60 "new"
people may be a directory the admin never intended to sync.

There is a real cost, and it should be stated rather than glossed: a genuine hiring
wave that coincides with a genuine reorganisation is blocked until someone looks. That
is the intended trade. A refused run must therefore be loud (§4) — a refusal nobody
sees is an outage with extra steps.

---

## 2. `enumerateDirectory(driver)` — closing slice 1's residual

Slice 1's residual 1: `completedEnumeration` is exported beside `diffDirectory`, so any
production caller can stamp the brand onto data from a failed run. The brand certifies
PROVENANCE, not truth (QA-1's phrasing) — it records that a value came from the
constructor, not that an enumeration finished.

Both halves are required, and neither is optional:

1. **`enumerateDirectory(driver)` becomes the only producer of a branded value in
   production.** It calls `listPrincipals` and `listGroups`, and either returns the
   branded result or throws. Both calls must succeed; if the second throws, the first's
   data must not reach the diff as a completed enumeration.
2. **`completedEnumeration` moves to `__testHelpers__`.** This is a precondition, not
   tidying: slice 1's 21 tests build completed enumerations without a driver, so
   removing the constructor with nowhere for tests to get one breaks all of them.

**The prohibition that matters:** slice 2 must never unwrap a value and re-wrap it.
Passing a failed run's data through the constructor produces something indistinguishable
from a real completed enumeration, and every guard in `directoryDiff` then reasons from
a lie it cannot detect. That is worth a test: `enumerateDirectory` on a driver whose
second call throws must produce no branded value at all.

---

## 3. Writes: what must be atomic, and what must not

**Membership goes through `addGroupMember`/`removeGroupMember`, never
`prisma.group_members`.** Not style — those functions carry the policy-version bump and
the outbox publish in the same transaction (#113 RF-5), and `bumpVersion` publishes
inside the transaction precisely so a crash between commit and publish cannot leave
caches stale with no event to correct them. A direct write loses the bump silently, and
the symptom appears later as a cache that never invalidates.

**Batch per entity, not per run** (parent recon §2). One transaction across a 100-page
org holds a long lock and discards an entire correct sync on one conflicting row. It
would also collapse every membership change into a single version bump, discarding the
per-change invalidation the cache subscriber consumes.

**The actor is `SERVICE_PRINCIPALS.coreJobs`,** and slice 2 is the first real caller of
the exemption path #113 built. `refuseGroupEscalation` demands the actor hold what the
group carries, except for the two named exempt principals. That exemption is deliberate
and tested (#113 RF-8 case 5; #128's NIT-1 pins that it is by NAME, not by "is not a
user") — but S4b should have its OWN test driving `addGroupMember` as `coreJobs`, so
that if someone later tightens `isExemptPrincipal`, the failing test is directory
sync's rather than an authorization test nobody connects to it.

---

## 4. The checkpoint

What it must record, and why each field earns its place:

- **that a run completed** — this is the completeness signal slice 1 consumes, and the
  parent recon's §3 rule that it be a recorded fact rather than an inference
- **that a run was REFUSED, and why** — otherwise a refused run is indistinguishable
  from one that found nothing to do, and the loudness §1 depends on has nothing to read
- **when** — for the operator, and for deciding whether a sync is overdue

Written LAST, in its own transaction, after every write in the plan succeeded. A crash
mid-apply then leaves a partially-applied sync that the next run corrects by re-deriving
the plan from current state (§5), rather than a rolled-back one that discarded work
already proven correct.

**No table exists.** `grep -n "checkpoint\|sync_state\|sync_run" schema.prisma` returns
nothing, so this is a migration, and it lands in slice 2.

---

## 5. Idempotency and concurrency

Idempotency comes free from slice 1: the plan is derived from current state every time,
so a replay produces an empty plan. Slice 2 must not undermine that by adding run-id
bookkeeping that "skips" work — that protects only against exact replays and would mask
a genuinely needed re-run.

**Concurrency is the real gap, and it is slice 2's to close.** Nothing prevents a second
sync starting while the first applies. Two runs each derive a plan from a consistent
read and then interleave their writes.

The lock choice must be a ruling, not inherited. The precedent —
`PostgresJobScheduler.js:64`, `SELECT pg_advisory_xact_lock($1)` — is
**transaction-scoped**, correct there because that transaction is short. S4b's apply
phase is not short and is deliberately batched per entity, so a transaction-scoped lock
cannot span it. The two real options:

- **session-level advisory lock** — explicit unlock, leaks if the connection dies
  mid-run
- **a lock row plus heartbeat** — survives connection loss, needs an expiry rule and a
  staleness policy of its own

Recorded so nobody copies `pg_advisory_xact_lock` from the neighbouring file on the
assumption that the precedent transfers. It does not.

---

## 6. Evidence contract for slice 2

- **refused plan applies NOTHING** — the probe shape above, asserting zero writes of
  any kind, including `create` and `addMembership`. Mutant: apply the constructive half.
- **partial apply then re-run** — interrupt mid-apply, run again, converge with no
  duplicates. Mutant: run-id skip logic (should fail, since the work is unfinished).
- **`enumerateDirectory` with a failing second call produces no branded value** — the
  §2 prohibition.
- **membership writes go through the repository** — assert a `policy_versions` row and
  an `event_outbox` entry per membership change, not just that `group_members` changed.
  A direct write passes a "membership changed" assertion and fails this one.
- **`coreJobs` drives `addGroupMember` successfully** — S4b's own witness for the
  exemption (§3).
- **checkpoint written only after success**, and a refused run records the refusal.
- **two concurrent runs** do not interleave writes.

Mutation testing is the bar, per §7.9. Every guard above needs a named mutant that a
named test kills.

---

## 7. A pattern worth carrying into slice 2's tests

Three times across #128 and #133, a test of mine was green for a reason unrelated to
the guard it named — a fixture refusing on containment rather than scope, a fixture
sitting below a threshold so a floor was never exercised, a quarantine fixture with no
memberships to remove. Same shape every time: **the fixture never reached the code the
test claimed to exercise**, and every one was caught by a mutant rather than by reading.

For slice 2 specifically, the trap is that writes make it worse: a fixture that fails
early leaves the database in a state where later assertions pass for unrelated reasons.
Every test asserting "X was written" should be paired with one asserting the same code
path leaves X alone when it should — and the fixture must sit where the named guard is
the only thing that can decide the outcome.

---

## 8. Evidence

- The refused-plan measurement: real `diffDirectory` from `62fcc66e6`, 100 users +
  60 new principals, output quoted verbatim in §1.
- No checkpoint table: grep on `schema.prisma`, quoted in §4.
- Advisory lock precedent: `PostgresJobScheduler.js:64`, read directly.
- Suspended users rejected with 401 immediately: `validatedRequest.js:114` (the reason
  §1's trade-off is asymmetric — a wrong apply logs people out mid-work).
- Everything else is a citation to merged code or to #113/#128/#133's ledgers.

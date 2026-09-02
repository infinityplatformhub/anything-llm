# Techlead-1 — pre-read: S4b slice 1 (the pure diff), on recon `b9a05d945`

Read: `.infi/recon/recon-s4b.md`, `utils/jobs/PostgresJobScheduler.js:60-80`,
`utils/middleware/validatedRequest.js:114-118`, `models/user.js:15-83`,
`utils/authorization/policyRepository.js` (`refuseGroupEscalation`, `isExemptPrincipal`),
`prisma/schema.prisma`.

The recon is the strongest one I have read on this program. Three things in it are load-bearing
and correct: the completeness rule stated as a *mechanism* (§1), the observation that the
interrupted-run test is passed by a reconciler that deactivates nobody ever (§1), and keeping
Q4 stated-not-decided so §1–§6 can ship. I have no structural objection. What follows is one
finding that changes slice 1's scope, three notes, and the fixtures.

## FINDING — "the plan cannot contain a deactivation if the run was not complete" must be a *type* property, not a checked one

§2 says the diff is pure and the completeness rule "lives here". Agreed on where. But a diff
function that takes `(snapshot, currentState)` and *also* takes a `complete: boolean` it is
trusted to consult has the rule as a branch — and a branch is exactly what a later refactor
drops, with no test failing unless someone wrote the specific fixture.

The shape that cannot be dropped: **make an incomplete run unrepresentable as an input.** The
diff takes a snapshot value that only exists when both enumerations returned, e.g. the phase-1
result is either `{status:"complete", principals, groups}` or a thrown/`{status:"failed"}` value
the diff does not accept at all. Then "no deactivation from an incomplete run" is not a rule
the diff enforces; it is a sentence that cannot be written.

This matters more than usual here because the harm is asymmetric and irreversible in practice
(§4's own argument): a wrong deactivation revokes sessions and generates support tickets before
the next sync corrects it.

**Slice-1 consequence:** the phase-1 result type belongs in slice 1, not slice 2, even though
slice 1 writes nothing. Otherwise slice 2 invents it under time pressure and slice 1's tests
pinned a signature that changed.

## N-1 — the scale guard must be a *plan* property, checked before apply, and it needs a floor

§4 puts the scale guard in the contract; right. Two mechanics worth fixing now:

- It belongs on the **plan** (phase 2 output), not inside apply. A plan is a value: "this plan
  deactivates 4,213 of 4,700 users" is assertable in a pure test with no database. Put it in
  apply and it needs a live run to test.
- A percentage alone misfires at both ends. In a 6-person org, two people leaving on the same
  day is 33% and legitimate. Below some absolute count the ratio should not fire at all
  (`deactivations > FLOOR && ratio > THRESHOLD`). The floor is a product decision like the
  threshold, but a ratio-only guard will be turned off by the first small tenant it blocks, and
  a guard that gets turned off protects nobody.

## N-2 — `suspended = 1` revokes at the *next request*, which the recon's reversibility argument should say out loud

Verified: `validatedRequest.js:114-118` refuses a suspended user per request. So deactivation
takes effect immediately on the next call and existing JWTs do not need revoking — good, and
it means §4's "reversible" is true of the flag but **not** of the user's experience: they are
logged out and, in most deployments, will have told someone before the next sync corrects it.
That is the argument for the scale guard, and it is stronger stated this way than as "cheap
insurance".

## N-3 — the advisory lock has a precedent in this repo; use it and its key convention

§3 names the advisory lock as a gap. `PostgresJobScheduler.js:64` already does
`SELECT pg_advisory_xact_lock($1)::text` with a hardcoded key (`1_347_579`) inside the
materialize transaction, and it is tested (`pumps.test.js:16` asserts the exact call). So the
pattern, the test shape, and the "one hardcoded int per subsystem" convention all exist.

Two things that precedent does not give you: it is `_xact_` (released at commit), which suits
a short materialize and **not** a long apply phase. A run-length lock is either a session lock
(`pg_advisory_lock`, needs explicit unlock and leaks on a crashed connection) or a row in a
table with a heartbeat. Say which in the contract — this is the decision, not "add a lock".

## N-4 — `coreJobs` exemption: make S4b's dependency on it a test in S4b, not only in #113

§6 is right that the exemption looks accidental and is not. #113 RF-8 case 5 and #128's NIT-1
pin it from the `policyRepository` side. Nothing on the S4b side would fail if someone
tightened `isExemptPrincipal` — the sync would simply stop syncing, and the failure would
surface as "directory sync is broken" rather than "you changed the exemption". One test in
S4b's own suite that drives a membership change through the real `addGroupMember` as `coreJobs`
closes that, and it belongs in slice 2 or 3.

## REQUIRED RED FIXTURES — slice 1 (the pure diff)

```
RF-1 : the completed/interrupted PAIR on ONE fixture — same directory, same current
       state; a completed snapshot missing user X yields a plan deactivating X, and a
       failed enumeration yields a plan (or a refusal) containing no deactivation at all
mut  : return an empty deactivation list unconditionally
why  : the interrupted half alone is green under that mutation, and under "deactivate
       nobody ever". §1 says this; the fixture must be ONE pair over one fixture or the
       two halves can drift onto different data and stop constraining each other.
```
```
RF-2 : a user present in the snapshot but with `email: null` produces NEITHER a
       creation NOR a deactivation of the existing user with that subject
mut  : treat an unusable record as absent
why  : a fixture with only new users is green — the mutation only differs for a record
       that is present-but-invalid AND already exists locally. This is §4's quarantine
       rule and the one that turns a Lark data-entry error into a revocation.
```
```
RF-3 : the scale guard is a property of the plan — a plan deactivating N of M is
       refused above the threshold AND allowed below the floor with the same ratio
mut  : ratio-only (drop the floor)
why  : every large-org fixture is green without a floor; only a small-org fixture with
       a high ratio separates them (N-1).
```
```
RF-4 : membership removals in the plan are expressed as removals for a DEACTIVATED
       user too — not only for a user who left a department
mut  : emit membership removals only for users still present
why  : §4's "a reactivated user silently regains everything". A fixture whose departed
       user has no group membership is green either way; the departed user must be in a
       group.
```
```
RF-5 : a group present in `listGroups` but named by no principal's `department_ids`,
       and a `department_ids` entry naming a group absent from `listGroups`
mut  : build membership from `listGroups` rather than from principals
why  : S4a returns `memberExternalIds: []` always (§0), so a membership built from
       groups is EMPTY and every fixture that checks "the right members" is green while
       the plan silently removes everyone. The asymmetric fixture is what catches it —
       §0 names the two enumerations as unordered and non-transactional, and this is
       where that bites.
```

RF-5 is the one I would not ship slice 1 without. §0 states the constraint plainly, and it is
exactly the kind of stated-then-forgotten fact that produces a diff which passes its own tests.

## On Q4

Recommendation (a) is right, and the reason given — *(b)'s cost is paid continuously and
silently; (a)'s is paid once and visibly* — is the correct axis. I would add one measurement to
whoever presents it to the user: under (a) the conflict is reported **on every run, forever**,
which is a real operational cost and the honest counterweight. That is still the better trade,
but the user should choose it knowing the alarm never stops until someone acts.

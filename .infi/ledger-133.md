# Ledger — #133 (S4b slice 1): the pure directory diff

Dev 3. Branch `approof/133-directory-diff`, from main `3327b34ac`. Tier auth.
Recon `.infi/recon/recon-s4b.md`. TL-1 pre-read `techlead-s4b-slice1-preread.md`,
folded into the issue as the `updated` comment (A1–A6).

Q4 is unanswered and nothing here encodes a guess about it.

## What the slice is

Snapshot + current state → a plan. It computes and cannot write: no prisma import, no
`policyRepository`, no `group_members` (R6, pinned by a source test). Writes, the
checkpoint and the job handler are slices 2 and 3.

## Rulings

Ruling (TL-1 A1): completeness is a property of the VALUE, not a boolean field. A
`{ complete: boolean }` flag is a branch, and a branch can be deleted — a mutant
removing `if (!input.complete)` would leave nothing to fail against. `completedEnumeration`
stamps a module-private Symbol, and `diffDirectory` REFUSES a raw object that merely
claims `status: "complete"`. If wrong: the one rule protecting an organisation's access
is a string anyone can type.

Ruling: a quarantined subject is excluded from deactivation EXPLICITLY, not implicitly.
It is present in the directory and unusable, which is not the same as absent. Getting
this wrong turns a Lark data-entry error into a revocation.

Ruling (TL-1 A2): the scale guard is `deactivations > FLOOR && ratio > THRESHOLD`.
Both, never either.

- **FLOOR = 10.** Below eleven departures no proportion is evidence of anything: a
  small team can lose a third of itself for ordinary reasons, and a guard that fires on
  the most common case gets disabled — a disabled guard protects nothing.
- **THRESHOLD = 0.5.** Half an organisation vanishing between two syncs is far more
  likely a misconfigured Lark app (wrong tenant, narrowed scope) than attrition. Lower
  and reorganisations trip it; higher and a scope narrowed to one department slips
  through.

Ruling: a refused plan carries an EMPTY deactivation list rather than a populated one
behind a flag. A caller that forgets to check `refused` then does nothing, instead of
doing the destructive thing. Fail-closed means the dangerous value is absent, not
guarded.

Ruling (TL-1 A4, verified): refusing rather than warning, because
`validatedRequest.js:114` rejects a suspended user with 401 immediately. A wrong
deactivation is reversible in the database and NOT reversible in experience — people
are logged out mid-work before anyone notices the sync was bad.

Ruling (RF-5): membership is built from the PRINCIPAL's `groupExternalIds`, never from a
group's `memberExternalIds`. S4a returns the latter as `[]` on every group, always and
deliberately (Lark carries membership on the user record), so a diff reading membership
from groups produces an EMPTY membership set — silently plausible, and it removes
everyone from every group.

Ruling (RF-5, second direction): a `department_ids` entry naming a group absent from
`listGroups` is REPORTED as dangling, not created. The two enumerations are separate
calls with no ordering guarantee, so this happens in normal operation. Creating the
group from the reference would mean the user record decides what departments exist, and
the directory's own group list stops being authoritative.

## Evidence

RED was measured against a NAIVE BASELINE, not against a missing module. A file that
does not exist fails with "cannot resolve", which proves nothing about what the tests
measure. The baseline implemented the obvious thing — absence means departure,
membership read from groups, nothing refuses — and:

**10 failed, 5 passed.** The five that passed are exactly the controls: T2 (deactivates
on a complete run), small-org allowed, normal-attrition allowed, empty group created,
no-db-import. That split is what makes the RED the defect rather than a broken suite.

15/15 green after. Full authorization+identity sweep green.

Six mutants, each killed by its named tests:

- D1 drop the completeness check → T1 and T3, **T2 stays green**. TL-1 asked for
  exactly this: a mutant that kills every test proves the tests are coupled, not that
  the guard works.
- D2 merge quarantine into deactivation → T4 and the quarantined-new-principal test
- D3 remove the scale guard → T6 alone
- D4 drop the FLOOR, keep the ratio → the small-org test (after it was fixed; see below)
- D5 build membership from `listGroups` → the RF-5 membership test, the dangling-ref
  test, and T5
- D6 accept a dangling group reference → the dangling-ref test alone

## A test of mine that measured nothing, and the mutant that found it

**D4 SURVIVED the first run.** The small-org test used six people with two departures —
33%, which is BELOW the 0.5 threshold. So a ratio-only guard passed it too: the test sat
where floor and ratio agree, and therefore said nothing about the floor at all.

Fixed by moving it into the band where they disagree: six people, four departures =
66%, over the threshold and under the floor. Only the floor can allow that. D4 dies
against the corrected test.

This is the second time this week a test of mine was green for a reason unrelated to
the guard it named (the first was #128's RF-2 refusing on containment rather than
scope). The pattern is the same both times: the fixture never reached the code the test
claimed to exercise. Reading did not catch either; the mutant did.

## Residual risks

1. **The constructor is still reachable from the production path** (TL-1, and this
   corrects how I first wrote it). `completedEnumeration` is exported from the same
   module as `diffDirectory`, so any production caller can stamp the brand onto data
   from a run that failed.

   The Symbol proves a value passed through `completedEnumeration()`. It does not prove
   an enumeration COMPLETED — those are different claims, and only the second one is
   what A1 is for. While the constructor is exported next to the consumer, the type
   discipline is ceremony rather than a guarantee.

   I first recorded this as "nothing stops slice 2 from calling it on data from a failed
   run" — which puts the fault on a future caller's discipline and is the weaker,
   wrong framing. The defect is structural and present now, not hypothetical and
   someone else's.

   Slice 2 closes it, and both halves are REQUIRED, not optional:
   - `enumerateDirectory(driver)` becomes the ONLY producer of a branded value — it
     calls the driver and either returns the brand or throws.
   - `completedEnumeration` moves to `__testHelpers__`. This is a precondition, not a
     tidy-up: slice 1's tests must be able to build a completed enumeration without a
     real driver, so removing the constructor with nowhere for tests to get one breaks
     all fifteen of them.
2. `danglingGroupRefs` is reported and otherwise inert. Slice 3 decides whether a run
   with dangling references alerts, and how loudly — recorded so it is not assumed
   handled.
3. The floor and threshold are rulings, not measurements. No real Lark tenant data
   exists to calibrate against; they are defensible defaults and should be revisited
   once a real sync has run.

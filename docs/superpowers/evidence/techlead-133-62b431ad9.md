# Techlead-1 — #133 S4b slice 1 `62b431ad9` (auth): **REJECT**, one blocker + one to rule on

§7.14: no suite run. Probes are in-process `node -e` against the module in a detached worktree
(`git worktree add --detach /tmp/tl-133 62b431ad9`, Node 22).

## A1 closed, and the residual I raised is closed too

`COMPLETE` is a module-private `Symbol` (`:27`), `completedEnumeration` is the only producer
(`:39-41`), and `diffDirectory:90-95` refuses a raw object claiming `status: "complete"` with a
message that says why. So a hand-built "complete" enumeration is rejected rather than trusted.

The constructor is still exported (`:216`), which was my residual note — but the refusal at
`:90` means the risk is not "slice 2 forges completeness", it is "slice 2 calls
`completedEnumeration` on data from a failed run". Dev3's reworded residual
("constructor reachable from production path") is the checkable version and I accept parking it
for slice 2, since `enumerateDirectory(driver)` is slice 2's own deliverable.

Named constants exported (`:77-78`, `:216-217`) so calibration does not mean hunting literals.
The scale guard is both conditions (`:143-146`), and a refused plan carries **no** deactivations
rather than deactivations plus a flag (`:203-206`) — a caller that forgets to check `refused`
does nothing instead of the destructive thing. That is the right default and it is stated.

RF-5 is implemented from `principal.groupExternalIds` with the reason written down (`:152-157`),
and `danglingGroupRefs` reports rather than invents, so the user record cannot decide what
departments exist. Membership keys use a control-character separator (`:172`, `:180`), not a
space — verified against subjects and group ids containing spaces; both round-trip intact.

## FINDING-1 (blocker) — mass membership removal has no scale guard, and it is the same harm

The guard counts deactivations only (`:143-146`). Membership removal is unguarded. Measured:

```
100 users, all present in the snapshot, every department_ids narrowed to []
 -> deactivate: 0   refused: false   removeMembership: 100
```

A Lark app whose scope is narrowed — the exact misconfiguration the scale guard's own comment
names (*"wrong tenant, narrowed scope"*) — returns every user, so nobody is absent and nothing
trips the deactivation path. It returns them with empty `department_ids`, so **every membership
in the organisation is removed**, and since #96 group membership is a grant path: the plan
revokes everyone's group-derived access while reporting a clean, unrefused run.

The harm is the one this module exists to prevent, arriving through the half that was not
counted. It is arguably worse than the deactivation case, because a suspended user gets a clear
401 (`validatedRequest.js:114`) while a user stripped of group grants gets a silently smaller
world — no error, just missing workspaces and documents.

**Fix:** the guard must consider `removeMembership.length` against `currentMemberships.length`
with the same floor-and-ratio shape, and `refused` must empty **both** lists. Whether it is one
combined guard or two independent ones is Dev3's call; I would take two, because the floors
differ in kind (10 departures is a lot; 10 membership changes is a Tuesday).

```
RF-6 : a completed snapshot in which every principal is present but every
       groupExternalIds is empty, over a current state where all N users hold
       memberships -> refused, and removeMembership is []
mut  : count only deactivations in the scale guard (current code)
why  : every existing scale-guard fixture varies the DEPARTURE count, so all three are
       green with membership removal unguarded. The discriminating fixture is the one
       where nobody departs at all — which is also the shape a narrowed scope actually
       produces.
```

## FINDING-2 (needs a ruling) — a quarantined principal loses its memberships

Measured:

```
u1 exists, holds membership in od-1; snapshot returns u1 with email: null
 -> quarantine: 1   deactivate: 0   removeMembership: [{u1, od-1}]
```

The deactivation path excludes quarantined subjects explicitly and correctly (`:136-138`).
Membership does not: a quarantined principal is not in `usable` (`:112-118`), so it contributes
no `desired` entries, so all its held memberships appear as removals.

The seam's wording is *"quarantined without widening membership"*, and the recon's §4 argument
is that a degraded record must not become a revocation. Removing every group from a user whose
Lark record briefly lost its email is a revocation — the same "turns a data-entry error into a
revocation" sentence the quarantine rule is written against, applied to the narrowing direction
instead of the departure one.

I read the seam as *do not widen*, which does not license narrowing. My recommendation is that
a quarantined subject's memberships are left untouched — excluded from `removeMembership` the
same way it is excluded from `deactivate` — but this is a product-shaped call and I would take
PMO's ruling either way. What is not defensible is the current state, where the two paths treat
the same record differently with no comment saying that was chosen.

```
RF-7 : a quarantined principal with existing memberships -> those memberships are
       absent from removeMembership (or present, per the ruling, WITH a comment)
mut  : the current fall-through
why  : the existing quarantine tests (`:140`, `:159`) use principals with no current
       memberships, so both are green either way.
```

## Confirmed

- T1/T2 are the same fixture in both directions (`:69`, `:85`) — the pair the recon called for, and T3 (`:117`) proves `listGroups` failing alone blocks deactivation.
- The small-org-over-ratio test (`:195`) is the one that pins the floor; the large-org-normal-loss test (`:220`) pins the ratio. Both directions present.
- T7 (`:346`) asserts the module imports no db client and no repository — R6 held by a source test, which is the right way to pin "cannot write".
- Replay produces an empty plan from current state (`:301`), so idempotency is by construction as the recon argued.

## Verdict

**REJECT** on FINDING-1. FINDING-2 needs a ruling before the next SHA so both land together.
Everything else in the slice is the design as specified, including the A1 shape that made this
review possible — the two findings are both about the membership half, which the completeness
work did not reach.

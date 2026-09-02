# Techlead-1 — #133 S4b slice 1 `62fcc66e6` (auth): **PASS**, one note for slice 2

§7.14: no suite run. Probes are in-process `node -e` against the module in a detached worktree
(`git worktree add --detach /tmp/tl-133b 62fcc66e6`, Node 22). Delta read against `62b431ad9`.

## Both findings closed, verified on the same repros that produced them

**F1 — membership scale guard.** Re-ran the exact input from my REJECT:

```
100 users, all present, every department_ids narrowed to []
before: deactivate 0 · refused false · removeMembership 100
after:  deactivate 0 · refused TRUE  · removeMembership 0
```

`MEMBERSHIP_FLOOR = 25` / `MEMBERSHIP_RATIO = 0.5` as separate constants (`:99-100`), with the
reason for not sharing the deactivation ones written down: memberships are many-per-user, so a
floor tuned for headcount means nothing here. That is the argument I made for two guards rather
than one, reached independently.

`refused` clears **both** destructive lists whichever guard fired (`:255`, `:262`), and the
comment gives the reason — a run this wrong about one quantity is not to be trusted about the
other. That is stronger than what I asked for and it is the right default.

Boundary probed: 25 removals of 40 memberships (62.5%, at the floor) is allowed; 26 refuses. So
the floor is a strict `>`, matching the deactivation guard's shape.

**F2 — quarantined memberships.** Same repro:

```
u1 exists holding od-1; snapshot returns u1 with email: null
before: removeMembership [{u1, od-1}]
after:  removeMembership []
```

The exclusion is at `:207-211` with the reasoning stated as a property rather than a special
case: an invalid record's `groupExternalIds` cannot be trusted **in either direction**, and
narrowing is damage too, not only deactivation. That is the generalisation the seam's "without
widening" wording needed, and it is the sentence I would have wanted in the ledger.

The paired test (`:424`) is what makes it non-vacuous — a non-quarantined user in the same run
still loses the membership it dropped, so the exclusion is about quarantine and not about
membership removal being switched off.

## Fixture corrections both accepted

- NIT-1's 30/100 fixture (`:328`): 11 removals would sit under the membership floor of 25, so the ratio arm could not be isolated at that size. Correct diagnosis.
- NIT-2 (`:69`, `:117`): T1 and T3 now hold memberships and assert `removeMembership: []`, so the incomplete-enumeration rule is pinned on both destructive outputs rather than only on deactivation. That closes a gap my own RF-1 left — I specified the pair on deactivations and did not extend it to memberships.

Three membership-removal paths now die on different tests (incomplete enumeration, quarantine,
scale guard), which is what stops one fix from standing in for the other two.

## Note for slice 2, not a finding here

A refused plan still carries its **additive** lists: measured, a refusal with 60 new principals
returns `create: 60`, `addMembership: 60`, `refused: true`. That is defensible — the guard is
about destruction, and blocking creations would turn a scope misconfiguration into a hiring
freeze. But it means slice 2's apply path must decide explicitly whether a refused plan is
applied partially (additions only) or not at all, and the plan's shape currently invites the
first without saying so.

I would take **not at all**: a run whose destructive half is untrusted is a run whose input is
suspect, and creating users from a directory snapshot you have just declared probably-wrong is
the same class of mistake in the other direction. Either way it is slice 2's ruling and belongs
in its contract, not a change here.

## Verdict

**PASS.** Both findings closed at the level they were raised, verified on the original repros,
and the fixture corrections found by the dev cover a gap I left in my own RF list.

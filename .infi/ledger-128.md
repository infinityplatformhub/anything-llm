# Ledger — #128: `heldPermissionIds` expands group membership

Dev 3. Branch `approof/128-held-group-expand`, from main `166cd3865`. Tier auth.
TL-1 pre-read `techlead-128-preread.md` @ `93c4103fb`.

## The defect

Since #96 the ENGINE expands `group_members` when it evaluates grants, and #113 made
membership itself an authorization path. `heldPermissionIds` never caught up: it read
the actor's OWN `principal_role_grants` rows only. So a delegated admin whose role
reaches them through a group was authorized by the engine to act, then refused by the
three places that ask what the actor holds — `grantRole`, `canAssignLegacyRole` and
(since #113) `refuseGroupEscalation`.

Fail-closed, which is why it shipped without an alarm. Still wrong, and it is the shape
that gets "fixed" under pressure by handing someone a direct grant they should not
need — turning a missing expansion into a permanent over-grant nobody revisits.

## Ordering: this is half of a pair, and the order is load-bearing

**#128 must not land before #113**, and it did not. Expanding groups here while
membership writes are unguarded completes a chain: add yourself to a group → inherit
its permissions → satisfy the escalation guard → grant yourself directly. #113 merged
at `1ac806cfc`; this branches from `166cd3865`, after it. Cross-referenced in
`ledger-113.md` residual 0.

The stale `KNOWN LIMIT (#128, queued)` comment on `refuseGroupEscalation` is rewritten
here rather than left behind — a comment describing a limit that no longer exists is
the kind of thing a future reader trusts and reasons from.

## Rulings

Ruling (TL-1, structural): the principal filter comes from `grantPrincipalPairs`, the
SAME helper the engine and `readableScope` use — no new group query in this file. #96
built that helper for exactly this reason: three expansions free to drift apart was the
defect it existed to remove, and a fourth private copy reopens it. The `where` is
`AND: [{orgId, expiry}, {OR: pairs}, scope]`, the shape `readableScope` already uses.
If wrong: two layers answer differently about who a user is, which is the bug this
issue IS.

Ruling: an api-key does NOT inherit its creator's groups, mirroring `engine.js:189-196`
deliberately. A key's authority is what its creator holds DIRECTLY; inheriting their
departments would widen the key whenever someone edits a group, against grants the
key's scope list was never reviewed for. `grantPrincipalOf` returns the creator, who IS
a user, so the type check does not catch this — it has to be refused on purpose.

Ruling: the scope clause applies to the group pairs too (TL-1 kept it explicitly).
Group grants can be workspace-scoped, so dropping it for them would let a workspace-A
admin who reaches their role through a group mint roles in workspace B — the leak the
clause exists to prevent (issue #20), reintroduced through the new pairs.

Ruling: a `grantPrincipal` of null returns the empty set. A key whose creator was
deleted evaluates as nobody and holds nothing; without the guard, `grantPrincipalPairs`
would be handed null and the failure would be a thrown TypeError rather than a refusal.

## Evidence

RED first: 5 failed, 6 passed. The failures are RF-1 (x2), RF-2, RF-3 and RF-4; the six
green are the controls, which is what makes the RED mean the defect rather than a
broken suite. 11/11 green after; full authorization+identity sweep green.

Four mutants, each killed by its named tests:

- M1 drop the expansion (pre-#128 behaviour) → RF-1 x2, RF-2, RF-4
- M2 let an api-key inherit its creator's groups → RF-3 alone
- M3 drop the scope clause → both RF-2 tests
- N1 `actor?.type !== "user"` in place of `isExemptPrincipal` → the NIT-1 test

## Two of my own tests proved nothing, and the mutants are what found them

**Wrong target role.** Three tests granted org `member` and asserted the write
succeeded. Measured: `member` carries 2 permissions and BOTH are in
`BASELINE_GRANTABLE` (`chat.send`, `org.member`), so granting it is allowed for
everyone and the assertion held with or without the fix. Switched to
`content_moderator` (8 permissions, non-baseline). This is why the first RED run showed
failures in the wrong places — the tests were measuring the wrong thing, not the code
behaving oddly.

**A test that refused for the wrong reason.** RF-2's org-wide case survived mutant M3
(scope clause deleted). It granted `content_moderator`, which workspace `owner` does
NOT contain — missing `access.diagnose`, `chat.read_others`, `document.bulk_export`,
`org.member` — so the write was refused by CONTAINMENT and never reached the scope
clause at all. Measured `viewer ⊆ owner` and switched to it: containment now passes, so
the only thing that can refuse is the scope rule. M3 kills both RF-2 tests after the
change.

Both were caught by mutants rather than by review, which is the argument for running
them: the suite was green, and green meant nothing on those two.

## QA-1 NIT-1, carried forward from #113

QA-1 measured on #113 that replacing `isExemptPrincipal(actor)` with
`actor?.type !== "user"` survived 43/43. Every exemption test passed an actor that was
BOTH named in the set AND not a user, so none could tell the two rules apart.

The difference is the S-9 hole (issue #20): a scoped API key resolves to a service actor
too, so "exempt because not a user" hands every key an exemption meant for two named
migration principals. The new test drives `addGroupMember` as `api-key:1` against a
group holding `super_admin` and requires refusal, with the paired control that the two
NAMED principals still pass — without which "refuse every service actor" would satisfy
it and break the S4b reconciler.

## TL-1 nit, carried forward from #113

`aclGroupWorld`'s `workspaceId: role.scope === "workspace" ? null : null` was dead code
I left while deciding how to grant `owner`. It reads as if scope matters. Replaced with
`null` plus the reason it must be null: `refuseGroupEscalation` reads
`heldPermissionIds(tx, actor, null)`, which counts org-wide grants only — a
workspace-scoped grant would not be counted at all, so control A would refuse because
the actor holds NOTHING rather than because `document.share` is the wrong bar. Green
for the wrong reason.

## Residual risks

1. Expansion adds one query per `heldPermissionIds` call for user actors. It is not on
   a hot path — these are the write gateways, not the read filter — and
   `grantPrincipalPairs` accepts a memo for callers that batch. No caller here batches
   today, so none is passed; noted rather than pre-optimised.
2. `canAssignLegacyRole` and `grantRole` now answer for group-held roles, so any UI
   that hid controls based on the old refusal will start showing them. That is the
   intended fix, but it is a visible behaviour change for delegated admins.

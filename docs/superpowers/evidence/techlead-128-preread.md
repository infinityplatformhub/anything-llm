# Techlead-1 — advance read for #128: `heldPermissionIds` does not expand groups

Written before the contract, off the residual I raised on #123 `be27ac7ed`. Read on
`approof/main`: `utils/authorization/policyRepository.js:90-115,150-200,215-240,360-381`,
`utils/authorization/groupMembership.js:75-91`, `utils/authorization/engine.js:178-200`.
Dev3 takes this after #113 (same file).

## The gap, measured

`heldPermissionIds(tx, actor, targetWorkspaceId)` filters `principal_role_grants` on
`principal_type: actor.type` / `principal_id: String(actor.id)` — the principal alone. Probed
against a stubbed db: for a user with no direct grant, `canAssignLegacyRole("admin")` returns
`false` and **`group_members` is never queried**.

Since #96 the engine builds its filter from `grantPrincipalPairs` (`engine.js:190-200`), which
is the principal **plus one `{principal_type:"group", principal_id}` pair per group**
(`groupMembership.js:82-89`). So the two disagree about who an actor is.

## Three callers, and they are not the same risk

This is the part I would want settled before code, because "make it expand groups" is one
sentence and three different decisions:

| caller | direction of the bug today | what expansion changes |
|---|---|---|
| `canAssignLegacyRole:360-381` | **fail-closed** — a group-granted admin is refused | they can assign; `assignableRoles` (#123) starts answering correctly |
| `grantRole:160-173` (escalation guard) | **fail-closed** — a group-granted admin cannot grant | they can grant. This is the one to think hardest about |
| `revokeGrant:219-232` | **fail-closed** — cannot revoke | they can revoke |

All three currently refuse rather than allow, so **nothing is exposed today** and this is a
correctness issue, not an incident. That also means the fix can only ever *widen* — every
change here turns a `false` into a `true`, so the review question is not "does it still
refuse the right people" but "does it now allow exactly the right people".

## The one that needs a ruling before code

`grantRole`'s escalation guard is "you may only give away what you hold". With group
expansion, *what you hold* becomes *what your groups hold* — and group membership, after
#113, is writable by `addGroupMember`. If #113 ships without the permission check I flagged
(FINDING-3 there), then after #128 the chain is: add yourself to a group → inherit its
permissions → pass the escalation guard → grant yourself the role directly.

**These two issues are load-bearing on each other and #128 must not merge first.** If PMO
sequences #128 before #113's guard lands, say so explicitly in both ledgers, because neither
issue's diff shows the other half.

## Structural recommendation

Do not add a group query to `heldPermissionIds`. Call `grantPrincipalPairs` — the same helper
the engine and `readableScope` already use — and build the `where` as
`AND: [{orgId, scope, expiry}, {OR: pairs}]`, which is the shape `readableScope` landed on in
#96. One expansion rule in one place was the whole argument for `groupMembership.js` existing;
a second query here recreates the split this issue exists to close.

Note `heldPermissionIds` has a `targetWorkspaceId` scope clause the engine's path does not —
keep it. Group grants can be workspace-scoped (`workspaceScopeKeysFor` in #113 reads exactly
those rows), so the scope filter must apply to the group pairs too, not just the principal's.

## REQUIRED RED FIXTURES

```
RF-1 : a user whose ONLY super_admin path is a group grant can assign every legacy
       role AND grantRole accepts from them; a user in a group with NO grant still
       cannot
mut  : the current principal-only filter
why  : every existing fixture grants the principal directly, so all of them are green
       with or without expansion. The empty-group control is what stops the fix from
       degenerating into "any group member holds everything".
```
```
RF-2 : a group grant scoped to workspace A does NOT satisfy a grantRole targeting
       workspace B, and does NOT satisfy an org-wide target
mut  : drop the `scope` clause from the AND when pairs are present
why  : an org-wide group grant is green under that mutation for every target, and a
       fixture that only ever grants org-wide never sees it. This is the clause the
       principal-only version already had — the fix must not lose it while gaining
       groups.
```
```
RF-3 : an api-key actor does NOT inherit its creator's groups
mut  : pass `grantPrincipal` through grantPrincipalPairs unconditionally
why  : engine.js:187-193 refuses this expansion explicitly and says why (the key
       would widen whenever someone edits a group, to grants its scope list was never
       reviewed against). heldPermissionIds must make the SAME refusal, or the two
       diverge again in the opposite direction. Every user fixture is green under the
       mutation.
```
```
RF-4 : the engine and heldPermissionIds agree — for one fixture actor, assert
       engine.authorize("role.grant") and canAssignLegacyRole return the same answer,
       for a group-granted and a directly-granted actor
mut  : any of the above
why  : this is the invariant the issue is about; assert it directly rather than only
       asserting each side's output.
```

## Residual to name in the ledger either way

`workspaceScopeKeysFor` (#113) and `heldPermissionIds` both hardcode `orgId: 1`. Consistent
with `SCOPE_KEY(1)` today, but this issue adds a third reader of group rows, and group ids are
addressable without an org. One line saying single-org is the convention until the column
lands.

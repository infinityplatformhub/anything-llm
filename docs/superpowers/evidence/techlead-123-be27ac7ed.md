# Techlead-1 — #123 `be27ac7ed` (auth): **PASS**, one residual to carry

§7.14: no suite run. Probes are in-process `node -e` in a detached worktree
(`git worktree add --detach /tmp/tl-123b be27ac7ed`, `node_modules` symlinked, Node 22).
Delta read against my REJECT of `7b4fe4f34`.

## FINDING-1 closed, and closed the way that keeps one rule in one place

`assignableRoles.js:41-42`:

```js
if (!actor) return [];
if (actor.type !== "user" && !isExemptPrincipal(actor)) return [];
```

with `isExemptPrincipal` exported from `policyRepository` (`:386-390`) rather than
re-spelled locally, and its export comment naming the reason (a second copy of the rule is
how the two answers drift). That is the better of the two fixes I offered — the endpoint now
makes the same exemption `canAssignLegacyRole` makes internally, from the same predicate.

Measured through the helper:

```
isExemptPrincipal exported: function
single-user -> exempt=true    core-jobs -> exempt=true
api-key:7   -> exempt=false   embed     -> exempt=false
assignableRolesFor(singleUser, canManageUsers:true)  -> the exempt path is reached
assignableRolesFor(singleUser, canManageUsers:false) -> []      (gate still first)
```

The last line matters and is right: exemption does not bypass the `user.manage` gate, so the
same-body invariant RF-6 asserts still holds for an exempt principal.

## RF-4b landed stronger than I asked for

I asked for the api-key control in the same test. Dev1 went further and gave the key **its own
`super_admin` grant row** for the duration of the test, with the reason written down: without
a grant, `heldPermissionIds` resolves nothing for `api-key:99`, every target role comes back
false from the set comparison itself, and the test passes whether or not the exemption is
widened to every `type: "service"`. With the grant, the comparison would answer "all three",
so `[]` can only be the exempt-set check. They state they verified the weak version was green
under the over-correction.

That is the difference between a control that constrains the fix and one that decorates it.
The `finally` cleanup of the fabricated grant is there too.

RF-4 itself now calls `assignableRolesFor` rather than `canAssignLegacyRole`, with a comment
recording that the first version proved the rule instead of the code using it.

## Residual to carry (NOT a blocker for this issue)

`heldPermissionIds:90-115` reads `principal_role_grants` filtered on the actor's own
`principal_type`/`principal_id`. It does **not** expand group membership. Measured against a
stubbed db: for a user holding nothing directly, `canAssignLegacyRole("admin")` returns
`false` and **`group_members` is never queried**.

Since #96, `engine.evaluate` and both halves of `documentFilter` DO expand groups
(`engine.js:178-200`). So a user whose `super_admin` comes via a group is allowed by the
engine and refused by the assignment guard — and `assignableRoles` inherits the refusal. The
field will tell such a delegated admin they may assign nothing while `user.manage` reads
true, which is the RF-6 invariant's other direction.

**Not this issue's to fix, and fail-closed** — it refuses rather than allows, so nothing is
exposed. But it is the one case where the new field is wrong, and it is exactly the delegated
admin the issue was built for. Should be an issue of its own against `heldPermissionIds`
(alongside `grantRole`, which reads the same function and so has the same gap). Flagging it
here so it is not discovered as "the assignableRoles bug".

## Verdict

**PASS.** The blocker is closed at the right level, the control test is stronger than the one
I specified, and nothing else in the delta moved.

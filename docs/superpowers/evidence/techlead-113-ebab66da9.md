# Techlead-1 — #113 S4a `ebab66da9` (auth): **REJECT**, one blocker

§7.14: no suite run. Probes are in-process `node -e` in a detached worktree
(`git worktree add --detach /tmp/tl-113f ebab66da9`, `node_modules` symlinked, Node 22).
Delta read against my slice-2 read of `5227c176e`.

## Everything I raised is fixed, and fixed correctly

- **FINDING-2 (cursor)** — `_enumerate:242-248` throws `IdentityCapabilityError` for a
  non-null cursor. Measured: `listPrincipals({cursor:"4"})` → `IdentityCapabilityError`, and
  **`listGroups({cursor:"2"})` too** — the refusal is in `_enumerate`, so both enumerations
  get it from one place. The docblock now measures the harm (235/250) instead of asserting
  it. Right fix, right level.
- **FINDING-1 (`has_more`)** — `alwaysToken` added to the fixture (`server.js:130-134`).
  Measured: real driver with `alwaysToken:true` → 250 principals over pages 1-5. Mutated to
  `nextToken: data.page_token ?? null` → **2062 pages in 3 seconds, never terminates**. The
  mutation is now lethal where it was invisible.
- **NIT-1** — `try/finally` around the staged `migrate deploy`.
- **NIT-2** — a row with no `user_id` throws `IdentityUnavailableError`. Measured. The
  reasoning for *refuse* over *skip* (a skipped principal is absent, and absence is how the
  reconciler decides someone left) is the correct read of this file's own rule.

RF-5's self-caught scope bug is the strongest thing in the delta: the group-grant half of
`workspaceScopeKeysFor` (`:411-421`) exists because a user whose only path to a workspace is
through the group has no `workspace_users` row, so a membership-only lookup published `org:1`
and nothing else. Found by a test that asserted the **emitted keys** rather than trusting that
invalidation happened — which is the shape that catches this class and the reason I would
otherwise have missed it too.

---

## FINDING-3 (blocker) — `addGroupMember` has no permission check, and group membership is now a grant path

`addGroupMember:443-459` and `removeGroupMember:471-487` call `requireActor(actor, …)` and
nothing else. Compare the sibling in the same file, `grantRole:160-173`:

```js
if (!isExemptPrincipal(actor)) {
  const rolePerms = await permissionIdsForRole(tx, roleId);
  const held = await heldPermissionIds(tx, actor, workspaceId);
  ...
  throw new AuthorizationContractError("grant refused: role carries permissions the granter does not hold in this scope");
}
```

`requireActor` only asserts the argument is not null (`:33-39`). So **any** actor — a `member`,
a workspace `owner`, any principal a future ingress hands in — may add a user to a group, and
since #96 that group's grants are expanded by `engine.evaluate` and both halves of
`documentFilter`. Adding someone to a group carrying `super_admin` is therefore a grant of
`super_admin` that never passes the set-containment check `grantRole` exists to enforce.

This slice is what makes it reachable: before it, `group_members` had no gateway function at
all and every writer was a test. Now there is a documented, exported, transaction-correct API
that looks like the safe way to do it — and its docblock's argument for living in
`policyRepository` (*"a caller that forgets the bump produces a silent staleness bug"*) is
exactly the argument for the permission check being here too. A caller that forgets the
authorization check produces a silent escalation, and nothing about
`repository.addGroupMember({actor, groupId, userId})` looks wrong.

Not live — measured: no caller anywhere outside the new test
(`grep group_members` repo-wide finds only `engine.js`'s comment, `explainAccess.js:90`,
`groupMembership.js`, the schema, and test files; `addGroupMember`/`removeGroupMember` have
zero callers). S12 offboarding and the S4b reconciler are the callers being built for it. That
is why it is worth one commit now: the first consumer will pass whatever actor it has.

**Fix** — the same shape as `grantRole`, keyed on the group's own grants:

```js
if (!isExemptPrincipal(actor)) {
  // permissions the GROUP carries, at every scope it is granted in
  const groupPerms = await permissionIdsForGroup(tx, groupId);
  const held = await heldPermissionIds(tx, actor, null);
  const missing = [...groupPerms].filter((p) => !held.has(p));
  if (missing.length) throw new AuthorizationContractError(
    "membership refused: the group carries permissions the actor does not hold");
}
```

If PMO would rather keep this slice to the version-bump residual, the alternative I accept is
an explicit **`// SECURITY: callers must authorize`** on both functions plus a ledger residual
naming S12/S4b as the issues that must add it — but not silence. A gateway that looks
authoritative and checks nothing is worse than no gateway.

```
RF-8 : a `member` actor calling addGroupMember for a group holding super_admin is
       REFUSED; an exempt principal (SERVICE_PRINCIPALS.coreJobs) is allowed;
       a super_admin actor is allowed
mut  : the current requireActor-only body
why  : all six existing RF-5 tests pass `SYS` (an exempt/system principal), so every
       one of them is green with any permission check present or absent. Only a
       non-exempt, under-privileged actor separates the two, and the exempt control
       is what stops the fix from breaking seeds and migrations.
```

## NIT-3 — `workspaceScopeKeysFor` hardcodes `orgId: 1`

`:415` filters `principal_role_grants` on `orgId: 1` while the surrounding file threads
`SCOPE_KEY(1)` the same way — consistent with the existing single-org convention, so not a
defect today. But this is a **new** query and the group is addressable by id alone, so a
group in org 2 would have its grants read under org 1's filter and silently contribute no
keys. One line saying "single-org until the orgId column lands, same as SCOPE_KEY" keeps it
from reading as an oversight.

## NIT-4 — the `group_membership` change type is new; confirm the subscriber does not filter on it

`bumpVersion(tx, "group_membership", …)` introduces a `change_type` value nothing else emits.
`FilterCache.isStale` compares version heads and `invalidateScopes` matches on `scopeKeys`, so
neither reads `change_type` — verified by reading `cache.js:38-42,111-115`. Recorded because a
future subscriber that switches on `change_type` would silently drop these, and the ledger
should name it.

## Verdict

**REJECT** on FINDING-3. The Lark half of this slice is finished work — every finding from my
slice-2 read is closed with a measurement rather than an assertion, and the RF-6 mutation now
hangs where it used to pass. The blocker is in the `policyRepository` half, and it is one
guard plus one test.

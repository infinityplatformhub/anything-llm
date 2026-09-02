# Techlead-1 — pre-check on Dev3's #113 escalation-guard design (before SHA)

Read: `policyRepository.js:150-200` (`grantRole` guard), `:90-115` (`heldPermissionIds`),
`:300-340` (`grantDocumentAcl`/`revokeDocumentAcl`), `engine.js:220-240`,
`documentFilter.js:88-100`.

## The design is right in shape. Three answers, one of which changes it.

**Guarding `remove` as well as `add` — ACCEPT, and this is the part I would have missed.**
Deny-wins means removal is a widening. Correct, and the reason it is easy to get wrong is that
`removeGroupMember` reads like a de-escalation.

**`permissionIdsForGroup` not filtered by workspace — ACCEPT.** A `group_members` row is a
single fact that opens every grant the group holds at every scope; there is no per-workspace
membership to filter by. Requiring the actor to contain the union is the conservative
direction, and the asymmetry with `heldPermissionIds(tx, actor, null)` (org-wide only) makes it
stricter still, which is the right way round for a guard.

**`NIT-3` fixed in two places (filter + `SCOPE_KEY(orgId)` at the caller) — ACCEPT**, and the
N3 mutant surviving the first round because every fixture was org 1 is exactly the reason that
mutation was worth running.

## FINDING — "group holds no grant → allow" is right for role grants and WRONG for denies

The early return is safe against the escalation `grantRole` guards, for the reason PMO gives:
a new grant to the group must itself pass `grantRole`'s containment check. I accept that half.

But the deny path does not go through `principal_role_grants` at all. `document_acl` carries
`effect: "deny"` rows keyed on `{principal_type: "group", principal_id}`
(`grantDocumentAcl:305-320`), and `documentFilter:91-99` reads them for every group the actor
belongs to. **A group used purely to deny has zero `principal_role_grants` rows.**

So under the design as described:

```
groupPerms = permissionIdsForGroup(tx, groupId)   // reads role grants -> empty
if (groupPerms.size === 0) return allow            // early return fires
removeGroupMember(actor, denyGroupId, victimId)    // permitted
```

Any actor may pull a user out of a deny group, and the user immediately gains access to every
document that group was hiding. That is the widening the `remove` guard was added for,
arriving through the one branch that skips it.

`role_permissions` can also carry `effect: "deny"` (`engine.js:233`), so a role granted to a
group can itself be a deny-carrier — but that case *does* have a grant row and so is caught by
the containment check. The `document_acl` case is the one with no row at all.

**Recommended fix — make the early return conditional on there being nothing to lose:**

```js
const groupPerms = await permissionIdsForGroup(tx, groupId);
const denyCount = await tx.document_acl.count({
  where: { orgId, principal_type: "group", principal_id: String(groupId), effect: "deny" },
});
if (groupPerms.size === 0 && denyCount === 0) return; // nothing this membership carries
```

and for a group that carries only denies, require something explicit — `document.share` or
whatever the ruling picks — rather than falling through to a containment check over an empty
set, which would pass for everyone.

If PMO would rather keep this slice narrow, the alternative I accept is: keep the early return,
and **only for `removeGroupMember`** refuse when the group has any deny row, with a comment
naming the asymmetry. What I would not accept is the early return unqualified, because it makes
the `remove` guard — the subtler half Dev3 correctly added — unreachable for the only principal
shape that needs it.

```
RF-9 : a group with NO role grant but ONE document_acl deny row; a plain `member`
       actor calling removeGroupMember for it is REFUSED; the same actor removing
       from a group with neither is ALLOWED
mut  : the unqualified `if (groupPerms.size === 0) return` early return
why  : every RF-8 fixture gives the group a role grant, so all six are green with the
       early return present or absent — the branch only fires for a group with no
       grants, and no fixture builds one. The "neither" control is what stops the fix
       from blocking ordinary directory sync, which is the reason the early return
       exists.
```

## One check on RF-8 as described

"6 tests not using SYS" is the right correction. Make sure one of them is an **exempt**
principal (`SERVICE_PRINCIPALS.coreJobs`) asserted to be ALLOWED — the fix's failure mode is
over-correction, and directory sync runs as an exempt principal. Without that control, a guard
that refuses everyone passes all six.

# Techlead-1 — #96 pre-read: group grants in `evaluate` (before Dev3's SHA)

Read against `approof/main`: `engine.js`, `documentFilter.js`, `explainAccess.js`,
`actorResolver.js`, `scopeCeiling.js`, `policyRepository.js`, `cache.js`, `admin.js`,
`schema.prisma`. Recon `docs/superpowers/recon/s4-lark-org-sync.md` @ `7eb4b8dc0` §0.

Dev3's finding is confirmed on the code: `evaluate` builds `grantWhere` from
`grantPrincipal.type` / `.id` alone (`engine.js:168-183`) and never reads `group_members`.
Recommendation (1) — fix the engine as its own issue before S4 — is the right call, and the
argument for it is stronger than the recon states: `documentFilter` **already** expands
groups on the deny side, so today a group can *remove* a document from someone but the same
group cannot *give* them anything. The system is already asymmetric, not merely incomplete.

Answers to the four questions, in order.

## (1) The two existing expansions, and which one `evaluate` should reuse

They are not the same expansion and neither is a drop-in.

**`documentFilter.js:73-81`** — `group_members` by `user_id`, guarded by
`actor.type === "user"`, producing `groupIds: string[]`. Used for two things:
`principalPairs` on the **deny** query against `document_acl` (`:86-95`), and echoed into
the returned filter as `attributes: { groupIds }`. Measured: **nothing consumes
`attributes.groupIds`** — no reference in `vectorPredicate.js`, `retrievalFilter.js`,
`vectorAclMetadata.js`, `retrievalSupport.js`, or any endpoint. It is carried and dropped.

Two things about it that matter for reuse:

- It keys on `actor.id`, **not** `grantPrincipal.id`. For an API key the actor is
  `{type:"service", id:"api-key:7", grantPrincipal:{type:"user", id:"42"}}`, so
  `actor.type === "user"` is false and `groupIds` is `[]`. The key never picks up its
  creator's group denies. That is a live inconsistency with `readableScope` immediately
  below it (`:159-160`), which *does* switch to `grantPrincipal`. Whichever helper #96
  creates must take a **principal**, not an actor, or it inherits this bug.
- It reads groups **org-wide**, unfiltered by `orgId`. `groups` has an `orgId` column
  (`schema.prisma:824`); `group_members` does not, so the filter has to go through the
  relation. Today single-org makes this invisible; a helper that bakes in the omission
  makes it permanent.

**`explainAccess.js:89-95`** — the inverse direction: given a `document_acl` row whose
`principal_type === "group"`, list that group's `user_id`s. It answers "who is in this
group", not "which groups is this user in". It cannot be the shared helper; it is a
consumer of the same table for a different question.

**Recommendation for the ruling.** The helper is a *new* third function, and the ruling
"no third expansion" is satisfied by **deleting the first**, not by wrapping it:

```js
// utils/authorization/principals.js  (the file already exists, 1.1K)
/** Group ids a PRINCIPAL belongs to. Takes the grant principal, never the Actor:
 *  an API key's groups are its creator's groups. */
async function groupIdsFor(principal, orgId, db) {
  if (!principal || principal.type !== "user") return [];
  const rows = await db.group_members.findMany({
    where: { user_id: Number(principal.id), groups: { orgId } },
    select: { group_id: true },
  });
  return rows.map((r) => String(r.group_id));
}
```
and `documentFilter.js:73-81` becomes a call to it. Then there is exactly one expansion,
`explainAccess` keeps its unrelated inverse read, and #96 fixes `documentFilter`'s
actor-vs-principal bug as a side effect rather than leaving two functions that disagree.

If PMO would rather not touch `documentFilter` in this issue, then the honest framing is
that #96 ships expansion **number three** and files the convergence — not that it reused
one. I would rather absorb the small change now; the two-expansions state is how the deny
and allow sides drifted in the first place.

## (2) Deny-precedence and the role ceiling

**Deny-precedence is unaffected, and this is worth stating in the issue because it looks
like it should be.** `evaluate`'s deny wins at the **role_permissions** level
(`engine.js:190-196`): it collects every role from every grant, then `rows.some(effect ===
"deny")`. Adding group-derived grants adds role ids to the same `roleIds` array, so a deny
carried by *any* role — direct or group-derived — still wins over every allow. No ordering
question arises because there is no principal precedence in the model at all. Measured:
the seeds contain **no `effect: "deny"` role_permissions rows** (`grep deny
prisma/seeds/permissions.js` = 1 hit, a comment). So deny-precedence is untested by
construction today and will stay that way unless #96 seeds one. **Ask Dev3 for one RED
fixture here**: group grants role A (allow), direct grant role B (deny) → denied; and the
mirror. Without it, "deny still wins across the new edge" is a claim, not a test.

**The ceiling is where the real answer is "yes, and it already works — verify, don't
change".** `scopeCeiling.js:48-52` builds `ceilingActor` from `keyGrantPrincipal(creatorId)`
= `{type:"user", id:<creator>}`, then calls `engine.authorize(...)` per scope (`:107-115`).
It asks the engine. So the moment `evaluate` expands groups, the ceiling expands with it —
**no ceiling code changes, and none should be written.** A creator who holds `system.write`
only through a group can, after #96, mint a key carrying `system.write`. That is correct
(the ceiling is defined as "what the creator holds", and after #96 they hold it) but it is
a **new** minting capability appearing without any admin action, so it belongs in the
issue's residuals in those words.

The trap to name for Dev3: do **not** add group expansion to `ceilingActor` or to
`keyGrantPrincipal`. Both would produce a second expansion in exactly the place the ruling
forbids, and the engine call already covers it. The ceiling's correctness here comes from
delegating, and a "helpful" second read would silently double it.

## (3) view-as-user and delegated admin

`admin.js:243-252` mints `makeJWT({id: target.id, username, impersonatedBy: admin.id})`;
`validatedRequest.js:126` copies the claim to `locals.impersonatedBy`;
`actorResolver.js:137-144` builds `{type:"user", id: String(target.id), impersonatedBy:{...}}`.
The actor **is** the target, so once `evaluate` expands groups the target's group grants are
picked up automatically — nothing in the view-as path needs a change. That is the right
answer and the desired one: a support engineer viewing as a user must see what that user
sees, and today they see less.

Two things to require of the SHA:

- **A test that the group is expanded for the *target*, not the admin.** The impersonated
  actor carries the target's id, so a naive implementation is already correct; but a
  version that reached for `impersonatedBy` (or for `response.locals.user`) would silently
  read the *admin's* groups and widen every view-as session to admin reach. The failure is
  invisible in single-group fixtures, so the fixture needs the admin and target in
  **different** groups with different roles.
- **The blanket mutation deny must be shown to survive.** `authorize` returns
  `impersonated_mutation_denied` before `evaluate` runs (`engine.js:72-74`), so group
  expansion cannot reach it — but that is exactly the sort of ordering a refactor breaks.
  One fixture: impersonated actor whose **group** holds `system.write` → still denied,
  reason unchanged.

Delegated admin: no separate mechanism exists in the tree (I searched); a delegated admin
is a user with grants. Nothing extra is needed.

## (4) Deploy-time: I agree — no flag, but two things must be in the issue

Agreed that this is a plain bug fix and a flag would be worse: a flag defaulting to off
ships the broken behaviour as a supported configuration, and a flag defaulting to on is the
merge with extra code. Also, `ASSIGNABLE_PRINCIPAL_TYPES` already offers group grants in the
admin UI, so any existing group grant was authored by an admin who believed it worked. The
fix delivers the intent, it does not invent one.

But "no flag" is only safe if the blast radius is stated, and two parts of it are not
obvious:

- **Cache invalidation does not cover this edge.** `cache.js:27-35` keys filters on
  `actor.type|id|action|orgId|workspaceIds|allowListDigest` — **no group component** — and
  `scopesFor` (`:37-41`) emits `org:<id>` and `workspace:<id>` only. Meanwhile
  `policyRepository.js` writes a `policy_versions` row on every grant/ACL change, and I find
  **no writer for `group_members` at all** in the tree (`grep group` in `policyRepository.js`
  = 0). So adding or removing a **member** changes that user's effective permissions and
  bumps **no policy version** — the filter cache serves the old answer until its 30s TTL
  expires. For an addition that is a delayed grant; for a removal it is 30 seconds of access
  after offboarding, which is the direction that matters and is precisely S4/S12's use case.
  This does not block #96 (the engine's `authorize` is not cached; only `documentFilter` is),
  but it must be a named residual, because S4 will build membership sync directly on top of
  it. The fix is one line in whatever writes `group_members` — bump the policy version — and
  it belongs to whichever issue first writes that table.
- **The rollout is measurable and should be measured before merge.** One query answers "how
  many people does this change today":
  `SELECT count(DISTINCT gm.user_id) FROM group_members gm JOIN principal_role_grants g ON g.principal_type='group' AND g.principal_id::int = gm.group_id;`
  If that is 0 on every deployment, the change is inert on arrival and the residual is only
  about the future. If it is not 0, the issue should say which roles arrive for whom. Cheap,
  and it converts "this changes existing permissions" from a warning into a number.

## Two additional asks for the SHA

- **The performance claim in recon §0 route 1 ("a per-call query on the hottest path")
  should be met, not just noted.** `evaluate` currently issues 3 queries; group expansion
  makes it 4 on every authorized request. The cheap answer is to fold the expansion into the
  existing `principal_role_grants` query with an `OR` over the group principal pairs, at the
  cost of one `group_members` read that can be done once per request rather than per
  resource — note that `authorizeMany` calls `authorize` **per resource** (`engine.js:120`),
  so a naive implementation multiplies the new query by up to 500. That is the one place
  where this fix has a real cost, and it is in the batch path that document listing uses.
- **`grep group engine.test.js` = 0 is the reason this stayed green.** The RED proof should
  be the recon's exact scenario (group holds org-admin, user has no direct grant →
  `no_grants` before, `allowed_by_role` after) **with the control**, and the mutation should
  be removing the expansion, not renaming it.

# Techlead-1 — pre-read: `my-capabilities: computed assignableRoles`

Written before the contract is posted, from the #121 ruling and the code the field must agree
with. Read on `approof/main`: `utils/authorization/policyRepository.js:29-30,90-115,360-381`,
`utils/authorization/legacyRoleGrants.js:23`, `utils/helpers/admin/index.js:18-55`,
`endpoints/system.js` (`my-capabilities`), `utils/authorization/actorResolver.js`,
`__tests__/security/authorization/workspaceScopedCapabilities.test.js` (#40 t2).

Four findings that change what the field must be, then the fixtures. Two of them
(FINDING-1, FINDING-2) should reach Dev1 **before** the contract is written, because they
decide the field's shape rather than its tests.

---

## FINDING-1 — `manager` and `default` cannot be separated, ever

`canAssignLegacyRole` maps the target legacy role through `ORG_ROLE_FOR_LEGACY`
(`legacyRoleGrants.js:23`):

```js
{ admin: "super_admin", manager: "member", default: "member" }
```

Both `manager` and `default` resolve to the **same org role**, `member`. The comparison is
then `permissionIdsForRole(member) ⊆ heldPermissionIds(actor)` — identical input, identical
answer. So `assignableRoles` can only ever be one of three values:

```
[]                                  actor holds nothing
["manager", "default"]              actor holds member's permissions
["admin", "manager", "default"]     actor holds super_admin's permissions
```

`["default"]` alone, or `["admin"]` alone, are **unreachable**. That matters twice:

- The RF PMO proposed — *manager fixture must not get admin* — is correct but weaker than it
  looks: a manager fixture returns `["manager","default"]` under any implementation that
  calls `canAssignLegacyRole` at all, because the two collapse. **The fixture that
  discriminates is an actor holding neither**, expecting `[]`, and a super_admin expecting
  all three. Include all three tiers or the middle one proves only that the call happened.
- If a later issue splits `manager` from `default` at the org-role level, this field changes
  shape silently. Worth one line in the code saying the collapse is a property of
  `ORG_ROLE_FOR_LEGACY`, not of this endpoint — otherwise the next reader assumes the field
  is finer-grained than it is.

## FINDING-2 — the field must not be computed for an api-key actor, and `[]` is the wrong reason to give

PMO's sketch says api-key → `[]`. Right answer, but the mechanism matters and the obvious
implementation gets it wrong.

`canAssignLegacyRole` calls `heldPermissionIds(tx, actor, null)` (`:378`), which queries
`principal_role_grants` on `actor.type` / `actor.id` **directly** — it does not consult
`grantPrincipal`. For an api-key actor (`{type:"service", id:"api-key:7", grantPrincipal:{...}}`)
that finds no rows and returns an empty set, so every target role fails the subset test and
the answer is `[]` by accident.

That is the correct output for the wrong reason, and it is fragile in a specific way: if
anyone later teaches `heldPermissionIds` to resolve `grantPrincipal` — which is exactly what
`engine.evaluate` and `readableScope` already do — an api-key would silently start reporting
its **creator's** assignable roles. The endpoint would then tell a key holder they may create
admins.

**Ask for an explicit guard**: `actor.type !== "user"` → `[]`, before any query, with the
reason written down. Same shape as #40 task 2's guard, and the same argument I made there:
keying on the type rather than on what a query happens to return is what survives a change to
the query.

`isExemptPrincipal` (`policyRepository.js:29-30`) returns `true` for `single-user` and
`core-jobs`, so `canAssignLegacyRole` short-circuits to `true` for the single-user service
principal — which is why PMO's "single-user → all three" is right. That branch is deliberate
and should be exercised, not bypassed by the type guard: guard on `type !== "user"` **and**
`!isExemptPrincipal(actor)`, or single-user regresses to `[]`.

## FINDING-3 — view-as-user gets the target's roles automatically, and that is arguably wrong

`resolveActor` builds the impersonated actor with the **target's** id, so
`canAssignLegacyRole` computes the target's assignable roles. PMO's sketch says "view-as gets
the target's" and by construction it does.

But consider what the field is for: it gates the role dropdown in `EditUserModal`. An
impersonated session **cannot mutate** — `engine.authorize` returns
`impersonated_mutation_denied` before any policy lookup for every non-read action, and
`role.grant`/`user.manage` are not in `READ_ACTIONS`. So a view-as session that reports
`["admin","manager","default"]` renders a dropdown whose every option the server will refuse.

This is the same class as #40 task 2's write-shaped capabilities coming back false under
impersonation — and there, the answer was to let the engine's blanket deny do its work and
pin it with a test. Here the field does not go through `authorize`, so nothing denies it.

**My recommendation:** `assignableRoles` is `[]` for an impersonated actor, with the reason
written down — a support engineer viewing as an admin should not be shown a control that
cannot work. If PMO prefers the target's list (arguably more faithful to "see what they see"),
then the test must pin that the *mutation* is still refused, so the divergence is recorded
rather than discovered.

Either way this needs a ruling before the contract, because both answers are defensible and
they produce different tests.

## FINDING-4 — the field is per-actor, and `#40 t2`'s byte-identical test does not see it, but its sibling does

PMO asked about the effect on `#40 t2`'s byte-identical assertions. Checked:

- `an absent workspace and a foreign one are byte-identical` compares two responses **from
  the same caller**, so a new top-level field appears identically in both and the raw-string
  comparison still holds. **No impact.**
- `no query answers the org-only shape, unchanged` asserts
  `expect(body).not.toHaveProperty("workspace")` — it does not enumerate top-level keys, so a
  new sibling key does not break it. **No impact.**
- The one to check is the **`can()`/`capabilities` shape assertion**:
  `Object.keys(body.capabilities).sort()` equals `ORG_CAPABILITIES`. If `assignableRoles` is
  added **inside** `capabilities`, that test goes red and — more importantly — the field would
  be a non-boolean sitting in a map every consumer reads with `=== true`. `useCapabilities`'s
  `can()` would answer `false` for it, harmlessly, but the map's contract ("every value is a
  boolean") would be broken.

**So: `assignableRoles` must be a sibling of `capabilities`, not a member of it.** That also
keeps it symmetric with `workspace`, which is already a sibling. Say so in the contract; it is
the kind of thing that gets decided by whoever types the response object.

---

## REQUIRED RED FIXTURES

**RF-1 — three tiers, because the middle one alone proves nothing**
```
fixture   : (a) actor with no org grant        -> []
            (b) actor holding member           -> ["manager","default"] (both, per F1)
            (c) actor holding super_admin      -> ["admin","manager","default"]
mutation  : return every legacy role unconditionally
green why : the manager fixture alone returns ["manager","default"] under the mutation too —
            it differs from the correct answer only by the absence of "admin", which a
            fixture that never asks about admin cannot see. (a) and (c) are what
            discriminate.
```

**RF-2 — the answer agrees with the write path, not with a re-derivation**
```
fixture   : for each role the field reports, call the real admin write path
            (validRoleSelection via POST /admin/users/new) and assert it is ACCEPTED;
            for each role it omits, assert it is REFUSED
mutation  : compute the list from a hardcoded hierarchy (admin > manager > default)
            instead of canAssignLegacyRole
green why : a hardcoded hierarchy produces the SAME three lists for the three stock
            roles — it is wrong only for a delegated admin whose grants do not match
            their legacy role string, which is the case T-7 built this for and the one
            no stock fixture contains. Driving the real write path is what couples the
            two answers; asserting the list's contents does not.
```
This is the fixture I care most about. The whole point of the field is that the UI and the
server agree; a test that checks the list against an expected list checks the test's opinion.

**RF-3 — an api-key actor gets `[]`, proven by the type guard, not by an empty query**
```
fixture   : api-key actor whose CREATOR holds super_admin; assert []
mutation  : remove the `actor.type !== "user"` guard
green why : without the guard the answer is still [] today (heldPermissionIds finds no
            rows for "api-key:7"), so this fixture is green either way UNLESS the test
            also asserts that no grant query ran for the creator — spy on
            principal_role_grants.findMany and assert it was not called with the
            creator's id. See FINDING-2 for why the accidental [] is not safe to rely on.
```

**RF-4 — single-user gets all three, via the exempt branch**
```
fixture   : SINGLE_USER_ACTOR ({type:"service", id:"single-user"}) -> all three
mutation  : guard on `actor.type !== "user"` alone, without the isExemptPrincipal escape
green why : an api-key fixture is green under that mutation (both are `service`), so
            only the single-user case distinguishes the two guards.
```

**RF-5 — impersonation** (shape depends on the FINDING-3 ruling)
```
if [] : impersonated admin -> [], and a control that the same admin un-impersonated
        gets all three
if target's: impersonated admin -> target's list, AND a test that POST /admin/user/:id
        with any of those roles is still refused with impersonated_mutation_denied
green why: either way, a test that only checks the list is green under both rulings —
        the discriminating assertion is on what the server does with the roles the
        field advertised.
```

---

## Addendum — ruling "way 1" adopted (no objection), two measured notes

**No objection to way 1.** Computing `assignableRoles` only when the actor holds
`user.manage`, else `[]`, is the right shape and is stronger than I asked for: it makes the
field self-consistent without the UI joining anything.

**N-1 — way 1 subsumes FINDING-3 for free.** Measured: `user.manage` is **not** in
`READ_ACTIONS` (`engine.js:22-45` — the set is 18 read actions plus `org.member`), and
`engine.authorize` returns `impersonated_mutation_denied` for any non-read action when
`actor.impersonatedBy` is set (`engine.js:75`). So an impersonated actor fails the
`user.manage` gate and gets `[]` with no impersonation branch written anywhere. Dev1 should
**not** add a separate `impersonatedBy` guard — it would be dead code that hides where the
answer actually comes from. RF-5 becomes: impersonated admin → `[]`, and the mutation that
proves it red is **adding `"user.manage"` to `READ_ACTIONS`**, not removing a local guard.

**N-2 — reuse the decision already in `decisions`, do not re-authorize.**
The handler already computes `user.manage` as part of `ORG_CAPABILITIES`
(`system.js:114`, batched at `:1846`). A second `engine.authorize` call for the gate would be
a second decision that can disagree with the one in the same response body — the exact
UI/server split way 1 exists to close, reintroduced one level down. Read the boolean out of
`decisions` / `answer.capabilities` instead.
```
RF-6 : assert capabilities["user.manage"] === false AND assignableRoles === []
        in the same response, for the same caller
mut  : compute the gate with its own engine.authorize call
why  : green under any consistent engine — it goes red only when combined with a
        fixture where the two calls CAN differ (org scope resolved twice), so pair
        it with a same-body invariant rather than a second stubbed call.
```

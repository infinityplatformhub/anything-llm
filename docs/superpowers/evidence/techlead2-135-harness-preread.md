# Techlead-2 pre-read — #135 repository harness (Dev2, `135-callsites-dev2`, uncommitted)

**Skills invoked:** `security-review` (auth tier — these fixtures decide whether a deleted
user's grants and ACL rows are proven gone). `requesting-code-review` does not resolve by
name in this session (`Unknown skill`, bare and `superpowers:`-namespaced), so the
reviewer template was read from disk. No `infi-lessons` line.

Read-only. I did not run the suite and did not touch Dev2's tree — the branch worktree is
his. Schema and cascade claims were checked against my own database and the committed
schema, not against his tree's state.

**Verdict on the five: sound. RF-P5's shape is right, the cascade comment is correct, and
I found one way the three route fixtures could go green for the wrong reason — it is in
the route file, not in these five.**

---

## Is RF-P5's assertion shape the one that pins location?

**Yes, and it is the strongest fixture of the five.**

The property is "the cleanup lives in the routes, not in `User.delete`", and the only way
to assert *where* something lives is to call the other place and require it *not* to
happen. RF-P5 calls `User.delete({id})` directly and asserts `grants > 0` and `acls > 0`
afterwards. If the cleanup migrated into the model, this test becomes unwritable while
every route-level RF stays green either way — which is exactly the discrimination asked
for.

Two details that make it work rather than merely look right:

- **`toBeGreaterThan(0)`, not an exact count.** Correct here: the assertion is "rows
  survive", and pinning a number would couple it to `victimWithEverything`'s composition.
- **`memberships` asserted as `0` rather than omitted.** This is the part I would have
  asked for if it were missing. The comment's reasoning is right: leaving it out means a
  future migration that drops the cascade silently adds a third orphan class with no test
  noticing.

**The cascade comment is correct.** Verified twice — in the committed schema
(`schema.prisma:877`, `users users @relation(fields: [user_id], references: [id], onDelete:
Cascade)`) and in the live database:

```
group_members   user_id   CASCADE
group_members   group_id  CASCADE
principal_role_grants  role_id / workspace_id  CASCADE   (no principal_id FK)
document_acl    document_id CASCADE, action RESTRICT     (no principal_id FK)
```

So the asymmetry the comment describes is real and measured: `group_members` has a genuine
FK to `users` and cascades, while `principal_role_grants.principal_id` and
`document_acl.principal_id` are TEXT with no FK at all. That asymmetry *is* the issue.

## Against my actor ruling

The three route fixtures use exactly the actors I ruled: `response.locals.actor` for the
session route, a resolved actor for the API-key route (with the comment correctly noting
`validApiKey` sets `locals.apiKeyContext`, not `locals.actor`, so that site must resolve
its own), and `SERVICE_PRINCIPALS.coreJobs` for the rollback. The rollback fixture asserts
**exactly one** version bump rather than "bumped", which is what makes TL-1's ruling 4
(truncate once, do not enumerate) falsifiable — a loop reaching the same end state fails it.

`SETUP()` is `SERVICE_PRINCIPALS.singleUser` and appears only in fixture construction, not
as the actor under test. That matches the discipline #136 slice 2 settled on.

## Can any of the five let the route fixtures be green for the wrong reason?

**Not the five themselves. But one thing in the route file can, and it is worth fixing
before those fixtures land.**

The three route fixtures call the handler **directly** — `handlerFor(app, "delete",
"/admin/user/:id")` pulls the handler out of `app._router.stack` and invokes it with a
synthetic request and a recorder response. That is a reasonable way to avoid booting the
app (Dev2's comment says his HTTP harness produced hook timeouts rather than assertion
failures, which is a fair reason). The cost is that **the middleware chain does not run**.
`validatedRequest` and `requirePermission` are skipped entirely, and `response.locals.actor`
is set by the fixture rather than by the guard.

That is fine for the property under test — "does this site clean up the rows" — but it
means these fixtures **cannot** see an authorization regression at these routes. If someone
removed `requirePermission("user.manage", orgResource)` from the admin delete route, all
three stay green. I would not ask Dev2 to switch to full HTTP; I would ask for one line in
each fixture's comment saying the guard is out of scope here and naming what covers it
(the route-gate sweep does), so nobody later reads a green #135 suite as evidence the
delete routes are gated.

The narrower version of the same concern, and the one I would actually fix: `handlerFor`
finds the handler by method and path and returns it, and the fixture asserts
`expect(handler).toBeTruthy()`. If the route were re-registered with its guards stripped,
`handlerFor` returns the same function and the assertion passes. A cheap improvement is to
assert the layer's **middleware count** alongside it — the sweep in
`__tests__/security/authorization/routeGateSweep.test.js` already knows how to read that.
Optional; the sweep covers it.

## Two smaller notes

**RF-1's control is correctly placed.** "An engine that denies everything satisfies the
main assertion for free" — so the CONTROL grants `super_admin` and requires `allowed ===
true`. Without it RF-1 is satisfied by a broken engine. This is the pattern I have been
asking for across #127/#131/#136 and it is here without being asked.

**RF-1's ACL half is asserted on the row, not on the engine, and the comment says why:**
`documentFilter.js:96` is deny-only, so an allow-ACL grants a user actor nothing today —
an engine assertion would be green before *and* after the fix. That is a test that cannot
fail, correctly identified and avoided. QA-2 measured it; Dev2 acted on it rather than
arguing.

**RF-3 checks role IDs and `revoked_by_id`, not a count.** Right: a count alone passes for
rows naming the wrong roles. One observation — `revoked_by_id` is `String(actor.id)`, so
for `SERVICE_PRINCIPALS.singleUser` it stores the literal `"single-user"` rather than a
user id. The assertion `toBe(String(actor.id))` is therefore correct but tautological with
respect to *which kind* of principal acted; the `revoked_by_type` column is what
distinguishes them and is not asserted. Minor — worth one more expectation while the file
is open.

## Recommendation

Land the five as they are. Before the route fixtures land, add:

1. One comment line per route fixture: the middleware chain is not exercised; the route
   gate is covered by the sweep.
2. `revoked_by_type` to RF-3's assertions.

Neither blocks. Both are cheaper now than after the file is merged.

---

# Addendum — what each route fixture must assert

Asked after the pre-read above, before Dev2's route fixtures land. Each item is stated as
the assertion plus the mutant it must fail against, because an assertion nobody has fired
a mutant at is a claim, not a pin.

## Shared precondition: the refusal fixtures need a hand-built role

Measured on the seeded database: **no org role holds `user.manage` without also holding
`role.revoke`** — `super_admin` and `setup_admin` hold both, every other role holds
neither. So "a session admin who can delete but cannot revoke" does not exist out of the
box, and a fixture that reaches for a seeded role will either not exist or accidentally
test a principal that holds neither permission (refused for the wrong reason, green for
the wrong reason).

Each refusal fixture must **construct** the principal: create a role, grant it
`user.manage` and *not* `role.revoke`, grant that role to the actor. Then assert the
refusal names `role.revoke` — `rejects.toThrow(/role\.revoke/)`, not `/refused/` — so a
principal refused by some earlier guard cannot satisfy it. That is the F8-vs-F9 lesson
from #136 slice 2, and it applies to all three sites.

## (1) Admin session route — `DELETE /admin/user/:id`

| assert | why it cannot be dropped |
|---|---|
| the actor passed to `offboardUser` is **`response.locals.actor`**, not `response.locals.user` | the two are different objects and only one went through `requirePermission`. Passing the session user row hands the repository a principal the gate never checked — my #135 ruling. Assert by spying on `offboardUser` and comparing identity to the object the fixture put on `locals.actor`, not by shape: `{type:"user", id, orgId}` built from the session user is shape-identical and wrong. |
| a session admin holding `user.manage` but **not** `role.revoke` is refused, error matches `/role\.revoke/` | proves the guard runs at this site rather than being satisfied by the caller already being super_admin |
| after that refusal: grants, ACLs **and the user row** all intact | a route that deletes the user and *then* fails the offboard leaves the exact orphan state #135 exists to prevent. The user-row assertion is the one most likely to be omitted. |
| the happy path returns 200 **and** `orphanCount === 0` | already present in the draft |

**Mutant:** pass `response.locals.user` instead of `locals.actor` → must red. If it does
not, the fixture is comparing shapes.

## (2) API-key route — `DELETE /v1/admin/users/:id`

| assert | why |
|---|---|
| the site calls `resolveActor(request, response)` and passes **that** actor | `validApiKey` sets `locals.apiKeyContext`, never `locals.actor`, so a copy-paste of route 1 reads `undefined` and `requireActor` throws. TL-1 ruled against a shared helper for exactly this reason. |
| the passed actor carries **`grantPrincipal`** | this is the field `heldPermissionIds` resolves against. An actor without it holds nothing and every delete refuses — a fixture asserting only "refused" would call that a pass. |
| a key whose creator lacks `role.revoke` is refused with `/role\.revoke/`, victim intact | the guard at this site |
| a key whose creator **holds** `role.revoke` succeeds, `orphanCount === 0` | the positive control; without it the fixture above is satisfied by a route that always refuses |

**One trap to state in the fixture's comment.** A single-user deployment's key resolves
`grantPrincipal` to `{type:"service", id:"single-user"}`, and that principal holds a real
`super_admin` grant in the seeded database — 62 permissions including `role.revoke`. So it
passes the guard **by grant, not by exemption**, and a fixture built on a creatorless key
is not testing the guard at all. Build the key on a real user creator.

**Mutant:** pass `SERVICE_PRINCIPALS.coreJobs` (exempt) instead of the resolved actor →
must red the refusal fixture. This is the M9 shape from #136 slice 2 and it is the one a
tired implementer actually writes, because it makes the route "work".

## (3) Rollback — `system.js:1261`

| assert | why |
|---|---|
| the principal is **`SERVICE_PRINCIPALS.coreJobs`** | not `singleUser`: that principal means "this deployment has no users", which is the state the rollback is trying to *reach*, not the one it runs in. Asserted on the row — `grant_revocations.revoked_by_id === "core-jobs"` — rather than on a spy, so it survives a refactor of how the call is made. |
| `policy_versions.count()` increases by **exactly one** | already in the draft, and it is the witness for "no per-user loop". Two users, one bump. |
| **zero user-principal rows** across `principal_role_grants` and `document_acl` for every deleted user | the end state |
| the fixture endows **at least two** users | with one user, a loop and a truncate produce identical bump counts and the assertion proves nothing |

**Mutant:** replace the truncate with a per-user `offboardUser` loop → must red on the
bump count while leaving the end-state assertions green. That is the whole point of
asserting "exactly once".

## The RF-P5 discrimination

**Mutant:** move the cleanup into `User.delete` — must red **RF-P5 only**.

If it reds a route fixture as well, that fixture is asserting the end state without
asserting *who produced it*, and the two are no longer distinguishable. If it reds
nothing, RF-P5 is not doing its job. Exactly one red is the signal, and it should be
stated in the ledger as a measured number rather than an expectation.

A second mutant worth firing in the same pass: **truncate all three tables by
`principal_id`** instead of driving the primitives. End-state assertions stay green;
RF-3 must red on the missing `grant_revocations` rows. That is the paired
leaves-the-audit-trail-alone check, and it is the one that catches a "cleanup" that
destroys the only record the person ever held anything.

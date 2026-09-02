# Techlead-1 — #135 rulings (auth tier)

**Skills invoked:** `security-review` (auth tier), `requesting-code-review` lens applied to the
recon rather than to a SHA — #135 has no code yet, so this is a design ruling. `infi-lessons` not
invoked: no §7.17 line is added here.

**Note on `security-review` scope.** The skill assembles a whole-branch diff, which on this repo
is 8.3 MB of merged history — every issue since the fork. Running its fan-out over that would
report on code already reviewed and merged, not on #135. I applied its threat-model checklist
(authorization bypass, privilege escalation, session/identity confusion, data exposure) directly
to the four decisions instead, and say so rather than claiming a run I did not do.

**Process disclosure, per the user ruling:** I did **not** invoke these skills on #121 or #134.
Both verdicts were reached by direct measurement and source reading. Re-reading their checklists
now against what I wrote: the auth-tier categories they cover — privilege escalation, authz
bypass, identity confusion — are the ones I did probe on both (`#121`'s capability-map gap and
`#134`'s brand provenance and actor resolution). I do not believe either needs re-review, but
that is my judgement and PMO may overrule it.

---

## The finding this issue rests on

Dev3's probe is the strongest recon evidence I have seen on this program: a real
`grantRole`, the real `users.deleteMany`, the real engine, and the result quoted verbatim —
a user granted nothing is authorized `access.diagnose` with `allowed_by_role`, inherited from a
deleted user who held the same id. That is privilege escalation with a measured exploit path, and
the honest limit they attach (the probe calls `setval` itself, so it proves the consequence and
not the frequency of the trigger) is exactly the right way to state it.

I confirmed the mechanism's preconditions independently: `principal_id` is `String` in all three
tables with no relation to `users` (`schema.prisma:804`, `:911`, `:962`), and the engine matches
on `String(grantPrincipal.id)`. The `setval` line is in `scripts/sqlite-to-pg-import.js:102` —
present in worktrees, so it is a real shipped migration path.

---

## (1) Delete vs deactivate: **keep delete, and clean up. Do not convert to deactivation.**

The two are not substitutes and the recon is right that deactivation "moves the question rather
than closing it".

Deleting is what an operator asks for when they mean *remove this person's account*, and it has a
legal dimension (erasure requests) that suspension does not satisfy. #134 chose `suspended` for a
different actor with different information: a **directory sync** acting on absence from a snapshot
it cannot fully trust, where reversibility is the whole point. An admin clicking delete on a named
user is a deliberate act with a human behind it. Same verb, different warrant.

Converting admin deletion to suspension would also leave the orphan grants in place *and* leave
the id live, which is strictly worse than today: the row stays, the grants stay, and nothing is
even nominally cleaned.

**So: delete stays a delete, and #135's job is the cleanup that should always have accompanied it.**

## (2) Cleanup location: **`policyRepository`, and #135 sequences after #136 — but the dependency runs the other way from what the recon assumes**

Agreed on the location, for the reason given: an authorization write outside the module that owns
authorization writes is how the version bump gets forgotten, which is the #96→#113 lesson.

On sequencing, one correction. The recon says `offboardUser` "looks like the natural home for
#135's cleanup". I would put it more strongly: **#135 should not add a second function at all.**
If #136 lands `offboardUser({actor, userId})` that removes grants, ACLs and memberships with one
version bump, then #135 is not "cleanup logic" — it is *three call sites learning to call it*
(`endpoints/admin.js:178`, `endpoints/api/admin/index.js:275`, `endpoints/system.js:1261`).

That framing matters for the contract: if #135 is scoped as "write cleanup", two implementations
of user-removal will exist and drift. Scope it as "route every deletion through the repository's
offboard path", and there is one.

**Sequencing: #136 first, #135 consumes it.** Both touch `policyRepository`; the lane rule applies.

## (3) Retain or delete: **grants and ACLs go; revocations and audit columns stay. Agreed, and the reasoning holds.**

- **`principal_role_grants`, `document_acl` → delete.** These are *live authority*. A row that grants is dangerous the moment an id is reused; there is no audit value in keeping a grant that can still be honoured. Verified `grant_revocations` is a separate table precisely so revocation history does not depend on the grant row surviving (`schema.prisma:924-926`: *"revocations outlive the grants they describe — revokeGrant deletes the row, so a column on principal_role_grants would die with the fact it records"*). The design already separates the two; #135 should use that separation rather than fight it.
- **`grant_revocations` → keep.** Deleting it destroys the only record that the person ever held anything. And note the shape: a revocation row is *inert*. It grants nothing, so a recycled id inherits nothing from it.
- **`granted_by`, `policy_versions.actor_id`, `workspaces.created_by` → keep.** Nullable `Int?` with no FK, and they record *who did something*, which stays true after that person is deleted. Nulling them would rewrite history to say nobody did it.

**One addition the recon does not name.** If cleanup deletes grants but leaves revocations, the
cleanup itself should **write a revocation row per grant removed**, not just delete. Otherwise a
grant that existed for a year vanishes with no trace that it was ever revoked — the audit trail
shows the grant being made and then simply stops. `revokeGrant` already writes those rows; the
offboard path should reuse it rather than issuing raw deletes. That also gets the version bump for
free.

## (4) `system.js:1261` `User.delete({})`: **keep it, and make the cleanup unconditional rather than per-id**

Read the context. This is the **rollback path** of `/system/enable-multi-user` (`:1261`), reached
when the settings write fails after user accounts were created. It deletes every user because
every user it is deleting was created moments earlier by the failed operation. Removing or gating
it would leave an instance in "deployment shape (b)" — user rows present, `multi_user_mode` false
— which the surrounding comment says the boot-time repair (#58) exists to correct. Guarding it
would break a rollback that already documents why it must be unconditional.

**But it is the one path where per-user cleanup does not compose**, and the recon is right to flag
it. Two options, and I rule for the second:

- Enumerate ids before the bulk delete and offboard each — correct but adds a query per user to a failure path that is already failing.
- **Truncate the authorization tables for `principal_type: "user"` in the same operation**, once, with one version bump. In this specific path every user is going away, so "remove every user-principal grant" is exactly right and is one statement.

The important half either way: **this path must bump the policy version.** It does not today
(grep for `bumpVersion` in `system.js` around that block returns nothing), so a `FilterCache`
built before the rollback keeps naming workspaces of users who no longer exist.

---

## Fixtures I would require on the eventual SHA

```
RF-1 : the recycled-id witness, both directions — delete a user holding a role, setval
       the sequence back, create a user that lands on the SAME id, ASSERT THE ID, and
       assert engine.evaluate DENIES the deleted user's permission; paired with a
       control where a genuinely-granted user is ALLOWED
why  : without asserting the id, the successor may not land on it and the test passes
       whatever the cleanup does — the recon names this trap itself. Without the
       control, an engine that denies everything passes.
```
```
RF-2 : deleting a user bumps the policy version and the access is gone through the SAME
       live FilterCache instance
mut  : delete the rows without the bump
why  : a fresh cache rebuilds anyway, so a test that constructs a new FilterCache is
       green under the mutation. It must be the same instance — the
       groupMembershipPolicyVersion.test.js pattern.
```
```
RF-3 : grant_revocations rows for the deleted user SURVIVE, and a revocation row was
       WRITTEN for each grant removed
mut  : truncate by principal_id across all three tables
why  : every "the grants are gone" assertion is green under a mutation that deletes
       revocations too. This is the paired leaves-X-alone assertion, plus the addition
       in (3) above.
```
```
RF-4 : the enable-multi-user rollback path leaves zero user-principal grants AND bumps
       the version
mut  : keep the bulk delete without cleanup (today's behaviour)
why  : no per-user fixture reaches this path; it needs its own.
```

## Security-review checklist, applied

- **Privilege escalation** — the finding itself; addressed by (3)'s delete-the-grants ruling.
- **Authorization bypass** — the stale-cache half (§2.2): a deleted user's filter stays valid until TTL. Addressed by requiring the bump, RF-2.
- **Identity confusion** — id recycling is the mechanism. Worth noting for the issue: cleanup removes the *consequence*, not the recycling. A future issue could make ids non-reusable, but that is a bigger change and cleanup is the correct fix for #135.
- **Data exposure** — `document_acl` orphans mean a recycled id inherits document access, not just role permissions. RF-1 should cover an ACL row as well as a role grant, or the ACL half is untested.
- **Audit integrity** — addressed by (3): keeping revocations and the nullable actor columns, and writing revocation rows rather than raw deletes.

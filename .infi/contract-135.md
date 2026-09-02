# #135 — orphaned authorization rows after user deletion: evidence contract

Skills: `infi-dev` (evidence contract), `security-review` checklist applied to
the shape rather than re-run over the branch (TL-1 explains why a whole-branch
run is 8.3 MB of already-merged history).

Docs only, no code. Sources: TL-1's rulings
(`docs/superpowers/evidence/techlead-135-rulings.md`, `5f051a2a8`) and Dev3's
recon (`.infi/recon/recon-135-user-delete-orphans.md`). Every file, line and
symbol cited below was re-read at `a3d0f5f6b` rather than copied forward.

**Risk tier: `auth`** — stated for PMO confirmation, not self-classified. The
finding is a measured privilege escalation: a user granted nothing is authorized
`access.diagnose` by inheriting a deleted user's id.

**Scope correction (QA-2, measured).** That escalation runs through
**`principal_role_grants`**, not through `document_acl`. An orphaned ACL row with
`effect: "allow"` grants a user actor nothing today: `documentFilter.js:96` reads
`document_acl` only `where: { ..., effect: "deny" }`, and scope comes from
`readableScope`, so an ACL-only actor gets `no_grants`. The one other reader,
`explainAccess.js:64`, is diagnostic — it reports rows rather than acting on
them.

So the earlier claim that "a recycled id inherits document access" was
**overstated**, and this contract says so rather than quietly dropping it.
Orphaned ACL rows stay in scope as **defence in depth**: they are live-looking
authority for a principal that no longer exists, and the filter's deny-only read
is a current implementation detail, not a guarantee. What changes is how RF-1
proves it — see below.

**Scope of that correction: USER principals only. Do not generalise it to
groups.** For a **group** principal, an allow-ACL row is live authority today —
`policyRepository.js:157` counts `document_acl` rows for
`principal_type: "group"` with **no effect filter**, deliberately: its own
comment records QA-1 measuring a `member` actor adding themselves to a group that
held an allow row for `document.read` and succeeding, and notes that counting one
effect "would guard freeing a victim and miss helping yourself". #134's RF-9
records that escalation as real.

The two cases differ only because that count filters on `principal_type`, which
makes a user-principal orphan invisible to it. That is a property of one query,
not a property of ACL rows — which is exactly why the user-side cleanup is worth
doing even though nothing reads those rows today.

**`group_members` cleanup is defence in depth on the same footing.** A deleted
user's membership row is not itself a grant, but it is the edge that carries
group authority to a principal id — and group ACLs, per the paragraph above, are
live. Removing the membership is what keeps a recycled id from arriving inside a
group that does hold authority.

---

## 1. Shape — three call sites, one function, no second implementation

**#135 is not "write cleanup logic". It is three call sites learning to call
`offboardUser`.** TL-1's ruling (2), and it changes what a correct SHA looks
like: a diff that adds a cleanup helper *is* the failure this scoping exists to
prevent, because two implementations of user-removal will drift and the second
one will be the one that forgets the version bump — the #96→#113 lesson.

Verified at `a3d0f5f6b`, all three still delete without any authorization
cleanup:

| # | site | current code |
|---|---|---|
| 1 | `server/endpoints/admin.js:178` | `await User.delete({ id: Number(id) });` |
| 2 | `server/endpoints/api/admin/index.js:275` | `await User.delete({ id: user.id });` |
| 3 | `server/endpoints/system.js:1261` | `await User.delete({});` (rollback, bulk) |

**Dependency, stated plainly: #135 cannot start until #136 slice 2 lands
`offboardUser({actor, userId})` in `policyRepository`.** Confirmed by grep —
`offboardUser` appears nowhere in `server/`, only in recon and CHECKPOINT prose.
Both issues write `policyRepository`; the two-people-one-file rule applies with
no line-based exception. A #135 that begins early has to invent the function it
was scoped not to write.

## 2. Removal goes through `revokeGrant`, not raw deletes

`principal_role_grants` and `document_acl` rows are **live authority** — a
granting row is dangerous the moment an id is recycled, and there is no audit
value in keeping a grant that can still be honoured.

But the removal mechanism is load-bearing, not incidental. `revokeGrant`
(`policyRepository.js:389`) runs `inTransaction`, enforces the `role.revoke`
escalation guard, writes a `grant_revocations` row, and bumps the policy version.
Raw `deleteMany` gets none of that. So:

> **Each grant removed must produce a revocation row.** Otherwise a grant that
> stood for a year vanishes with no trace it was ever revoked — the audit trail
> records the grant being made and then simply stops.

The schema already separates the two tables for exactly this reason
(`schema.prisma:924-926`: *"revocations outlive the grants they describe —
revokeGrant deletes the row, so a column on principal_role_grants would die with
the fact it records"*). #135 uses that separation rather than fighting it.

**Actor note for the implementer.** `revokeGrant` demands an explicit actor and
applies the escalation guard unless the actor is one of two seeded service
principals (`EXEMPT_PRINCIPAL_IDS = {"single-user", "core-jobs"}`,
`policyRepository.js:30-32`). An admin deleting a user must therefore hold
`role.revoke` in scope, and the rollback path (site 3) has no human actor at all
— it runs inside a `catch`. Which actor each site passes is a real design
question for #136/#135, not a detail: passing an exempt principal to skip the
guard on the admin paths would quietly remove an escalation check.

## 3. What is retained

- **`grant_revocations` → keep.** The only record the person ever held anything.
  A revocation row is **inert** — it grants nothing, so a recycled id inherits
  nothing from it.
- **`granted_by`, `policy_versions.actor_id`, `workspaces.created_by` → keep.**
  Nullable `Int?`, no FK, and they record *who did something*, which stays true
  after that person is deleted. Nulling them rewrites history to say nobody did
  it.

## 4. Site 3 is different, and the difference is not optional

`system.js:1261` is the **rollback path** of `/system/enable-multi-user`,
reached when the settings write fails after accounts were created. It deletes
every user because every user it deletes was created moments earlier by the
failed operation. Its own comment (#59) says the unconditional delete exists to
avoid leaving "deployment shape (b)" — user rows present, `multi_user_mode`
false.

TL-1's ruling: **truncate user-principal authorization rows in one operation
with one version bump**, rather than enumerating ids and offboarding each. In
this path every user is going away, so "remove every user-principal grant" is
exactly right and is one statement — and adding a per-user query loop to a
failure path that is already failing is the worse trade.

**The half that must not be dropped: this path must bump the policy version.**
It does not today. A `FilterCache` built before the rollback otherwise keeps
naming workspaces belonging to users who no longer exist.

---

## 5. RF list

### RF-1 — the recycled-id witness, both directions

```
Assert:  a user who lands on a DELETED user's id inherits neither the role grant
         nor the document ACL row.
Setup:   victim holds BOTH an org role AND a document_acl row (not one or the
         other); delete; setval the sequence back; create a successor;
         ASSERT THE SUCCESSOR'S ID EQUALS THE VICTIM'S.
Then:    - role half: engine.evaluate DENIES the role permission
         - ACL half:  the document_acl ROW IS GONE (count == 0 for that
           principal) — asserted on the row, NOT on an engine answer
Control: a genuinely-granted user IS allowed the role permission.
```

**Why the ACL half asserts a row and not a decision.** Per the scope correction
above, the engine already answers "denied" for an ACL-only actor whether or not
the cleanup ran — the filter reads `deny` rows only. An `engine.evaluate`
assertion on the ACL half would therefore be **green before the fix and green
after**: a test that cannot fail, which is the §7.17 class this contract keeps
naming. Counting the row is the only assertion that distinguishes cleaned from
uncleaned.

Three things make this test real, and each fails differently without the others:

- **Asserting the id.** Without it the successor may simply not land on the
  victim's id, and the test passes whatever the cleanup does. Dev3's recon names
  this trap itself.
- **Both a role grant and an ACL row.** Not because the ACL row grants access
  today — measured above, it does not — but because cleanup that removes one and
  silently leaves the other reads as full coverage. A victim holding only a role
  never exercises the ACL path at all.
- **The control.** An engine that denies everything satisfies every negative
  assertion for free — the §7.17 class, and the reason a positive control is not
  optional here.

The mechanism's preconditions were verified independently by TL-1:
`principal_id` is `String` with no relation to `users` in all three tables
(`schema.prisma:804`, `:911`, `:962`), the engine matches on
`String(grantPrincipal.id)`, and the `setval` line is real shipped code at
`scripts/sqlite-to-pg-import.js:102`.

### RF-2 — the bump reaches a LIVE cache

```
Assert:  after deleting a user, the access is gone through the SAME FilterCache
         instance that served it before.
Mutant:  delete the rows without the version bump → must go red.
```

Constructing a fresh `FilterCache` rebuilds from the database anyway, so a test
that news up a second cache is **green under the mutation** and proves nothing.
The pattern to follow is
`server/__tests__/security/identity/groupMembershipPolicyVersion.test.js:117-146`
— populate through the instance, mutate, build again through the *same* one.
(TL-1 cites this file; note it lives under `security/identity/`, not
`security/authorization/`.)

### RF-3 — revocations survive, and one was written per grant removed

```
Assert:  grant_revocations rows for the deleted user still exist AND a row was
         written for each grant removed.
Mutant:  truncate by principal_id across all three tables → must go red.
```

Every "the grants are gone" assertion stays green under a mutation that deletes
the revocations too. This is the paired leaves-X-alone assertion, and the
per-grant half is what distinguishes `revokeGrant` from a `deleteMany` that
happens to leave the revocation table untouched.

### RF-4 — the rollback path

```
Assert:  after the enable-multi-user rollback, zero user-principal rows remain
         in principal_role_grants and document_acl, AND the policy version was
         bumped exactly once.
Mutant:  keep the bulk delete without cleanup (today's behaviour) → must go red.
```

No per-user fixture reaches this path — it runs inside a `catch` on a failing
settings write — so it needs its own. Asserting the bump happened **once**, not
merely happened, is what keeps the ruling's "one operation, one bump" from
degrading into a loop that satisfies the same assertion.

---

## 6. Contract command

```
cmd:    cd server && npx jest __tests__/security/authorization --runInBand
expect: exit 0, and the four RF tests above present and passing
```

`exit 0`, not a pass count: a suite can print every test as passed and still
exit non-zero on an unhandled rejection — recorded twice in §7.17 already.

## 7. Lane

`policyRepository.js` is shared with **#136**, which must land first. #135 then
touches `endpoints/admin.js`, `endpoints/api/admin/index.js`,
`endpoints/system.js` and its own test file. It must not add a cleanup function
of its own — see §1.

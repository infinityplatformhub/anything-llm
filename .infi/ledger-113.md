# Ledger — #113 (S4a): LarkIdentityProvider driver

Dev 3. Branch `approof/113-s4a`. Tier auth. Recon `docs/superpowers/recon/s4-lark-org-sync.md` §7.

Record shape and re-pointing are frozen pending the user's answer to Q4 (LDAP/Lark
conflict scope). Everything here is deliberately the part that does not depend on it.

## Slice 1 — the unique index (RF-3)

Ruling: a PLAIN unique on `(orgId, source, externalId)`. My own contract had said
local groups (all NULL `externalId`) would collide under one, and that a partial or
`NULLS NOT DISTINCT` form was needed. Measured on PostgreSQL 17.11 instead of reasoned
about: Postgres treats NULLs as distinct, so they do not collide. Corrected on the
issue before anyone built on it. If wrong: the migration would carry a complication
that does nothing, and the "fix" for it corrupts real deployments.

Ruling (TL-1 RF-3): the local rows are seeded BEFORE this migration runs, not after.
Seeding after `migrate deploy` tests the constraint's behaviour but never the
migration's — and the migration is the half that executes against a populated
production database. `migrate deploy` has no "up to" flag, so the boundary is drawn by
parking the migration directory and restoring it in a `finally`.

The payoff is measurable: with the rows seeded afterwards, the `NULLS NOT DISTINCT`
mutant killed ONE test. Seeded before, it kills the entire suite in `beforeAll`:

```
ERROR: could not create unique index "groups_orgId_source_externalId_key"
DETAIL: Key ("orgId", source, "externalId")=(1, local, null) is duplicated.
```

Ruling (TL-1): the neighbouring index is the wrong model, and the migration says so in
a comment. `principal_role_grants` (`20260902020000:158`) DOES use `NULLS NOT DISTINCT`
deliberately — there a NULL `workspace_id` MEANS "org-wide", so two such rows are the
same grant and a plain unique let them duplicate on re-runs. Here a NULL `externalId`
means "no external identity", and two groups without one are two different groups.
Same syntax, inverted meaning. If wrong: the closest example in the tree is exactly the
thing not to copy, and nothing would have said so.

### Evidence, slice 1

- RED without the migration: only the duplicate-department test fails. The three "must
  still be allowed" cases pass, which is what makes the RED meaningful rather than a
  suite that is simply broken.
- 5/5 green with it.
- Three mutants, each killed by its named test:
  - `NULLS NOT DISTINCT` → the whole suite, at `migrate deploy`
  - drop `source` from the key → the cross-source test
  - drop `orgId` from the key → the cross-org test
- Two of those tests are not on the RF list. They exist because both columns are
  load-bearing and nothing else proved it: an LDAP group and a Lark department may
  legitimately carry the same opaque id, and one tenant's department id must not
  collide with another's.

Ruling (TL-1 F1/F2): the "migrate up to here" boundary is drawn by COPYING
`prisma/migrations` to a temp directory and deleting this migration from the copy —
never by renaming the real directory aside.

My first version renamed and restored in a `finally`, and I recorded the SIGKILL
window as a residual. TL-1 was right that recording it was not enough: a `finally`
does not run for SIGKILL, OOM, or a killed test process, and the wreckage is a
repository missing a migration plus an orphaned `.migration-parked-*` — which reads
as a missing file rather than an interrupted test, and makes the next
`migrate deploy` record a shorter history against a dev database. It also raced any
other suite touching that folder whenever jest runs without `--runInBand`.

Copying closes both, and closes them by construction rather than by cleanup: the
working tree is read-only for the whole test, so there is nothing to restore and
nothing to race. Verified after a run where the mutant killed `beforeAll` mid-flight
— no temp directories left, no orphaned `s4a_idx_*` database, `git status` clean.

Ruling (TL-1): the migration comment cites the version CI actually runs. It said
"measured on PostgreSQL 17.11" — true, but CI is `postgres:16`, so the evidence and
the deployment target did not match. Re-measured on PG16.14 in the running
`t1-authz-postgres-1` container before changing the claim:

```
plain unique created over 2 NULL rows on PG16
NOTICE: PG16: duplicate lark dept REFUSED — index works
ERROR:  could not create unique index "pg16_nnd"
DETAIL: Key ("orgId", source, "externalId")=(1, local, null) is duplicated.
```

Identical on both. NULLs being distinct in a unique index is standard behaviour;
`NULLS NOT DISTINCT` is the PG15+ addition, and the comment now says that instead of
naming one patch version.

## Slice 2 — the driver (RF-1, RF-2, RF-4, F2, F3)

Ruling: a failed enumeration THROWS; it never returns a short list. Every `catch` in
the driver either retries or rethrows, and none of them return. If wrong: the
reconciler cannot distinguish a truncated directory from an organisation where those
people left, so a single 500 on page 37 of 100 deactivates 3,200 people.

Ruling: `emailVerified` is reported as `false`, not `true`. Neither `email` nor
`enterprise_email` carries verified semantics in Lark, so claiming `true` would
launder a directory record into a proven address. The trust decision (recon §7.3 —
we trust the tenant administrator) belongs to core's sync path; the driver states
facts. If wrong: the exemption stops being visible at the point where it is granted.

Ruling: `memberExternalIds` on a department is EMPTY. Lark carries membership on the
user record (`department_ids`), not the department. Cross-referencing to fill it in
would make the driver a reconciler. If wrong: membership gets decided in the layer
with the least review.

### Evidence, slice 2

15/15. Six mutants; five killed by their named tests, one defective:

- L1 catch the page failure and return what was collected → **five tests**: every
  RF-1 refusal plus the never-clearing 429. This is the defect the slice exists for.
- L3 advance the cursor past a page → the full-enumeration test, the page-37 refusal,
  the dropped-socket test, and the 429 retry. The named-id assertion is what catches
  it: 5,000 rows is still 5,000 rows if you skip page 37 and read page 38 twice.
- L4 take `subject` from `open_id` → the subject test AND the source grep.
- L5 reverse the address precedence → the RF-4 selection test.
- L6 claim `deltaSync: true` → the capability test.
- **L2 SURVIVED, and was a bad mutant rather than a gap.** It set `cursor` inside the
  retry loop, after the URL had already been built from it, so it changed nothing
  that runs. Recorded rather than quietly dropped: a survivor is only meaningful once
  you know whether it was reachable, and this one was not.

### A false pass I found in my own test

The app-secret test originally pointed a driver at `${baseUrl}/nonexistent` expecting
the request to fail. The fixture matches paths with `includes`, so it answered anyway
— the enumeration SUCCEEDED and the "no secret in the error" assertion passed with no
error to inspect. Repointed at a dead port (`127.0.0.1:1`) so the failure is real, and
the assertion now renders `cause` too, since that is where a fetch failure carries the
request it was making.

## Slice 3 — membership writes bump the policy version (RF-5)

The residual #96 left behind. Since #96 the engine expands group membership and
documentFilter reads it on both halves, so membership decides authorization — but
nothing about writing `group_members` advanced `policy_versions`. A user removed from
a group kept its access until the cache TTL expired.

Ruling: membership writes live in `policyRepository` (`addGroupMember` /
`removeGroupMember`), not in a caller, for the same reason grants do — a caller that
forgets the bump produces silent staleness, and nothing about
`prisma.group_members.create()` looks wrong. Both bump inside the same transaction as
the write. If wrong: a crash between the two leaves every cache stale with no event
to correct it, which is the reasoning `bumpVersion` already gives for publishing
inside the transaction.

Ruling: `removeGroupMember` uses `deleteMany`, so removing a non-member is a no-op
rather than an error — and it still bumps. A caller that asked for a removal is
entitled to know the cache reflects reality afterwards, whether or not a row existed.

### The gap the scope test found

The first version of `workspaceScopeKeysFor` read `workspace_users` only. That is
wrong for exactly the case S4a creates: a user whose ONLY path to a workspace is a
group grant has no `workspace_users` row, so the bump published `org:1` and nothing
else.

Five of the six tests passed anyway, because `FilterCache.get` re-reads the version
head on every call and would have caught it regardless. The scope test is what
failed — it asserts the emitted `scopeKeys` rather than trusting that invalidation
happened for some reason. TL-1 asked for that specific shape; without it the defect
ships, and only shows up in a consumer that listens narrowly.

Fixed by also collecting the workspaces named by the GROUP's own grants. Org-wide
grants (`workspace_id` NULL) need no key: `org:1` is already published and every
cache entry carries it.

### Evidence, slice 3

6/6. Three mutants, each killed by its named test:

- P1 publish under `group:<id>` — a key `scopesFor` never produces → the scope test
  alone. The revocation test still PASSED, because the version-head check saves it.
  That is precisely why the scope is pinned separately: without this test, a bump
  nobody can match looks healthy.
- P2 drop the group-grant workspaces (the regression above) → the scope test.
- P3 remove the bump entirely → **four** tests, including the live-cache revocation,
  which is the actual security property.

Two corrections to my own test along the way: it asserted `attributes.groupIds` on a
filter that had degraded to match-none (where `attributes` is `{}` by construction),
and it read `event_outbox.payload` ordered by `id` — the column is `data`, a JSON
string, and `id` is a String, so ordering by it sorts lexically rather than
chronologically. `occurredAt` is the indexed column for that.

## Slice 4 — TL-1's slice-2 findings (RF-6, RF-7, NIT-1, NIT-2)

Ruling (FINDING-2 / RF-7): a non-null `cursor` is REFUSED with
`IdentityCapabilityError`, exactly as `delta` is. Confirmed before fixing, on a
250-user fixture at 5 per page:

```
listPrincipals({ cursor: "4" }) → 235 principals, hasMore: false, nextCursor: null
```

A prefix wearing the label of a complete snapshot. Every field says the enumeration
finished cleanly, and a reconciler acting on it deactivates the 15 people it skipped.
Silently ignoring the argument would be worse than refusing — the caller believes it
resumed AND received everything. This driver's only honest output is a completed full
snapshot, because that is the only thing absence may be judged against.

Ruling (NIT-2): a record with no `user_id` is REFUSED, not skipped. Skipping is the
quieter option and the wrong one: `identity_links` is unique on `(provider, subject)`,
so two records normalizing to `""` collide on the field that IS the identity — and a
skipped principal is ABSENT from the snapshot, which is how the reconciler decides
someone has left. A directory returning unkeyable records is a broken enumeration, not
a smaller organisation.

### Evidence, slice 4

18/18. Three mutants, each killed by its named test:

- M7 remove the cursor refusal → RF-7
- M8 loop on `page_token` instead of `has_more` → RF-6. That guard had **no test at
  all** before this slice: the default fixture omits the trailing token, so the
  `alwaysToken` switch is what made it reachable.
- M9 remove the empty-subject refusal → NIT-2

NIT-1: the staging directory is now removed in a `finally`. It lives under
`os.tmpdir()` rather than the repository, so leaking one is untidy rather than
dangerous — but a failed `migrate deploy` would otherwise leave one behind on every
run.

## Slice 5 — TL-1 FINDING-3: membership writes were an ungated grant path (RF-8, NIT-3)

TL-1 rejected `ebab66da9` on one blocker, and it is the real one. Since #96 the engine
expands `group_members` when it evaluates grants — which is what slice 3 was built on
— so `addGroupMember` hands a user everything the group's roles carry. It checked only
`requireActor`. `grantRole` refuses to hand over a permission the actor does not hold;
routing the same escalation through membership met no check at all, so an actor holding
nothing but `member` could add anyone (themselves included) to a group holding
`super_admin`.

This is my own defect, and slice 3 is where it entered: I moved membership writes into
`policyRepository` *because* they decide authorization, then gave them the version bump
and not the guard that every other write in this file carries.

Ruling: the guard is the SAME SHAPE as `grantRole:160-173` — `permissionIdsForGroup`
minus what the actor holds minus the baseline; non-empty means refuse. Not a
differently-worded second rule: two checks guarding one capability drift, and the
weaker one becomes the way in. If wrong: the divergence is invisible until someone
exploits the gap between them.

Ruling: `permissionIdsForGroup` does NOT filter by workspace, and `heldPermissionIds`
is read org-wide. Membership is not written into a scope — one `group_members` row
activates every grant the group holds in every workspace at once, so the union is what
is being delegated and the union is what must be contained. If wrong: a workspace-A
admin activates a grant that reaches workspace B.

Ruling: REMOVAL is guarded too. Removal looks like the harmless direction and is not —
evaluation is deny-wins, so pulling someone out of a group that DENIES them widens what
they may do. Guarding only `add` leaves the same hole with the sign flipped.

Ruling: a group holding no grants is addable by anyone who may write membership at all.
The guard is about what the GROUP carries, not about membership being privileged in
itself; refusing here would measure the wrong thing and block ordinary directory sync
from an ordinary admin.

**KNOWN LIMIT, recorded rather than hidden (#128, queued).** This guard calls
`heldPermissionIds`, which reads the actor's OWN grants and does not expand their group
memberships — though the engine has since #96. A delegated admin who holds their role
only through a group is therefore refused here. That is fail-closed (it denies a
legitimate write, it does not allow an escalation) and #128 fixes it in
`heldPermissionIds` itself, so `grantRole` and this get one answer instead of two.

**#128 must not merge before this SHA** (TL-1 pre-read `techlead-128-preread.md` @
`93c4103fb`). Expanding groups in `heldPermissionIds` while `addGroupMember` has no
check completes a chain: add yourself to a group → inherit its permissions → satisfy
the escalation guard → grant yourself directly. Each half is safe only with the other.

### Why the existing six tests could not have caught this

All six RF-5 tests pass `SYS` (`SERVICE_PRINCIPALS.singleUser`), which is EXEMPT — so
every one of them is green whether or not the guard exists. A suite that cannot fail
for the defect it covers is the §7.9 shape, and it was mine. The RF-8 tests use real
user actors for exactly this reason.

### Evidence, slice 5

RED first: only the two escalation tests failed; the four controls and the original six
passed, so the tests measure the defect rather than a broken suite. 12/12 green after.

Five mutants, each killed by its named test:

- G1 drop the guard from `removeGroupMember` → the removal test alone
- G2 drop it from `addGroupMember` → the addition test alone
- G3 drop the `isExemptPrincipal` bypass → the coreJobs test (S4b holds no grants at
  all; a guard that applied to it would refuse every directory-sync write)
- G4 `groupPerms.size >= 0` — the guard returns before it checks anything → BOTH
  escalation tests
- N3 hardcode `orgId = 1` → the NIT-3 test

**N3 SURVIVED the first run**, and that was a gap rather than a bad mutant: every
fixture in the file builds in org 1, so a hardcoded 1 is invisible to all of them.
Written as a test (a group in org 2) and re-run until it died, rather than argued away.

### NIT-3 was two places, not one

TL-1 called `workspaceScopeKeysFor:415` a one-line fix. It is two: the hardcoded `1`
filters which group grants count AND the callers publish under `SCOPE_KEY(1)`. Fixing
only the filter would read the group's org while still publishing `org:1` — a key no
cache entry in that org carries, which is precisely the defect the RF-5 scope test
exists to catch. So the helper now returns `{ orgId, extra }` and both callers publish
under the org they read.

## Slice 6 — RF-9 (#129): a group can carry authority with no role grant at all

Closes #129, which PMO opened when TL-1 downgraded this to a residual. It lands here
rather than separately because it is a three-line change to a guard this SHA
introduces, and splitting it would ship the wrong answer first and correct it after.


TL-1's pre-check on `98b2627a1` found that slice 5's early return was wrong for
denials, and it is. `document_acl` deny rows are keyed
`{principal_type:"group", principal_id}` and `documentFilter:91-99` reads them
directly — they never pass through `principal_role_grants`. So a group whose entire
purpose is "these people may not see these documents" holds ZERO role grants,
`permissionIdsForGroup` returns an empty set, and my early return let any actor call
`removeGroupMember` and hand the victim every document the group hid.

The mistake underneath it: I treated "the group's permission set is empty" as "the
group carries nothing". Containment on an empty set is not a safe default — the empty
set is contained by everyone, so "carries nothing" and "carries only denials" reached
the same answer while meaning opposite things.

Ruling: `denyCount` from `document_acl` is counted alongside the role permissions, and
the early return fires only when BOTH are zero.

Ruling: the deny branch needs its OWN bar, and `document.share` is it. Set containment
cannot supply one here — the permission set is empty, so the containment check passes
for an actor holding nothing, and adding `denyCount` without a bar would leave the
guard exactly as permissive as before. `document.share` governs who may change a
document's reach, which is precisely what moving someone in or out of a deny group
does. Org-wide `super_admin` was the stricter option and the wrong one: it would be
stricter than writing the ACL row itself and would lock out the admin whose job this
is. If wrong: the bar is either ornamental or it blocks ordinary document sharing.

Ruling: a missing `document.share` permission row FAILS CLOSED. An unseeded permission
must not read as "nothing to check" — that is the same shape as the hole this branch
exists to close.

### Both measurements are true, and they answer different questions

TL-1 then measured that this is not reachable today: `grantDocumentAcl` has no caller
outside tests, and the seeded `document_acl` rows are all `principal_type:'workspace'`.
I verified that independently and it is correct — there is no exploit path right now,
which is why TL-1 downgraded it to a residual and passed `98b2627a1`.

What is fixed here is different: the guard returned the WRONG ANSWER for an input the
schema already accepts. `document_acl.principal_type` takes `'group'` today, and the
first deny row S4b or S4c writes opens the hole with nothing to announce it — in the
very slice that made group membership an authorization path. Recorded both ways rather
than only the half that favours the fix.

### Evidence, slice 6

RED first, and cleanly: only the two escalation tests failed. Three controls passed —
the SAME `member` actor against a group with no deny rows (which is what separates "the
deny row refuses" from "this guard refuses everyone", and would otherwise break
directory sync), a `document.share` holder, and `coreJobs`. 17/17 green after.

Two mutants, each killed by its named tests:

- D1 restore the unconditional early return → both deny tests
- D2 never enforce `document.share` → both deny tests

The tests match `/document\.share/` rather than `/does not hold/`: the role-grant branch
refuses with its own wording, and a loose pattern would be green for a refusal that came
from the wrong half of the guard.

### A fixture error I nearly read as RED

The first run failed FOUR tests, not two — including the two controls that should have
passed. The cause was mine and not the code: the fixture created `documents` with
`docId`/`docpath`/`workspaceId`, and the real model has none of them (`dedupe_key` is
the column). `PrismaClientValidationError` in a test that expects a throw is
indistinguishable from a pass if the assertion is loose enough, and counting those four
as RED would have "proved" a guard that had not run at all.

## Residual risks

0. **#128 is a dependency in both directions**, recorded on both issues: this guard is
   incomplete without #128 (group-held admins are refused), and #128 is unsafe without
   this guard (the escalation chain above). Neither is a reason to weaken either.

1. **Q4 is unanswered**, so the driver's record shape is not frozen. Recon §7.4 covers
   both answers; (b) "Lark re-points every conflicting link" carries a shape
   structurally identical to the account takeover R1 exists to prevent, and TL-1 notes
   that no delta API makes it worse — every full sync becomes another opportunity to
   re-point.

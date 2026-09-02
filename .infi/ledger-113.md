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

## Residual risks

1. **Q4 is unanswered**, so the driver's record shape is not frozen. Recon §7.4 covers
   both answers; (b) "Lark re-points every conflicting link" carries a shape
   structurally identical to the account takeover R1 exists to prevent, and TL-1 notes
   that no delta API makes it worse — every full sync becomes another opportunity to
   re-point.

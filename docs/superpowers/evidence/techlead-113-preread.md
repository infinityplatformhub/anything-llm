# Techlead-1 — #113 S4a pre-read (Lark directory sync, auth tier)

Contract: `#113` comment `#issuecomment-5508665474`. Read against `approof/main` +
`#96 dadac7b3c`: `utils/identityProviders/LdapIdentityProvider/index.js:60-79,355-380`,
`utils/identityProviders/index.js:61`, `utils/authorization/policyRepository.js:14,42-64`,
`utils/authorization/cache.js:27-41`, `cacheSubscriber.js:44-56`, `prisma/schema.prisma`
(`groups`, `group_members`), migration `20260902020000:156-158`. Index behaviour measured
against the live PostgreSQL 16.14.

The contract is stronger than the recon it replaces. Three items are correct in ways worth
naming before the SHA, and one — the policy-version bump — has a shape problem that will make
the fixture pass while the cache stays stale.

---

## REQUIRED RED FIXTURES

**RF-1 — enumeration loses a page in the middle; the result is a failure, not 1,850 people**
```
fixture   : fake server serves pages 1..36 (50 each), page 37 returns 500 (or a body
            with no page_token and hasMore true), pages 38..100 would have served.
            Assert the call REJECTS. Assert no partial list is returned and — the part
            that matters — assert nothing downstream was written: no users created,
            no group_members rows, no policy_versions row.
mutation  : catch the page error and return the pages gathered so far
green why : a fixture that fails on page 1 or on the LAST page is green against a
            partial-return bug — page 1 returns an empty list which reads as "no
            users", and the last page's absence is indistinguishable from the end of
            the directory. The failure must be MID-enumeration with pages on both
            sides, and the assertion must be on what was written, not on the return
            value: a caller that logs and continues leaves the same short list behind.
```
This is the one I care most about. "A failed enumeration must not return a partial list" is
correct but under-specified: the danger is not the list, it is what S4b does with it. Assert
the absence of writes.

**RF-2 — a 429 mid-enumeration loses no page**
```
fixture   : page 37 returns 429 with Retry-After, then succeeds on retry; assert the
            final principal count equals the full directory AND that page 37's
            principals are present by id, not merely that the count matches
mutation  : treat 429 as a terminal error, or skip the page and continue
green why : a count-only assertion passes if the retry double-counts page 36 instead
            of fetching 37 — the same total, the wrong people. Identify the page by
            content.
```

**RF-3 — the index must be created on a database that ALREADY has two local groups**
```
fixture   : seed the test database with two `source:'local'` groups, externalId NULL,
            in one org, THEN run the migration. Assert the migration succeeds. Then
            assert two `source:'lark'` groups with the same externalId are rejected.
mutation  : write the index as UNIQUE ... NULLS NOT DISTINCT
green why : a migration test on an EMPTY database creates the index fine under either
            form — the wrong form fails only when rows already violate it, which is
            every real installation and no fresh test database. The failure is at
            CREATE INDEX, not at insert, so a fixture that migrates first and inserts
            afterwards never reaches it.
```
Dev3's correction is right and I had it wrong. Measured on PostgreSQL 16.14 in this
project's container, seeding two NULL rows and then creating the index:

```
NULLS NOT DISTINCT : ERROR: could not create unique index "tl1_bad"
                     DETAIL: Key (org, source, ext)=(1, local, null) is duplicated.
plain UNIQUE       : CREATE INDEX, then a duplicate ('lark','g1') is rejected
```

So plain `UNIQUE(orgId, source, externalId)` is correct on its own — SQL NULLs are distinct,
local groups coexist, Lark duplicates are refused. No partial index is needed, and I withdraw
the `WHERE ext IS NOT NULL` I proposed: it produces the same behaviour with more moving parts.

The real trap is the one Dev3 named, and it is a **migration-time** failure, not a runtime
one: `NULLS NOT DISTINCT` passes on an empty test database and fails at `CREATE INDEX` on any
installation that already has two local groups. My earlier table tested inserts against an
already-created index and therefore could not see it — the order of operations was the whole
question and I had it backwards.

Worth flagging in the migration comment: this tree's existing precedent
(`principal_role_grants`, migration `20260902020000:156-158`) uses **NULLS NOT DISTINCT**
deliberately, because org-wide grants with `workspace_id NULL` must not duplicate. That is the
opposite requirement, and someone copying it into `groups` gets a migration that passes CI and
fails on a customer's database.

**RF-4 — a user with both addresses selects `enterprise_email`**
```
fixture   : one principal with BOTH enterprise_email and email, DIFFERENT values;
            assert the linked identity carries the enterprise address
mutation  : reverse the precedence, or use `email ?? enterprise_email`
green why : a fixture where the two are equal, or where only one is set, is green
            under either precedence. The values must differ and both must be present.
```
Plus the third state as its own case: neither present → **quarantined and no `users` row
created**. Assert the absence of the row, not the presence of a quarantine record — a driver
that quarantines *and* creates is the failure, and only the users-table assertion sees it.

**RF-5 — `group_members` writes bump the policy version, and the CACHE actually clears**

This is the one with a shape problem. See FINDING-1; the fixture as PMO stated it
("policy version ไม่ bump → cache เก่า 30s แดง") will pass while the cache stays stale.

```
fixture   : build a documentFilter for user U (populating FilterCache), remove U from
            a group whose grant gave U access, then build the filter again through the
            SAME cache instance and assert the new filter no longer carries the access
mutation  : bump the version but publish no event / publish with the wrong scopeKey
green why : asserting "a policy_versions row was written" is green against a bump that
            emits an event nothing matches — and `FilterCache` invalidates on
            `scopeKeys` from the event payload, not on the version number. The
            assertion has to be on the CACHE's answer, through the subscriber.
```

---

## FINDING-1 — "bump the policy version" is two mechanisms, and only one of them is a version

`policyRepository.bumpVersion` (`:42-64`) does two things in one transaction: inserts a
`policy_versions` row **and** publishes `policy.changed` carrying `scopeKeys`. The cache uses
them differently:

- `FilterCache.get` re-reads `currentPolicyVersion` on every call and discards an entry
  stamped older — so a bump alone does make a stale entry rebuild.
- `cacheSubscriber` invalidates on `event.data.scopeKeys` (`:47-55`), matched against
  `scopesFor({actor})` = `org:<id>` plus `workspace:<id>` (`cache.js:37-41`).

So a membership write that inserts a `policy_versions` row **without** publishing, or
publishes with a scope key nobody matches, still gets picked up by the version check — but
only because that check exists. The subscriber path is the one that would silently do
nothing, and it is the path a `group:<id>` scope key would land in: **no cache entry is keyed
on a group**, so a scope key of `group:7` matches nothing and invalidates nothing.

**What S4a should do:** membership writes bump with `SCOPE_KEY(1)` — `org:1` — exactly as
`grantRole` does (`:174`), optionally with the affected users' workspaces as
`extraScopeKeys`. Not a `group:` scope key, which would look precise and invalidate nothing.

And the write must go through a repository function that opens the same transaction, not
`prisma.group_members.create` at the call site. #96's residual assigned this bump to "the
first issue that writes membership", which is S4a — so S4a is also the issue that decides
whether membership writes live in `policyRepository` or beside it. My read: they belong in
`policyRepository`, because everything else that bumps is there and the outbox publish must be
inside the same `tx`.

## FINDING-2 — `capabilities()` is read by core, so `deltaSync:false` must be honoured, not just declared

`identityProviders/index.js:61` returns `capabilities()` to callers, and the LDAP driver's own
comment says the flags stay false **until the code honours them**, because core acts on them.
`listPrincipals`/`listGroups` throw `IdentityCapabilityError` there.

For Lark the same discipline inverts: `directorySync: true` and `groupSync: true` mean those
two methods must **work**, and `deltaSync: false` means every delta-shaped entry point must
throw. The contract says a delta-shaped path throws — good. Add the mirror to the fixture
list: **assert `listPrincipals()` does not throw** for this driver. A driver that declared
`directorySync: true` and left the method throwing would satisfy the delta assertion and be
useless, and no test in the stated contract catches it.

## FINDING-3 — the `open_id` grep guard is right, and it should scan the compiled surface, not the file

The contract asks for a test that greps the driver for `open_id`. Two notes from #40's
experience with exactly this shape:

- Strip comments first. The driver will almost certainly carry a comment explaining *why*
  `open_id` is forbidden, and the grep will match it. #40 task 3 hit this precise false
  positive (`localStorage` named in the comment saying it is not used) and the ledger records
  the fix.
- Grep the **request** the driver builds, not only the source: the field arrives from Lark's
  response and the risk is reading `user.open_id` into `subject`. A source grep catches the
  obvious spelling; an assertion that a `DirectoryPrincipal` built from a fixture response
  carries `subject === fixture.user_id` catches the case where the field is reached
  dynamically. Both, or the second alone.

## On Q4 — my position, unchanged, with one addition

I said in my earlier note that re-pointing `identity_links` is the takeover shape R1 exists to
prevent, and that the never-linked case is arguable while the already-federated case is not.
The contract's §7.4 split (a) / (b) matches that.

The addition, now that "no delta API" is established: option (b) becomes **more** dangerous,
not less. A re-point driven by a full enumeration means every sync is an opportunity to
re-point, and the contract's own warning — "a failed enumeration must not return a partial
list … that is the shape S4b would read as 'these people have left'" — applies with more force
to identity re-pointing than to membership. If the user picks (b), then
"never-from-a-partial-enumeration" is not one of three optional extras; it is the precondition,
and it needs RF-1's absence-of-writes assertion extended to identity re-points specifically.

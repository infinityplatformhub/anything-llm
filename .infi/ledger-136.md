# Ledger — #136 (S12 slice 1: offboarding is a terminal state)

auth tier. Files: `server/models/user.js`, `server/endpoints/admin.js`,
`server/utils/http/index.js`, `server/__tests__/security/authorization/offboardUser.test.js`,
`server/__tests__/security/authorization/routeGateSweep.test.js`.

**`policyRepository.js` is NOT touched.** #134 (Dev3) owns it.

## Rulings

Ruling: `revokedAt` is set in the SAME transaction as `suspended`. A crash between two separate
writes leaves an account that is suspended in the UI and still usable by its API key — the worst of
the two states, and the one nobody would think to check. `User.update` already had the precedent: a
role change moves the legacy grant with it. — ถ้าผิด: บัญชีที่ "ถูกระงับแล้ว" แต่ key ยังใช้ได้ โดย
ไม่มีใครรู้

Ruling: revocation filters on `revokedAt: null`. An already-revoked key keeps its ORIGINAL
timestamp, because when a key stopped working is audit history — re-stamping it rewrites the record.

Ruling: browser-extension keys get no equivalent write. `validBrowserExtensionApiKey.js:27` re-reads
`suspended` on every request, and that key table has a real foreign key to `users`, so both the
suspend and the delete cases are already closed. Measured, not assumed.

Ruling: the endpoint is gated by `user.manage`, not a new `group.*` action. No `group.*` permission
is seeded — measured, the table holds `user.manage`, `user.read`, `user.write` — and inventing one
here would add a permission row with a single call site. Recorded as a residual instead.

Ruling REVERSED by TL-2 — the policy-version bump is NOT in this slice. I proposed exporting
`bumpVersion` (option ก) as the smallest change. TL-2 rejected it with a reason I had not measured:
an outside caller passing a bare `SCOPE_KEY(1)` bumps successfully, but `cache.invalidateScopes`
drops only exact-scope entries, so a suspended user's WORKSPACE-scoped cache entries survive. The
bump belongs to an `offboardUser` inside `policyRepository`, which is #134's lane until it merges.
The two tests for it were written and CONFIRMED RED on `941aa79e8` (version 13 before, 13 after),
then removed and replaced by a comment block naming what is missing and why. They return with the
`offboardUser` slice, with TL-2's required fixture: the assertion is that the user's
workspace-scoped entries are actually invalidated, observed through `cache.invalidateScopes`
behaviour, never through "bumpVersion was called". — ถ้าผิด: slice นี้จะอ้างว่าเพิกถอนสิทธิ์ครบ
ทั้งที่ cache ระดับ workspace ยังค้าง

Ruling REVERSED by TL-2 — `change_type: "suspension"` is dropped. `change_type` answers WHAT
changed (`grant`, `document_acl`, `group_membership`, `visibility`); WHY it changed belongs to the
audit event. My test asserted the new value; the assertion is gone with it.

Ruling: the JWT residual goes in `makeJWT`'s JSDoc rather than a ledger line alone. The next person
to read that function is the one who might trust a token without re-reading the user row, and a
30-day unrevocable window is not visible from the signature.

## QA-2 round 2: the sweep is not a guard

QA-2 rejected the claim that `49f7a0cd9` closes API-key access for a suspended user. Reproduced all
three paths, each returning `next(): true` with no status:

    User._update(id, {suspended: 1})       models/user.js:285 — writes the column, never
                                           runs the sweep in `update`
    ApiKey.create for a suspended user     the sweep already ran; nothing stops a later mint
    re-suspend an already-suspended user   `isSuspending` is false, so no sweep, and the
                                           operator is told `success: true`

Cause, confirmed by reading the resolver against the measurement: `actorResolver.js:90-121`, the
api-key branch, resolves `creatorId` and `grantPrincipal` and **never reads `users.suspended`** —
unlike the `locals.user` branch (`:128`) and the actorRef branch (`:203`), which both check it.

What I built is therefore a SWEEP, not a guard: it revokes the keys that exist at the moment it
runs, and is only as good as its coverage. The finding is correct and the fix shape is TL-2's to
rule (reader-side check, create-guard, or both).

Ruling: fixture (1) is asserted at the MODEL CALL, not at `POST /admin/generate-api-key`. PMO
specified the route with a suspended TARGET; measured, that is unreachable — `admin.js:793` mints
for `user.id`, the SESSION user, and `validatedRequest` already refuses a suspended session, so no
HTTP caller can name a suspended target. Asserting a path that does not exist produces a test that
passes for the wrong reason, which is the failure class §7.17 already records twice. The model call
is what that route wraps and what any future admin-mints-for-user route would use. — ถ้าผิด: เทสที่
เขียวเพราะเส้นทางไม่มีอยู่จริง ไม่ใช่เพราะโค้ดถูก

Ruling: the QA-2 fixtures are SHAPE-AGNOSTIC. QA2-1 passes if `ApiKey.create` refuses outright
(create-guard) OR if the key fails to authenticate (reader-side). A fixture that dictated one would
have to be rewritten when the ruling lands, and a fixture rewritten to match an implementation has
stopped being evidence.

## TL-2's ruling, implemented

Ruling (TL-2): the suspension check goes in `keyGrantPrincipal`, making the api-key branch
SYMMETRIC with the two that already check — `locals.user` at `:127` and `resolveActorRef` at
`:201-203`. Enforcement moves to the READER, where every ingress passes, instead of living at one
writer. — ถ้าผิด: guard ที่มีทางอ้อมที่จดไว้ในเอกสารเอง

Ruling (TL-2): the lookup fails CLOSED — an unreadable users table denies, the same evidence rule
the null-creator branch below it already follows. Answering "not suspended" on an error hands the
key its creator's full reach at exactly the wrong moment.

Ruling (TL-2): the sweep becomes LEVEL-triggered (`updates.suspended === 1`, dropping
`currentUser.suspended !== 1`). The `revokedAt: null` filter already makes it idempotent, so
running it on every suspend costs a no-op update.

Ruling (TL-2): the sweep is KEPT even though the resolver now refuses a suspended creator, because
`revokedAt` is the audit record of when a key stopped working and a resolver check leaves no such
record. Two mechanisms, two different jobs.

Ruling (TL-2): NO condition is added inside `ApiKey.create`. Two rules stating one thing drift.
Minting for a suspended owner already fails at the existing ceiling check, because the creator can
no longer be resolved — the free consequence TL-2 predicted, confirmed here when QA2-3 started
failing on a null `apiKey` rather than on authentication.

Ruling: the JSDoc claim is corrected. It said the key "was the way back in", implying the sweep
closed it; the sweep is not what enforces this. It now says enforcement is at the reader and that
the sweep provides the audit record.

## QA-2's three gaps

**M4b** — the happy-path endpoint test asserted only that the membership row disappeared, which
passes on a handler calling `prisma.group_members.deleteMany` directly and leaving every cached
decision serving the removed member. It now also asserts the `policy_versions` row and the
`policy.changed` outbox row, counted BY TYPE across the call: outbox ids are uuids rather than
ordered, and `auth.key_used` fires concurrently under `--runInBand`, so a total count would flake.

**M5** — `revokedAt` on an already-revoked key must survive a later suspension. That is the audit
promise the comment makes, and the `revokedAt: null` filter is the only thing keeping it.

**M6** — blast radius. Nothing tested that the sweep is scoped to the suspended user: every other
test checks that the VICTIM's key stopped working, and a sweep revoking every key in the instance
satisfies all of them.

## The stub contract changed, and that is a Ruling

Ruling: `resolveActor`'s injected `db` must now provide `users.findUnique`. Six suites hand this
module a narrow stub carrying only the tables they care about, and the first version of the reader
check assumed the method exists — it threw a `TypeError` from inside the resolver, which the api-key
branch has no handler for. Measured: **39 failures across 7 suites**.

**A throw is not failing closed. It is failing loudly somewhere else.** `creatorStatus` now returns
`"unreadable"` when the method is absent, which denies like every other failure mode, and two stub
definitions declare the new contract:

    __tests__/security/authorization/apiKeyGrants.test.js   (local `keyDb` helper)
    __testHelpers__/grantStore.js                            (shared by 4 HTTP suites)

Every future narrow stub inherits this: a stub without `users.findUnique` now denies rather than
resolving a principal, which is correct but silent, so both definitions carry a comment saying so.
Four more suites needed only the shared helper; two needed their own (`keyKindRequired.test.js`,
`t4bResolvedWorkspaceGrant.test.js`).

Ruling (TL-2): revocation is PERMANENT. `revokedAt` is never cleared, including on un-suspension —
a restored user mints a new key. Reviving old secrets would mean a credential that may have been
copied during the suspension silently works again. Stated in `revokeCredentialsFor`'s JSDoc, not
only here, and pinned by D5.

Ruling: the three denial conditions stay DISTINCT — `missing`, `suspended`, `unreadable`. Collapsing
"no user found" into "not suspended" is the fail-open QA-2's D3 names, and it is reachable:
`api_keys.createdBy` has no foreign key (measured in the S12 recon), so a key really does outlive
its creator.

## TL-2 FAIL on `49f7a0cd9` — four findings, all confirmed by running them

**F1, BLOCKER.** `castColumnValue` was `Number(Boolean(value))`, and every non-empty string is
truthy. Measured: `"0"` -> 1 and `"false"` -> 1, which is exactly what a JSON client sends to
UN-suspend. Combined with the permanent-revocation ruling I proposed, that is unrecoverable — the
operator's un-suspend would suspend the account again AND destroy every key the user has, with no
way back. Now strict: only `1`, `"1"` and `true` suspend.

Ruling: the cast fails toward NOT suspending. An unrecognised value means active, because the reader
enforces suspension on every request — a missed suspend is visible and repeatable, a wrongful one
that destroys credentials is not.

**F2.** `isSuspending = true` survived: nothing asserted that an unrelated update leaves keys alone,
so a mutant firing the sweep on every write — a rename, a bio edit — went unnoticed.

**F3.** My ledger claimed the `M6` CONTROL catches a dropped `revokedAt: null` filter. **That claim
was false**, and TL-2 was right to reject it: `M6` mints the bystander's key and then suspends, so a
mutant that only widens the filter within one `createdBy` never touches it. The mutation is in fact
caught by `M5`, which is about the timestamp, and the table above now says so. A new `F3` test
covers the pre-existing-key shape on its own terms.

**F4, two different failures needing two different fixes.** Measured separately: `groupId` 999999
answered **200 and bumped a policy version** — `removeGroupMember`'s `deleteMany` is a no-op on an
empty set, but the bump runs first and unconditionally, and `workspaceScopeKeysFor` falls back to
`orgId ?? 1`, so the bump published under `org:1` and flushed every cached decision in the instance.
`groupId` `"abc"` became `NaN` and threw inside the repository as a **500 with no bump**.
`Number.isInteger` alone fixes only the second; an existence check alone fixes only the first. Both,
parse first, and the 404 is answered BEFORE any repository call — asserted as
`policy_versions` unchanged across the call, so a 404-that-still-bumps stays red.

## F5 / D6 — the delete path, both layers

TL-2 security review, HIGH: `User.delete` is a bare `deleteMany` on `users`, and neither
`api_keys.createdBy` nor `principal_role_grants.principal_id` has a foreign key, so a deleted
super_admin's key kept authenticating against their orphaned grant.

Ruling (TL-2): BOTH layers, and they do different jobs.

  reader   `keyGrantPrincipal` refuses a creator whose row is gone. This is what CLOSES it, and
           it holds whether or not the sweep ran.
  sweep    `User.delete` stamps `revokedAt` inside its transaction, before the rows lose their
           owner. This is the investigator's record of WHEN a key died — no query can reconstruct
           it once the user row is gone, and a resolver check cannot express it.

Ruling (TL-2): the key rows are STAMPED, never deleted. `browser_extension_api_keys` disappears
only because its foreign key cascades; `api_keys` has none, and keeping the stamped row is the
point. Orphaned grant rows stay #135.

Ruling (QA-2 D6): the fixture deletes through the REAL route and leaves `createdBy` DANGLING —
still holding the id, now pointing at no row. Nulling the column by hand would quietly turn it into
D3's shape and test nothing new, so the test asserts `createdBy === user.id` AND that the user row
is gone.

Ruling: three creator states, asserted side by side rather than two plus inference —
`null` allows (single-user deployments have no user rows, so EVERY key they ever issued has a null
creator; refusing these takes `/v1` offline), `dangling` refuses, `present` is checked against the
column.

## F1 generalised — an explicit set, refused in the CALLER

QA-2 widened the input set: `"false"`, `"no"`, `"[]"`, `"0.0"` all coerced to 1, with only `""`
reaching 0. So no special case for `"0"` — an explicit set, and anything outside it is refused.

Ruling (TL-2): `castColumnValue` RETURNS the refusal (`null`); `User.update` turns it into
`{success: false, error}`. A throw would surface as a 500 for what is a malformed request. `_update`
bypasses the cast entirely and is left alone. Scope is the `suspended` case only — widening
`default: String(value)` is a different change with its own blast radius.

Ruling (TL-2): the refusal must never reach prisma as `undefined`. Prisma SKIPS an undefined field
and returns success with nothing changed, which reads to the caller as a suspend that worked. The
guard is on `=== null` before the write, and the test asserts the ROW, not the envelope.

**F1c (QA-2).** `{"suspended": "banana"}` and `{"suspended": "2"}` answered 200 with the row set to
1 and every key revoked permanently — off a value that means nothing. The explicit set already
refuses these; the test now pins the accept-set from THREE directions rather than one: `"1"`
suspends, `"0"` un-suspends, and `"banana"` / `"2"` / `"-1"` / `"null"` / `"undefined"` each leave
the user ACTIVE with their key still valid. Asserted on the row and the key, never the envelope.

## Residuals

- **`document_acl` rows survive suspension.** Safe TODAY because `actorResolver` returns `null` for
  a suspended user before any ACL is consulted; it stops being safe the moment anything answers an
  ACL question without the resolver. Cleanup is #135. **This slice does not claim to revoke access
  completely.**
- **No `user.offboard` action.** One call site does not justify a permission row and a migration.
- **JWTs cannot be revoked.** 30-day default, no session table, no denylist, no `jti`. S13.

## Evidence

`npx jest __tests__/security/authorization/offboardUser.test.js` → **11 tests: 8 passed, 3 red**.
The three reds are the QA-2 fixtures above, written before the fix exists and left red deliberately
until TL-2 rules on the shape. Rebased on `f9da33fca`, the pre-existing 7 plus `routeGateSweep`
remain green (40/40).
`routeGateSweep.test.js` → **33 passed**, pinned count 318 → 319 with the reason in the comment.

RED against `941aa79e8` before the change: the key test (a suspended user's key authenticated —
`next()` called, no status), the endpoint test (route does not exist), and the two version tests
now deferred.

### Mutations, each named at the test it takes red (§7.9f)

| mutation | test that goes red |
|---|---|
| do not revoke at all | `refuses the key at the middleware, not merely in the column` |
| revoke every key, unfiltered by user | `CONTROL: an active user's key still authenticates` |
| revoke OUTSIDE the transaction | `ATOMICITY: if revocation fails, the suspension does not land either` |
| drop `user.manage` from the new route | `every mounted mutating route has identity-verified authorization`, `no mutating route carries validatedRequest alone` |
| relax `isConfirmedSingleUser` to "exactly one user" | `returns false as soon as ANY user row exists` |
| revert (a): drop the suspended lookup from `keyGrantPrincipal` | `QA2-1`, `QA2-2` |
| revert (b): edge-triggered sweep | `QA2-3` |
| drop `createdBy` from the revoke filter | `M6: BLAST RADIUS` |
| drop the `revokedAt: null` filter | `M5: an already-revoked key keeps its ORIGINAL revokedAt` |
| endpoint deletes the membership directly, bypassing `removeGroupMember` | `an operator holding user.manage can remove a member` |
| `unreadable` reads as `active` (fail open on a narrow db) | `UNREADABLE: a db that cannot answer about the creator denies, and does not throw` |
| `missing` reads as `active` (a deleted creator) | `D3: a key whose creator was DELETED is refused, and not read as unsuspended` |
| `castColumnValue` back to `Number(Boolean(v))` | `F1: an UN-suspend sent as a string does not suspend, and does not revoke` |
| `isSuspending = true` | `F1`, `F2: changing an unrelated field does not revoke the user's keys` |
| drop the group existence check | `F4a: a NONEXISTENT group is 404, and bumps no policy version` |
| drop `Number.isInteger` | `F4b: a NON-NUMERIC groupId is 404, not 500` |
| `User.delete` without stamping | `F5: a DELETED user's key is refused, with no sweep involved` |
| `User.delete` DELETES the key rows instead of stamping | `F5` |
| route the null creator through `creatorStatus` | `QA2-5`, `THREE STATES` |
| the refusal returns `undefined` instead of `null` | `F1` |

**The `missing` mutation SURVIVED its first run**, with all 26 tests green across two suites: nothing
asserted that a deleted creator denies, because every fixture had a creator row. The D3 test was
written because the mutation escaped, not before it.

**Revert (b) SURVIVED its first run.** TL-2 expected `QA2-3` to catch it; it did not, and the reason
matters: the reader-side check (a) now refuses a suspended creator, so the key is dead whether or
not the sweep ran, and every reachability assertion passes. An edge-triggered sweep is invisible to
any test that asks "can this key authenticate".

What it still owes is the AUDIT RECORD, so the assertion moved there: a key that appears while the
user is ALREADY suspended — written directly, as a restore or an out-of-band job would, since the
model now refuses to mint one — must still end up stamped, and only a level-triggered sweep stamps
it. That is also why `keyFor` could not be used for this fixture: the free create-side refusal
removes the shape the test needs.

**The atomicity mutation SURVIVED at first**, and that is the finding worth keeping. Moving the
revoke outside the transaction left all six other tests green, because every one of them observes
the END state of a call that succeeds — and both orderings reach the same end state when nothing
fails. What separates them is a failure BETWEEN the two writes, so the test induces one. Without
it, "in the same transaction" was a claim in a comment with nothing behind it.

## Full-suite result

`yarn test` on a freshly migrated and seeded database: **3276 passed, 1 failed, 36 skipped**
(224 suites passed, 1 failed).

The one failure is `__tests__/api/boundKeyDocumentsHttp.test.js` — `socket hang up` in
`Q41-2: a bound key sees only its own documents in the folder`. Run alone it is **35/35**. It is a
transport failure under full-suite load, in a file this change does not touch and on a path that
has nothing to do with offboarding: no assertion failed, the connection dropped. Reported rather
than re-run until green.

## Baseline note

The first full-suite run reported 29 failures. They were environmental, not this change: the run
used a scratch database that had never been migrated, and the failures are all
`The table \`public.<x>\` does not exist`. Re-run on a freshly migrated and seeded database before
any claim about the suite — a red run whose cause is the harness says nothing about the diff, and
reporting it as a result would be worse than not running it.

## Two fixture defects found in my own tests

Both produced a confident wrong answer before being fixed, and neither announced itself:

- the first key test set `suspended` with a raw `prisma.users.update`, **bypassing the code under
  test entirely**. It stayed red after a correct implementation, and I looked for the fault in the
  implementation before finding it in the fixture. It now goes through `User.update`, with an
  intermediate assertion on `revokedAt` so a failure says which half is wrong.
- the atomicity test first induced its failure with `jest.spyOn(prisma.api_keys, "updateMany")`.
  That spy never fires: the write happens on the TRANSACTION client, a different object. The mock
  silently did nothing and the test reported the code broken when the fixture was. It now uses
  `prisma.$use`, which runs for every client derived from the shared one.

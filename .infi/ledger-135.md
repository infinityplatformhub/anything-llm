# Ledger — #135 (three user-deletion call sites → offboardUser), auth tier

Dev2, reassigned from Dev5. Branch `135-callsites-dev2` off `approof/main`.
Files: `endpoints/admin.js`, `endpoints/api/admin/index.js`,
`endpoints/system.js`, `models/user.js`,
`utils/authorization/policyRepository.js`, plus two new test files.

---

## Rulings

**Ruling: five repository tests passing is NOT the RED for this issue.** — My
first five fixtures drive `offboardUser` directly and were green on main from
the start, because the primitive already works. Reporting "5 RED" would have
read as progress while the defect was untouched. The RED that matters is the
three ROUTE fixtures, which failed with `Expected: 0 / Received: 2` (grant + ACL
surviving) and `Expected: "function" / Received: "undefined"` (the rollback
helper missing). — **If wrong, the issue closes with the routes still leaking.**

**Ruling: the offboard and the delete are ONE transaction, offboard first.**
— TL-2. Two sequential calls recreate the orphan through a narrower window: a
crash between them leaves the account gone and its grants behind. Offboard-first
also means a refusal aborts the delete rather than deleting and then failing to
clean up. — **If wrong, the fix reintroduces the bug it closes, rarely enough to
look like corruption.**

**Ruling: a refusal is 403 with the generic `{error: "Forbidden."}`; the
permission is named SERVER-SIDE.** — Superseded my first attempt, which put
`role.revoke` in the response body. `requirePermission` maps
`AuthorizationContractError` to a 500 (`:92`), which would send an operator
looking for an outage — hence the catch. But naming the missing grant to an
unauthorized caller is a probing oracle, so the body matches every other route
and the attribution goes to the log. Recorded as **seam drift**: the route
answers a different status than the middleware would for the same error, which
is deliberate and needs to stay visible. — **If wrong, either operators debug a
phantom outage, or callers learn which grant to acquire.**

**Ruling: a BEHAVIOUR CHANGE is being made and stated plainly.** — An API key
whose creator lacks `role.revoke` could delete a user yesterday and cannot
today. The permission was always wrong for an operation that removes grants. No
seeded role holds `user.manage` without `role.revoke`, so default deployments
are unaffected — measured, not assumed. — **If wrong, an operator's automation
starts 403ing with no note in the issue.**

**Ruling: `revokeCredentialsFor` is exported and reused, not reimplemented.**
— See the regression below.

## The regression I introduced, and how it was caught

Replacing `User.delete` with `tx.users.delete` inside the new transaction
**skipped the `revokedAt` stamp** that `User.delete` performs via
`revokeCredentialsFor` — the S12 record of *when* a key stopped working, which
no later query can reconstruct.

It surfaced as `offboardUser.test.js` F5 failing. I did not assume it was mine:
stashed my changes and re-ran, **baseline 24/24, mine 23/24**, which named me as
the cause before I touched anything. Fixed by exporting `revokeCredentialsFor`
and calling it inside the route transaction, so the stamp has one
implementation rather than a copy that drifts.

**The lesson: a full-suite run was what caught this.** My own eleven fixtures
were green throughout — none of them asserts anything about API keys, and none
would have.

## Evidence

```
route fixtures BEFORE the fix   3 RED (2 orphan rows survive; helper undefined)
after wiring                    11/11 GREEN (3 route + 5 repository + 3 folded)
offboardUser.test.js            24/24 (was 23/24 mid-work — regression above)
combined                        35/35
```

Real-store suites (weaviate/milvus/qdrant/chroma) fail without their services;
unrelated to this change and failing identically on baseline.

## Mutants

| # | mutation | red |
|---|---|---|
| M1 | move the cleanup INTO `User.delete` | **exactly 1** — RF-P5 only, as TL-2 required |
| M2 | admin site passes `locals.user` instead of `locals.actor` | 2 — the route test and the identity test |
| M3 | API site passes exempt `coreJobs` instead of `resolveActor` | 1 — the refusal control |
| M4 | rollback loops per user instead of one truncate | 1 — the bump count; end state stays green, which is the point |
| M5b | raw `deleteMany` on all three tables instead of the primitives | 3 — including RF-3 |

**M5 (my first attempt) SURVIVED and the test was right to pass.** I deleted
`grant_revocations` *before* `revokeGrant` rewrote them, so the count still
matched — the mutation did not express what I meant. M5b is the mutation TL-2
actually named. Recorded because "a surviving mutant means a weak test" was
false here: it meant a badly written mutant.

## Fixture bugs of mine, and what each cost

Four, all caught by running rather than reading: `setval(id-1, true)` fails when
the victim is id 1 (used `is_called=false`); `engine.evaluate` does not exist
(`DatabaseAuthorizationEngine.authorize`); `api_keys` has no `secret` column and
`ApiKey.create` needs explicit scopes plus a creator holding the ceiling;
`roles` has no `description`.

## Measured correction to my own expectation

The admin route's refusal fixture expected a 403. It answers **200 with
`success:false`**, because `validCanModify` (`helpers/admin/index.js:45`) runs
first and refuses the weak actor before the offboard is reached. Asserted as it
behaves rather than bent toward the expectation — the refusal is real and
nothing is deleted, which is the property that matters. The 403 path is
exercised by the API route, which has no `validCanModify` ahead of it.

The fixture carries three self-checks (the constructed role holds `user.manage`
and not `role.revoke`; the actor's resolved permissions exclude `role.revoke`; a
grant exists to revoke) so that a refusal for the wrong reason cannot read as
success.

## Out of scope, said explicitly

Calling handlers off `app._router.stack` skips `validatedRequest`,
`requirePermission` and `validApiKey`. These fixtures prove the route BODY
cleans up; they do not prove the route is guarded. That is
`routeGateSweep.test.js` / `routeMountGuard.test.js`.

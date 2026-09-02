# Dev5 — #136 slice 2 ledger: `offboardUser` (auth tier)

**Skills invoked:** `test-driven-development` (RED before implementation, every fixture
seen red for the right reason); `systematic-debugging` (the three surviving mutants);
`verification-before-completion`.

Branch `approof/offboard-user`, off `origin/approof/main` @ `0d5306d3d`.
RED commit `4ee434ae3` (6 red, all `repository.offboardUser is not a function`).

---

## Rulings followed

**TL-1 `6aabd6b7d`** — (1) no raw prisma writes inside `offboardUser`; each primitive
carries a guard (`refuseGroupEscalation`), a scope derivation (the group row's `orgId`)
or an audit write (`grant_revocations` read-before-delete) that a raw statement destroys.
(2) N bumps is CORRECT, not tolerated — `inTransaction` inlines when handed a `tx`, so
one outer transaction still runs N `bumpVersion` calls, and collapsing them needs the
barred `bumpVersion` export. The intermediate versions live inside an uncommitted
transaction, so no reader observes one. (3) Idempotency by ENUMERATING first —
`removeGroupMember` bumps even on a no-op delete, so blind calls make a re-run write a
row per membership the user used to have.

**TL-2 #135 actor ruling** — the fixture actor is a real `super_admin` user holding
`role.revoke`, matching what `response.locals.actor` resolves to at `admin.js:178`.

**Ruling (mine): the exempt principal builds worlds, it does not run the offboard.**
`SERVICE_PRINCIPALS.singleUser` skips BOTH `refuseGroupEscalation` and `revokeGrant`'s
`role.revoke` check. A fixture that exercises the code under test with the one principal
that bypasses both guards proves nothing about either — measured, M1 below.
If wrong: the guards ship untested and a raw-write regression passes the suite.

**Ruling (mine): F2 asserts rollback scope, not a bump count.** My original fixture
("exactly one `policy_versions` row for N removals") was wrong and TL-1's measurement
replaced it. A bump count pins an implementation detail that changes the day the
primitives batch; what one transaction actually buys is all-or-nothing, so that is what
is asserted — failure injected through `prisma.$use` (middleware fires for transaction
clients; `jest.spyOn` does not), then memberships, grants, `grant_revocations` and
`policy_versions` all asserted back at baseline.

---

## Mutation testing — 10 mutants, THREE survived first

Every mutant was diffed against the pristine file before running (§7.17: a mutation
that does not change the file is not a survivor).

| # | mutation | first result | after |
|---|---|---|---|
| M1 | raw `tx.group_members.deleteMany` for `removeGroupMember` | **SURVIVED 8/8** | F9 → 1 red |
| M2 | call primitives blindly (no enumeration) | 1 red | — |
| M3 | drop ACL removal entirely | 2 red | — |
| M4 | no transaction (`fn(db)` directly) | 1 red (F2) | — |
| M5 | `workspaceId: null` on `revokeGrant` | **SURVIVED 7/7** | 3 red |
| M6 | raw `principal_role_grants.deleteMany` | 1 red | — |
| M7 | raw `tx.document_acl.deleteMany` | **SURVIVED 9/9** | F10 → 1 red |
| M8 | drop `requireActor` | **SURVIVED 11/11** | F11 strengthened → 1 red |
| M9 | enumerate every user's grants (drop principal filter) | 1 red (F5 control) | — |
| M10 | wrong `action` on ACL removal | 2 red | — |

### Why each survivor survived — the part worth keeping

**M5.** `world()` only built org-scoped user grants, so a call passing `workspaceId:
null` matched everything there was to match. Fixed in the FIXTURE, not the test list: a
workspace-scoped grant naming the user now exists in every world.

**M1.** F8 (a `content_moderator` refused) did not catch it: that actor is refused by
`revokeGrant` before the missing membership guard could matter, so the suite never
noticed `refuseGroupEscalation` had stopped running. **F9** offboards a user holding NO
grants and NO ACLs — `removeGroupMember` is then the only primitive called and its guard
is the only thing between a moderator and stripping a super_admin group's membership.
F9 also asserts the legitimate actor still succeeds, so it is a guard and not a wall: a
fixture that only proves "it throws" is satisfied by throwing always.

**M7.** A raw `document_acl.deleteMany` removes the same rows and publishes NOTHING
under `document:<id>`. Every "the rows are gone" assertion stays green while a
document-scoped consumer never learns its ACL changed. **F10** asserts the scope KEYS
written, not a count — TL-1's bump-count ruling stands; WHICH key a bump carries is the
difference between an invalidation and a row nobody reads (the RF-5 lesson).

**M8.** F11 originally passed a bare `userId: 1`. With `requireActor` deleted the
enumeration found nothing, no primitive ran, and the function returned cleanly — the
refusal has to come from `offboardUser` BEFORE any work, not incidentally from whichever
primitive happens to run first. F11 now uses a user that has rows and asserts they
survive.

---

## Lesson for §7.17

`Ruling: never run a full suite blocking inside the tool timeout.` A 10-minute tool
timeout killed a `yarn test` at 10:00 and produced no result at all — and while it
blocked, three PMO pings went unanswered and slice 2 was reassigned. The run must go to
the background logging to a file, with status reported from the log. The cost of a
blocking run is not the wasted ten minutes; it is that the session goes silent and
looks dead.

# Ledger — #31 T-7 admin duties

Base `70283c1b`. Branch `approof/t7-admin-duties`. DB `approofworkspace_t7`. Migration slot **20260902070000**.

## What T-4a already did, so T-7 does not redo it

- `chatHistoryViewable` usages already sit *behind* `requirePermission` at all 3 sites (`system.js:1200`, `:1244`, `embedManagement.js:98`). T-7 deletes the middleware and env var; the permission gates are in place.
- `/system/workspace-chats` already requires `chat.read_others`; `/system/export-chats` already requires `document.bulk_export`. D-2's remaining half is the **AND** — export needs both.
- `revokeGrant` already has `requireActor` (added by T-3's security round). What is missing is the `role.revoke` **permission** check and the revocation audit trail.

## Open question recorded before work starts

`revoked_by` cannot be a column on `principal_role_grants`: `revokeGrant` DELETEs the row, so any column on it is gone with the grant. A revocation record needs somewhere that outlives the grant. Options are a `grant_revocations` audit table or soft-delete on the grant. Deciding in favour of the audit table below.

## D-4 done

Ruling: revocation history lives in a `grant_revocations` table (migration 20260902070000), not a `revoked_by` column. `revokeGrant` deletes the grant row, so a column on it is destroyed by the act it exists to record. Soft-delete was rejected: every grant query would then carry `WHERE revoked_at IS NULL` forever, and one omission silently restores revoked access. PMO approved. If wrong, the table needs pruning policy the grant row would have gotten for free.
Ruling: `role_name` is denormalised into the revocation row and there is deliberately NO foreign key to `roles`. A role renamed or deleted later must not erase the history of grants that carried it — the auditor needs the name as it was at revocation time. If wrong, a rename makes old revocation rows disagree with current role names.
Ruling: the audit row is written in the SAME transaction as the delete and the version bump. An audit log that can lose a row while the deletion commits is worse than none — it looks complete when it is not. Proved by a test asserting a refused revocation leaves no row AND does not move the policy clock.
Ruling: `isExemptPrincipal` continues to cover `singleUser`/`coreJobs`, so `legacyRoleGrants`' demotion path keeps working without holding `role.revoke`. If wrong, user demotion breaks the moment the exemption is narrowed.
Note: index names in the migration must match Prisma's generated convention (`grant_revocations_principal_type_principal_id_revoked_at_idx`), or `migrate diff` reports drift on every later migration. Caught by running the diff, not by reading.

## D-1 done

Ruling: the `DISABLE_VIEW_CHAT_HISTORY` read happens in **Node at boot**, not in the migration. Postgres cannot see the Node process environment — `current_setting('app.disable_view_chat_history', true)` returns NULL whatever the operator set, so a SQL branch on it would silently take the "was not set" path forever, looking like it read the environment while never doing so. Proved with a test that asserts the NULL. Slot `20260902071000` documents the reason and establishes nothing structural; `utils/authorization/chatHistoryMigration.js` does the work, guarded by a `policy_versions` marker written in the same transaction as the change. If wrong, the one-shot belongs in a dedicated migrations-run-once table rather than the policy clock.
Ruling: when the var WAS set, `chat.read_others` is withdrawn from every role except `super_admin`, who can grant it back deliberately — that ability is the entire point of it being a permission. An operator who never set it keeps today's behaviour untouched.
Ruling: dropped the frontend's 24-hour `localStorage` cache of this capability. A flag that only moved when an operator edited the environment could be cached for a day; a grant an admin can revoke at any moment cannot, or the UI keeps offering a feature the server has already begun refusing. Session-only now, failing closed when the request fails. If wrong, the capability endpoint needs its own short TTL rather than none.
Ruling: added `GET /system/my-capabilities` rather than extending `/system/keys`. `keys` answers "what is this instance configured for" and is the wrong shape for "what may this caller do" — reusing it is what made the old flag instance-wide in the first place.

## #40A absorbed into T-7 (PMO ruling)

Ruling: `GET /system/my-capabilities` is the capabilities endpoint #40A planned, so it generalises beyond `chat.read_others` to a fixed `ORG_CAPABILITIES` list. The list is deliberately NOT "every seeded action": an endpoint enumerating the whole vocabulary hands any caller a map of the permission model, and the UI only gates on a handful. If wrong, T-8 needs actions this list omits and adds them explicitly.
Ruling: capabilities are reported present-and-false rather than omitted when denied, so a client can distinguish "denied" from "the server did not answer". Failure returns `{}` — fail closed, offer nothing.
Note: this endpoint gates AFFORDANCES only. Every route re-decides independently, so a stale or forged answer shows a menu item that then refuses. Recorded because a capabilities endpoint invites being mistaken for a gate.

## D-3 done

Ruling: impersonation provenance lives IN the signed JWT (`impersonatedBy` claim), not beside it. A claim the holder could drop would let them upgrade a read-only view-as-user session into a real one — the token is the only part of the session they cannot edit. `validatedRequest` copies it to `locals.impersonatedBy`, which `actorResolver` has read since T-2 while nothing wrote it.
Ruling: read-only is NOT re-enforced in the route or the UI. The engine denies every non-read action for an impersonated actor before any policy lookup (T-2), so a route that forgets is still safe; a second enforcement point could disagree with the first, and then the question is which one is right.
Ruling: an impersonated session cannot impersonate again, and nobody can view as themselves or as a suspended user. Chaining would lose the head of the provenance chain — the second hop would record the first target as the impersonator.
Ruling: the token expires in 30 minutes, against the normal 30 days. This is a support tool, not a login.
Note: the S-tests drive the REAL middleware with the REAL signed token. A test that hands `{impersonatedBy}` to `authorize()` proves the engine, which T-2 already did — it cannot prove the feature exists.

## Admin helper on grants

Ruling: `validRoleSelection` / `validCanModify` now ask `canAssignLegacyRole` — the same escalation guard `grantRole` uses (you may hand over only what you hold) — instead of comparing `user.role` in a fixed hierarchy. The old shape could not express a delegated admin who may create members but not other admins, and it read the caller's legacy role, which R4 froze precisely because it is no longer the source of truth. `canModifyAdmin` is left reading the column: it is a lockout guard, not an authorization decision, and the admin UI still writes that column. If wrong, the last-admin guard needs to count org-role grants rather than legacy role strings.

## Two test defects found and fixed while adding coverage

Note: `myCapabilities.test.js` first used its own `new PrismaClient(...)` while the endpoint under test resolves the shared `utils/prisma`. The test wrote to one database and the route read another, so every capability came back false — which is indistinguishable from a correct deny, and the "plain member holds nothing" case passed for entirely the wrong reason. Fixed by using the shared client. Worth remembering: an all-denied result is exactly what a misconfigured authorization test looks like when it is right AND when it is broken.
Note: with the shared client, a hard-coded actor id collided with another suite's data in the full run while passing in isolation. Actor ids are now derived per process.

## Migration slots moved (PMO/Techlead ruling)

Ruling: `20260902021000` → `20260902070000` and `20260902022000` → `20260902071000`. The T-7 slots sat inside T-1's authz block; moving them past the PR-4b range makes replay order match merge order. Refs in the plan and this ledger updated with them — a slot number quoted in prose and not in the directory name is how a rename goes half-done.

## Grant management endpoint (PMO ruling: stays in #31, not split)

Ruling: `POST/DELETE/GET /admin/authorization/grants` lands in T-7 rather than a separate issue. Without it the duty split is nominal: T-1 seeded `setup_admin` and `content_moderator` with their permissions, but `grantRole` had no HTTP surface, so the only roles anybody could actually receive were the two `users.role` maps to. Three seeded roles and two reachable ones.

Ruling: TWO guards on the write path, deliberately asking different questions. The route gate asks whether the actor may grant in this SCOPE — `grantScopeFromBody` resolves the body's `workspaceId` to the org or one workspace, so an admin holding `role.grant` only inside a workspace is refused at the org. The gateway then asks the T-2 question: does the actor hold every permission the role carries. Neither can see what the other sees — the route gate never learns which role, the gateway never learns the HTTP scope — so both must pass. If wrong, one of them is redundant and should be removed rather than left as decoration.

Ruling: `grantScopeFromBody` takes `workspaceId` from the request body, which looks like a B-3 violation and is not. B-3 forbids deriving a resource's OWN workspace from the body; here the workspaceId names the scope the new grant is written into, and there is no stored row to read it from yet. The resolver still looks the workspace up and authorizes against the stored row, so a nonexistent workspace is a 404 and a workspace the actor holds nothing in is a refusal in that scope.

Ruling: `service` and `system` principals are NOT assignable over HTTP (400). They are exactly the principals `isExemptPrincipal` skips the escalation guard for, so granting a role to one over the network is a way to route around the guard that protects every other grant.

Ruling: a grant may only name a principal that exists (404). Without the check a typo writes a row that grants nothing today and silently begins granting the day an unrelated user is created with that id — the grant outlives the mistake.

Ruling: a workspace-scoped role named without a `workspaceId` is a 400 saying "no org-scoped role named X", not "no such role". A caller told the role does not exist goes looking for a typo in the name; the mistake is the scope.

Ruling: revoking a grant that was not there answers 200 with `deleted: 0`. The caller asked for it to be gone and it is. A 404 would report whether the grant existed, which is the enumeration answer the gate withheld.

Ruling: `GET .../grants` is gated on `access.diagnose`, not `role.grant` — reading who holds what is the diagnostic question, and an auditor who may not change grants still needs to see them.

Ruling: the escalation guard's refusal returns 403, not 400. The body was well formed; the actor was not permitted. A 400 would send the caller looking for a malformed request.

## Two test defects caught while proving RED

Ruling: the first RED run was WORTHLESS and looked convincing — 9/9 failed, but the suite failed to *run* at all (`DATABASE_URL` without a username, so `CREATE DATABASE` was denied). Every test fails identically whether or not the code under test exists. A RED proof has to fail for the reason claimed, which means reading the failure, not the count. Rule for §7.9: a RED run is evidence only once its failure message names the missing behaviour.

Ruling: with a real RED run, one test still passed with the routes entirely deleted — it asserted only `status === 404`, and Express answers 404 for a route that does not exist. Now asserts the error body too. A status-only assertion against a 4xx cannot distinguish "the code refused" from "the code is not there". Rule for §7.9: every 4xx assertion checks the body, not only the status.

Note: `prisma generate` had not been run in this worktree since `grant_revocations` entered the schema, so `prisma.grant_revocations` was undefined and the audit test failed for a stale-client reason that looks exactly like a missing feature. §7.0 already records that `yarn test` regenerates the client; a bare `npx jest` does not.

## Evidence

`Tests: 969 passed, 969 total`, `Test Suites: 90 passed, 90 total` at `2a911a7e` (`yarn test`, Node 22, PostgreSQL).

## Rebase recipe recorded before the rebase (Techlead)

Ruling: `policyRepository.js` conflicts with main's #39. Resolution is `inTransaction(db, async (tx) => {` from HEAD plus t7's whole body — NOT t7's side wholesale, which silently reverts #39. This is the same failure shape as #39's own `JobRuntime.js` conflict: taking one side whole leaves a green suite, because `db.$transaction` still works everywhere except the one case #39 exists for (a caller already holding a tx, where nesting throws). A conflict where either side compiles and the tests pass is the kind that gets resolved wrongly.

## S-20 closed (the last DoD item without a test)

Ruling: S-20 asserts `chat.read_others` on EVERY route reaching other people's chats, driven over HTTP by a legacy `role: "admin"` who holds only the `member` grant — precisely the actor the old role check waved through. Two refusals plus a positive control, because a suite of refusals alone passes just as well against a route that does not exist.

Ruling: the `/v1` leg of S-20 is NOT in this branch. Grant enforcement on `/v1` is T-4b's W-8 (`4eab9839`), which is not in t7's base, so a test here would assert against code that is not present and would pass for the wrong reason. It belongs in the post-rebase run. Recorded rather than silently dropped.

Note: the D-2 negative first used `content_moderator`, which the seed gives BOTH `chat.read_others` and `document.bulk_export` — it cannot demonstrate that the export route needs the second permission. Replaced with a role holding exactly one. A test for an AND needs a principal that has one half, not one that has both and passes anyway.

Note: the first run of this suite was 3/3 red and meant nothing — `/system/workspace-chats` is a POST and the test sent GET, so Express answered 404 for all of it. Same §7.9 failure as the grants suite, one hour apart: the count looked like proof, the reason was not read. The verb now comes from a route table in the test rather than a convenience helper.

## Evidence

`Tests: 972 passed, 972 total`, `Test Suites: 91 passed, 91 total` (`yarn test`, Node 22, PostgreSQL).

## Rebase onto main (final)

Ruling: `policyRepository.js` resolved by the recipe — `inTransaction(db, async (tx) => {` from HEAD, t7's `role.revoke` guard body kept whole. All 5 transaction sites verified to use `inTransaction`, and the guard verified present, because either half alone compiles and passes.

Ruling: S-20's `/v1` leg is now IN, since T-4b's W-8 arrived with the rebase. Two API keys with IDENTICAL scopes differing only in whose grants stand behind them — effective permission is grants(creator) ∩ scopes(key), so a test where the scopes also differ proves only the scope half, which PR-4a already had. RED proof disables `grantAllows` alone: the `/v1` refusal fails, its positive control and all three session tests stay green.

Note: `__tests__/utils/helpers/modelPricing/cacheIsolation.test.js` — "two instances with different directories do not overwrite each other" — fails on **pristine `origin/approof/main` (40ded26b)**, verified in a clean worktree. Not T-7's: no file in this branch's diff touches modelPricing. Reported to PMO rather than fixed here.

## Evidence (rebased)

Fresh database, `migrate deploy` from empty, `yarn test` on Node 22:
`Test Suites: 1 failed, 112 passed, 113 total` · `Tests: 1 failed, 1167 passed, 1168 total`
The single failure is the pre-existing main flake above. Every T-7 suite passes.

## QA-1's leak: the cause was not missing cleanup

Ruling: fixed with `jest.resetModules()` before `require("../../../utils/prisma")`, NOT with an `afterAll` that deletes rows. `utils/prisma` is a singleton binding `DATABASE_URL` at FIRST require, and `jest --runInBand` shares one process across suites — so when an earlier suite had already loaded it against the shared database, every write in `beforeAll` landed there instead of in this suite's own database, and dropping the suite's database at the end removed nothing. An `afterAll` deleting the users would have cleaned up the symptom on the wrong database and left the mechanism intact for the next suite that adds a fixture.

Note: the suite still PASSED throughout, because it only ever reads back what it wrote — the writes were consistent, just in the wrong place. The damage was entirely to other branches: `isConfirmedSingleUser` counts real `users` rows, so leaked fixtures turn `actorResolver` R5 red in a branch that never touched authorization. A test that passes while corrupting shared state for everyone else is the worst shape a green test can have.

Note: verified by measurement, not reading — `users` count in the shared database before and after a solo run of `myCapabilities.test.js` on a freshly created database: 2 before the fix, 0 after. Applied to the other four suites resolving the shared client (`chatReadOthers`, `explainAccess`, `grantManagement`, `routeWiring`). Full run leaves the shared database at 0 users and no leftover `t7_*` databases.

Note: my first diagnosis was wrong and worth recording. I read the two rows in the shared database and concluded the client was binding to the wrong URL; a probe showed it binds correctly when it is required fresh. The rows were leftovers from an earlier run of the same defect. The real variable was WHEN the require happens relative to other suites, which only shows up with `require.cache` instrumentation.

## Evidence (post-fix)

Fresh database, `migrate deploy` from empty, `yarn test` on Node 22:
`Test Suites: 1 failed, 112 passed, 113 total` · `Tests: 1 failed, 1167 passed, 1168 total`
Shared database `users` count after the full run: **0**. Leftover `t7_*` databases: **0**.
The single failure remains `modelPricing/cacheIsolation` (#51, pre-existing on main).

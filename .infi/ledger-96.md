# Ledger — #96: `engine.evaluate` ignores group grants

Dev 3. Branch `approof/96-group-grants`, base `origin/approof/main`.

## What was wrong

`principal_role_grants` accepts `principal_type: 'group'` and the admin UI offers it
(`endpoints/admin/authorization.js:41`). `engine.evaluate` — which every `authorize()`
passes through — read grants for the actor's own principal type only and never touched
`group_members`. QA-3 then measured that `readableScope` (`documentFilter.js:154`) had
the same defect. So a role granted to a group authorized nobody, on both the decision
path and the document-scope path, while the admin UI, `explainAccess`, and the deny half
of `documentFilter` all agreed it was held.

## Rulings

Ruling: the fix is its own issue, landing BEFORE S4, rather than part of it — it is a
P0-5 correctness bug that is true whether or not Lark is ever built. If wrong: an
authorization change ships inside a connector feature, where it gets the review a
connector gets rather than the review authorization gets. (PMO, accepted.)

Ruling: one shared expansion used by all three read paths (engine grant query,
`readableScope` ALLOW half, `documentFilter` DENY half), replacing the inline copy at
`documentFilter:73`. `explainAccess` is untouched — it asks the reverse question
(given a grant, who does it cover) and expands group→members. If wrong: three
expansions free to drift, which is this defect again one release later. (PMO/TL-1.)

Ruling: the helper lives in `utils/authorization/groupMembership.js`, NOT
`principals.js` as the ruling first named. `principals.js` exists because it requires
nothing — hotfix #39, where actorResolver → systemSettings → user → legacyRoleGrants →
actorResolver handed callers a half-built exports object and new workspace members
silently never received their grant. This helper takes a db handle, so filing it there
rebuilds the cycle #39 removed. Verified the hard way: overwriting that file turned the
whole suite red with `SERVICE_PRINCIPALS undefined`. If wrong: a require cycle whose
symptom is silent missing grants. (Dev 3, accepted by PMO.)

Ruling: an api-key actor is NOT expanded through its creator's groups in the engine.
Its authority is what the creator holds directly; inheriting departments would widen
every key whenever someone edits a group, to grants its scope list was never reviewed
against. `grantPrincipalOf` returns the creator, who IS a user, so the refusal has to
be explicit — the type check does not catch it. If wrong: a quiet privilege escalation
on every API key in the deployment.

Ruling: membership is read once per `authorizeMany` call, memoized as the in-flight
PROMISE rather than the resolved array. `Promise.all` starts all 500 decisions before
any finishes, so a value memo has every one of them miss — measured: 100 resources
issued 100 queries. A failed query removes its own memo entry rather than caching a
rejection for the rest of the batch. The memo is per call and never outlives it: a
longer-lived cache would let a removed member keep their access. If wrong: 500 extra
queries per batch, or a cache that keeps revoked access alive.

Ruling: the org filter goes through the `groups` relation (`groups: { orgId }`), not
the membership row — `group_members` has no orgId column, and callers filter on the
GRANT row's orgId, which is not the group's. Without it a grant written
`{orgId: 1, principal: group:2}` matches a member of a group 2 that lives in org 2.
Same SHA, not a follow-up, because the expansion is what makes it reachable. (QA-3.)

## Evidence

- **RED on main:** 4 failed / 2 passed. The 2 that passed are the over-widening
  controls, which must be green on main — a fully-red block would have meant the tests
  were asserting something else.
- **GREEN:** 40/40 in `engine.test.js` (27 before this issue).
- **Mutation, 6 mutants, all killed, each by the intended test and no other:**
  - M1 remove group expansion → 4 group tests; api-key control and all 27 pre-existing green
  - M2 expand api-key creator's groups → the api-key test alone
  - M3 drop `workspaceScope` from the grant query → the workspace-scoped test alone
  - M4 drop the org filter → the cross-org test alone
  - M5 memo stores the resolved value → the batch-cost test alone (100 queries, not 1)
  - M6 revert the `readableScope` ALLOW half → the drift test alone
- M3 is worth recording separately: dropping workspace scoping left all 27
  pre-existing tests green. That guard had no coverage before this issue.

## Residual risks

1. **`group_members` writes do not bump the policy version.** `buildDocumentFilter`
   stamps `policyVersion` from `policy_versions`, and nothing in a membership write
   advances it, so a cached filter keeps a removed member's access for the cache TTL
   (~30s). Not fixed here: this issue writes no membership rows. It belongs to the
   first issue that does — S4a. Recorded by PMO ruling.
2. **A creator holding `system.write` through a group can now mint an API key carrying
   it.** That is the intended consequence of the fix (the grant becomes real), but it
   is new authority on the day this merges, not a pre-existing state.
3. **G6 (TL-1): the type guard in `groupIdsFor` is redundant today.** It returns `[]`
   for a non-`user` principal AND separately refuses a non-integer id. Every service,
   embed and system principal currently carries a non-numeric id, so the first check
   already covers the second — the `Number.isInteger` line cannot fire on any principal
   shape that exists. Kept deliberately: it is the guard that stops a NaN reaching
   Prisma if a future principal type carries a numeric id, and a decision path that
   must fail closed should not depend on that coincidence holding. Recorded so nobody
   later reads it as dead code and deletes it without knowing what it is for.

4. **Deploy-time behaviour change.** Every existing group grant begins authorizing the
   moment this merges. That is the point of the fix, and it is why it got TL-1 plus a
   QA probe rather than an ordinary review. Rollout size is measurable before merge:
   ```sql
   SELECT count(DISTINCT gm.user_id)
     FROM group_members gm
     JOIN principal_role_grants g
       ON g.principal_type = 'group' AND g.principal_id::int = gm.group_id;
   ```

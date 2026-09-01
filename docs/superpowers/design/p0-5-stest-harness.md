# P0-5 — S-test harness plan (S-1..S-26 as a real regression suite)

Status: planning, no test code written. Feeds T-2 onward; S-21/S-22 are runnable **now** against PR-0c/PR-0d.

## 1. Layout

```
server/__tests__/security/authorization/
  _fixtures/authz.js          # builders — single source of test data
  _helpers/request.js         # identity-wrapped HTTP helpers
  conformance.matrix.test.js  # S-role×action matrix (T-2)
  idor.test.js                # S-1..S-4, S-21, S-22
  escalation.test.js          # S-5..S-9
  vector-leak.test.js         # S-10..S-17, S-23..S-26
  diagnostics.test.js         # S-18..S-20
```

Follows the existing P0-3 pattern (`server/__tests__/…` beside the 617). Same runner, same CI job — no new framework.

## 2. Fixtures (builder, not shared state)

`_fixtures/authz.js` exposes one entry point:

```js
buildAuthzWorld({ seed }) → {
  org: {id:1},
  users: { u1, u2, admin, manager },        // 4 users via User model directly
  workspaces: { w1, w2 },                    // u1 member of w1 only, u2 of w2 only
  docs: { a, b },                            // doc a → readable u1 only, doc b → u2 only (document_acl split)
  embed: { config, sessionIds },
  tokens: { jwt: {u1,u2,admin}, apiKey, tempToken }
}
```

Rules:
- **Per-test world** — no cross-test DB state. Setup creates, afterEach truncates the tables it touched (Prisma `deleteMany` on the new tables + workspace/users cleanup). A leaked row breaks exactly one test, not the suite.
- Builders use the **models/seeds from T-1** (permissions vocabulary, system roles) — the suite fails at import time if seeds are missing, which is itself a T-1 DoD check.
- Vector world uses LanceDB with a temp storage dir per test (env override), embedding via the existing offline/stub embedder used by current tests — no network.

## 3. Helpers (`_helpers/request.js`)

- `as(user|apiKey|embedConfig|deviceToken)` → supertest-wrapped agent attaching the right credential header. One helper per identity type = the actor resolver's test double; when T-2's resolver lands, these call it, so the harness already covers all 6 types.
- `assertDenial(res, {status})` — **404 (not 403)** for existence-hiding denies (S-1, S-18), 403 where existence is already known. Encodes the non-oracular contract as an assertion helper so no test re-decides it.
- `currentPolicyVersion()` / `bumpPolicyVersion(scopeKey)` — direct DB access for S-19/S-23 timing tests; never a sleep.
- `contextSentToLLM(chatResult)` — captures the context window (spy on the LLM connector used by current tests) so S-24 asserts **at context-build time, before the model call**, not at the answer.

## 4. Dependency map — which task unlocks which tests

| Tests | Blocked by | Notes |
|---|---|---|
| S-21, S-22 | PR-0c / PR-0d | Runnable immediately after those PRs land; harness itself ships with PR-0c as its first consumer |
| S-4, S-5..S-9 | T-2 (engine + resolver) | conformance matrix + impersonation denies |
| S-1, S-2, S-3 | T-4a (bypass removal) | need engine from T-2 but assert on routes |
| S-20 | T-7 (privacy posture) | chat.read_others |
| S-10..S-17 | T-5 (LanceDB + metadata backfill) | S-11/S-12 additionally need T-4b (embed/API actor) |
| S-23 | T-3 + T-5 | revocation invalidation + fillSourceWindow |
| S-24, S-25, S-26 | T-5 | context-injection checklist (9 paths from recon §5c) as an enumerated test list, one subtest per path |
| T-6 providers | T-6 | vector-leak file parameterized over provider registry — same S-10 assertions, provider = test arg; unsupported provider asserts boot-refuse instead |

## 5. Regression discipline

- Every test lands **RED first**: PR that adds the test includes a revert commit demonstrating failure (P0-3 rule), CI job keeps the revert-proof artifact.
- No `skip` without an open issue number in the skip reason; a grep in CI (`it.skip` without `#issue`) fails the suite meta-check.
- Matrix conformance (S-role×action) is generated from the seeded `role_permissions` table — adding a permission without a matrix row fails conformance, so vocabulary growth (T-7 admin duties) cannot silently skip coverage.
- S-10 runs on every CI job once T-5 lands; it is the Phase 0 gate test and may never be quarantined.

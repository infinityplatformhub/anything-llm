# P0-5 — S-test harness plan (S-1..S-24 as a real regression suite)

Status: planning, no test code written. **S-numbers are owned by `p0-5-authorization-recon.md` §4 (canonical registry) — this doc references, never assigns, them.**
Feeds T-2 onward; S-23/S-24 are runnable **now** against PR-0c/PR-0d.

## 1. Layout

```
server/__tests__/security/authorization/
  _fixtures/authz.js          # builders — single source of test data
  _helpers/request.js         # credential-wrapping HTTP helpers
  conformance.matrix.test.js  # role×action matrix (T-2)
  idor.test.js                # S-1..S-4, S-23, S-24
  escalation.test.js          # S-5..S-9
  vector-leak.test.js         # S-10..S-17, S-21, S-22
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
- **Parallel workers share nothing**: this suite runs `--runInBand` (or one schema per worker) — concurrent workers on one DB would truncate each other's worlds mid-test.
- Builders use the **models/seeds from T-1** (permissions vocabulary, system roles) — the suite fails at import time if seeds are missing, which is itself a T-1 DoD check.
- Vector world uses LanceDB with a temp storage dir per test (env override), embedding via the existing offline/stub embedder used by current tests — no network.

## 3. Helpers (`_helpers/request.js`)

- `as(user|apiKey|embedConfig|deviceToken)` → supertest-wrapped agent attaching the right **credential only**. **Helpers never construct an `Actor` object** — that is the real resolver's job; a hand-built Actor would make every test a tautology that proves nothing about ingress-to-actor mapping.
- `assertDenial(res, {status})` — **404 (not 403)** for resource-scoped denies (S-1, S-18), 403 for action-scoped (per T-2 §2b table). Encodes the non-oracular contract as an assertion helper so no test re-decides it.
- `currentPolicyVersion()` / `bumpPolicyVersion(scopeKey)` — direct DB access for S-19/S-22 timing tests; never a sleep.
- `contextSentToLLM(chatResult)` — captures the context window (spy on the LLM connector) and assertions run **on the captured context before the model is invoked**. A chunk that entered context but the model happened not to mention is still a full leak — same reason S-10 asserts on provider rows, not the answer.

## 4. Dependency map — which task unlocks which tests

| Tests | Blocked by | Notes |
|---|---|---|
| S-23, S-24 | PR-0c / PR-0d | Runnable immediately: they assert route-level denial, no engine needed. Harness itself ships with PR-0c as its first consumer |
| S-4, S-5..S-9 | T-2 (engine + resolver) | conformance matrix + impersonation denies |
| S-1, S-2, S-3 | T-4a (bypass removal) | need engine from T-2 but assert on routes |
| S-20 | T-7 (privacy posture) | chat.read_others |
| S-10..S-17 | T-5 (LanceDB + metadata backfill) | S-11/S-12 additionally need T-4b (embed/API actor) |
| S-21 | T-1 + T-5 | context-injection across all 9 paths (recon §5c checklist) — needs `document_acl` to exist (T-1) before an inaccessible doc can be created; subtests S-21.1..S-21.9, one per path |
| S-22 | T-3 + T-5 | revocation invalidation + citation rehydration — needs grants to revoke |
| T-6 providers | T-6 | vector-leak file parameterized over provider registry — same S-10 assertions, provider = test arg; unsupported provider asserts boot-refuse instead |

## 5. Regression discipline

- Every test lands **RED first**: PR that adds the test includes a revert commit demonstrating failure (P0-3 rule), CI job keeps the revert-proof artifact.
- No `skip` without an open issue number in the skip reason; a grep in CI (`it.skip` without `#issue`) fails the suite meta-check.
- Matrix conformance (role×action) is generated from the seeded `role_permissions` table — adding a permission without a matrix row fails conformance, so vocabulary growth (T-7 admin duties) cannot silently skip coverage.
- S-10 runs on every CI job once T-5 lands; it is the Phase 0 gate test and may never be quarantined.
- New cases are added to the recon §4 registry first, then referenced here — never the reverse.

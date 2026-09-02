# QA-1 evidence — #40 task 1 @ `e875cd1`

**Verdict: PASS with NIT-1** (asymmetric mutation coverage — org spoof is unconstrained)

Worktree `/tmp/qa1-40` (detached, QA-owned). Probes `/tmp/p40/`. Node 22. §7.14 — probe +
mutation on related files only.

Prior SHA `3d29de9` was withdrawn on my B5-a / B5-b findings. Both are closed here.

## 1. B5-a closed — identity by reference, not by name

`resourceResolvers.js:16-24` registers each resolver in a `WeakSet` held on a
`Symbol.for()` global, and the three classifiers test membership. Every spoof I could
construct is now rejected:

| hostile input | scope |
|---|---|
| throws, no name | `null` |
| anonymous arrow | `null` |
| `resolverName: "totallyMadeUp"` | `null` |
| **`resolverName: "orgResource"`** (throws) | `null` |
| **`resolverName: "workspaceBySlug"`** (throws) | `null` |
| **function literally named `orgResource`** | `null` |
| **function literally named `grantScopeFromBody`** | `null` |
| **wrapper delegating to the real `orgResource`** | `null` |
| **`orgResource.bind(null)`** | `null` |

Genuine resolvers still classify: `orgResource` → `org`, `workspaceBySlug` → `workspace`,
`grantScopeFromBody` → `dynamic`.

The last two rows are the ones a name-based check cannot catch and a reference check does:
a delegating wrapper and a bound copy are different function objects, so neither is in the
WeakSet.

## 2. B5-b closed — `dynamic` bucket, `UNCLASSIFIED = 0`

```
registrations=32  routes=305  gates=171
skipped=["agentWebsocket: app.ws is not a function"]
BUCKETS={"org":118,"workspace":51,"dynamic":2}
UNCLASSIFIED=0
DYNAMIC gates: role.grant, role.revoke
```

The two `grantScopeFromBody` gates now land in `dynamic` instead of falling out of both
buckets. Confirmed `dynamic` is **not evidence**: a gate whose only resolver is
`grantScopeFromBody` answers `false` for both `hasGateAtScope(…, "org")` and
`hasGateAtScope(…, "workspace")`.

## 3. What already held, re-measured rather than inherited

- `skipped` contains only `agentWebsocket` (FINDING-2 closed)
- DUAL: `document.create` org=8 workspace=5 dynamic=0; `document.delete` org=2 workspace=2
  dynamic=0 — both actions carry both scopes
- route count rose 242 → 305, and the suite now pins `/v1` coverage explicitly
  (≥60 `/v1/` routes, `/v1/openai/chat/completions` present) rather than trusting `> 100`

## 4. `jest.resetModules` — classification survives

Verified independently by clearing `require.cache` and re-requiring:

- fresh module yields a **different** function object (`org1 !== org2` → true)
- the new object classifies under both the new and the old classifier — the registry is on
  a `Symbol.for()` global, so it is one registry across realms
- the old object still classifies (WeakSet retains it while referenced)
- a spoof constructed after the reset is still rejected

## 5. Mutation

Baseline 19/19.

| # | mutation | result |
|---|---|---|
| M1 | `isOrgResolver` → string comparison | **0 failed — SURVIVES** |
| M2 | `dynamic` classified as `org` | **1 failed** |
| M3 | `grantScopeFromBody` not registered | **2 failed** |
| M4 | `isWorkspaceResolver` → string comparison | **3 failed** |

## NIT-1 (non-blocking) — the org half of B5-a is not constrained by any test

M1 replaces the org identity check with the exact string comparison this SHA was cut to
remove, and the suite stays green at 19/19.

Under M1 the hole is real, not theoretical — measured directly:

```
spoof resolverName="orgResource"  -> isOrgResolver = true
function literally named orgResource -> isOrgResolver = true
```

The cause is the shape of the spoof test at
`workspaceCapabilities.test.js:149-170`. It asserts only that unknown resolvers are not
**workspace** evidence:

```js
expect(hasGateAtScope([gate], "workspace.members.manage", "workspace")).toBe(false);
```

Every case in that list is checked against the workspace scope, including the two that
impersonate `orgResource`. Nothing asserts that a resolver *claiming to be* `orgResource`
fails to produce **org** evidence — so the org classifier can regress to name matching
silently. M4 shows the workspace side is genuinely constrained (3 tests red); the asymmetry
is the finding.

The production code is correct at this SHA. What is missing is a test that would notice if
it stopped being. The smallest fix mirrors the existing loop against an org capability:

```js
for (const resolveResource of unknownResolvers) {
  const gate = { action: <an ORG_CAPABILITIES action>, resolveResource };
  expect(hasGateAtScope([gate], <that action>, "org")).toBe(false);
}
```

Not a blocker: no behaviour is wrong today, and the WeakSet is in place.

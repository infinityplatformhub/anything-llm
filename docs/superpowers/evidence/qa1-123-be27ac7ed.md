# QA-1 — #123 assignableRoles on /system/my-capabilities — `be27ac7ed`

Verdict: **PASS** — no findings.

Tree: `/tmp/qa1-123` detached @ `be27ac7ed`, own `node_modules`, `prisma generate` run.
DB `qa1_123` @ `postgresql://approof:approof@localhost:5434`, 2 migrations deployed.
`assignableRolesHttp.test.js` baseline **18/18**. Neighbouring capability suites (`workspaceScopedCapabilities`, `myCapabilities`, `uiBypassStillRefused`) **38/38** — the #40 t2 existence oracle is untouched.

## Mutations — seven, each red on a distinct set

| # | mutation | result | red set |
|---|---|---|---|
| M-A | `actor.type !== "user"` alone (the pre-fix guard) | 16/18 | RF-4 single-user, RF-4 core-jobs |
| M-B | delete the guard entirely | 17/18 | RF-4 scoped-api-key |
| M-C | delete the `canManageUsers` gate | 13/18 | RF-1 ×2, RF-5, RF-6 ×2 |
| M-D | role-string hierarchy instead of the permission-set helper | 16/18 | RF-1 delegated-admin, RF-2 write-path agreement |
| M-E | ignore the helper, return all three roles | 16/18 | same two as M-D |
| M-F | add `user.manage` to `READ_ACTIONS` | 16/18 | RF-5 ×2 |
| M-G | route hardcodes `canManageUsers: true` | 13/18 | RF-1 ×2, RF-5, RF-6 ×2 |
| M-H | over-correct: exempt every `type: "service"` | 17/18 | RF-4 scoped-api-key |

M-A and M-B are the two halves of the exempt-set fix and they go red on **opposite** tests: narrowing to a bare type check loses the single-user and core-jobs principals, widening to no check at all lets a scoped key through. Neither test alone proves the fix; together they pin it from both sides. M-H confirms the over-correction TL-1 warned about is caught by the same scoped-key test.

M-D and M-E share a red set, which is correct rather than a gap: both are "stop asking `canAssignLegacyRole`", and RF-2 is the test that exists to catch exactly that class by comparing against `validRoleSelection` — the helper the write path calls — rather than against a table restated in the test.

M-C and M-G also share a set. That is the intended shape: M-G is M-C moved to the call site, and the property being pinned ("the offered list cannot disagree with `user.manage` in the same response") is one property with one witness set, RF-6.

## Fixtures verified, not taken on report

- **delegated admin is real.** `IDS.delegated` is a `default` legacy user holding the seeded `setup_admin` grant — the only org role carrying `user.manage` without `super_admin`. Confirmed in the seeding block: `syncLegacyRoleGrant` for the legacy role, then `grantRole` with the `setup_admin` role id. So `["default","manager"]` with no `"admin"` is a permission-set answer, and a `users.role` read would answer for the wrong actor entirely — which is what M-D demonstrates.
- **the api-key HTTP test is not vacuous.** The key row's `createdBy` is `IDS.admin`, so the creator would otherwise be offered all three; the test also asserts `capabilities["user.manage"] === true` in the same body, so the empty list cannot be explained by the caller lacking the permission.
- **the scoped-key test gives the key its own `super_admin` grant row** for the duration, and removes it in a `finally`. Without that grant the set comparison returns nothing anyway and the test would pass under any guard — the test says so in its own comment and it is true; I confirmed M-H is only caught because the grant is there.
- **RF-3's second test calls `assignableRolesFor` directly** with `canManageUsers: true` and a service actor, because no ingress produces that combination today. Its paired positive control (`type: "user"`, same shape, `not.toEqual([])`) is what makes it about the type rather than about everything being refused. Both halves needed; M-B kills it.
- **RF-5 asserts the mutation is really denied**, not just that the list is empty, so an empty list from over-caution is distinguishable from one that matches enforcement. M-F red on both halves.

## `isExemptPrincipal` export

`policyRepository.js` exports it rather than the endpoint re-deriving the rule. This is the right direction and matches the module's own S-9 comment about the opposite drift: `canAssignLegacyRole` already answers true for these principals, so a second copy of the exemption in the helper would let the affordance and the enforcement disagree. M-A is the measurement that the two must agree — a bare type check makes `assignableRolesFor` contradict the helper it delegates to.

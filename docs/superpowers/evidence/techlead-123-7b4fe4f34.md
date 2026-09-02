# Techlead-1 — #123 `7b4fe4f34` (auth): assignableRoles — **REJECT, one fix**

§7.14: no suite run. Probes are in-process `node -e` against the slice's own files in a
detached worktree (`git worktree add --detach /tmp/tl-123 7b4fe4f34`, `node_modules`
symlinked, Node 22).

Delta from the pre-read: way 1 implemented as ruled, N-1 and N-2 both honoured correctly.
`assignableRoles` is a sibling of `capabilities` (F4 respected). The `user.manage` boolean is
read out of `answer.capabilities` rather than re-authorized (`system.js:1875`), and no
impersonation branch was written — RF-5 is pinned on the READ_ACTIONS mutation exactly as
N-1 asked. RF-6's same-body invariant is there and parameterised over four fixtures.

One finding blocks.

---

## FINDING-1 — a single-user install gets `[]`, and RF-4 is green because it tests a different function

`assignableRoles.js:40`:

```js
if (!actor || actor.type !== "user") return [];
```

`SINGLE_USER_ACTOR` is `{type: "service", id: "single-user", orgId: 1}`
(`utils/authorization/principals.js:16-20`). So the type guard fires **before** the
`canManageUsers` gate and before `canAssignLegacyRole` is ever reached. Measured through the
helper itself:

```
assignableRolesFor({actor: SERVICE_PRINCIPALS.singleUser, canManageUsers: true}) -> []
assignableRolesFor({actor: SERVICE_PRINCIPALS.coreJobs,   canManageUsers: true}) -> []
```

`resolveActor` returns `{...SINGLE_USER_ACTOR}` in single-user mode
(`actorResolver.js:158-161`), and that migration seeds it a real org-scoped `super_admin`
grant (`prisma/migrations/20260902020000_t1_authz_schema/migration.sql:422`). So on a
single-user install the response carries `capabilities["user.manage"] === true` alongside
`assignableRoles: []` — the one combination RF-6 declares impossible, produced by the
principal RF-4 is named after.

**Why the suite is green.** RF-4 (`assignableRolesHttp.test.js:307-327`) does not call
`assignableRolesFor` at all. It calls `canAssignLegacyRole` directly with the single-user
principal and asserts `[true, true, true]`. That is a true statement about
`policyRepository`'s exempt branch (`:366`) and says nothing about the field this issue adds
— the type guard sits upstream of it. The test's own comment states the harm precisely
(*"narrowing there would leave the only operator unable to create their first users"*) and
then asserts a function that cannot exhibit it. A comment that lies, over a fixture green for
an unrelated reason.

This is the exact hole the pre-read named: *"guard on `type !== "user"` **and**
`!isExemptPrincipal(actor)`, or single-user regresses to `[]`."* The type guard landed
without the escape.

**Not live yet** — nothing consumes the field until #121 merges. That is what makes it worth
one commit now rather than a hotfix later: #121's `NewUserModal` is the consumer, and an
empty list there is an empty role dropdown on the install that has exactly one operator.

**Fix** (either is fine, the first is smaller):
```js
const { isExemptPrincipal } = require("../authorization/policyRepository");
if (!actor) return [];
if (actor.type !== "user" && !isExemptPrincipal(actor)) return [];
```
`isExemptPrincipal` is not currently exported from `policyRepository` — check before
assuming. The alternative is to let the exempt principals through to `canAssignLegacyRole`,
which already returns `true` for them at `:366`, and keep the type guard for everything else.

```
RF-4b : assignableRolesFor({actor: SERVICE_PRINCIPALS.singleUser, canManageUsers: true})
        -> ["admin","manager","default"]     (the helper, not canAssignLegacyRole)
        plus: core-jobs gets the same, and an api-key actor still gets []
mut   : the current `actor.type !== "user"` guard with no exempt escape
why   : RF-4 as written is green under the mutation (measured) because it never calls
        the changed function. RF-3's api-key control is green too — both principals are
        `service`, so only an exempt one distinguishes the guard that is wanted from
        the guard that shipped. The api-key assertion must stay in the same test, or
        the fix over-corrects into letting every service principal through.
```

## Confirmed correct (no action)

- **N-2 honoured.** `system.js:1875` passes `canManageUsers: answer.capabilities["user.manage"] === true` — the batch's own value, one decision per response. RF-6 pins it on the same body.
- **N-1 honoured.** No impersonation branch exists; RF-5's stated mutation is adding `user.manage` to `READ_ACTIONS`, and its sibling test asserts the premise (`engine.authorizeMany` denies the impersonated actor) rather than assuming it. That second test is what keeps the empty list from being over-cautious, and it is the right shape.
- **RF-3's honesty about its own weakness is correct and rare.** The ledger and the test both record that deleting the type guard leaves the suite green, and the test then drives `assignableRolesFor` directly with `{type:"service", canManageUsers:true}` — a combination no ingress builds — plus a `type:"user"` control proving the assertion is about the type. That is the right way to test a guard against a future ingress. FINDING-1 does not contradict this; it says the guard as written is one clause too wide.
- **F1 recorded, not fixed** — `manager`/`default` collapse via `ORG_ROLE_FOR_LEGACY`, with the reason at `assignableRoles.js:61-64` naming the mapping rather than the endpoint. As ruled.
- **F4 respected** — sibling of `capabilities`, with the reason (`#53` stands; a list is not an action). `ORG_CAPABILITIES` key-shape assertions are untouched.

## Residual to carry to #121

The ledger's *"legacy manager gets `[]` when #121 consumes"* is right and is the visible
behaviour change: a legacy `manager` holds no `user.manage`, so the field is empty and the
role dropdown disappears where a role-string hierarchy used to show one. That is the field
being honest — but #121 must render "you cannot assign roles" rather than an empty control,
or the manager sees a broken form instead of a refusal.

## Verdict

**REJECT** on FINDING-1. Everything else in the delta is what was ruled. Re-read on the next
SHA is one file plus one test.

# Techlead-1 — #40 task 2 pre-read (capabilities endpoint, before Dev2's SHA)

Contract: `#40` comment `#issuecomment-5507883184`. Read against `approof/main`:
`endpoints/system.js:85-128,1471-1516`, `models/workspace.js:304-333,422-442`,
`utils/authorization/{actorResolver,principals,engine}.js`,
`prisma/seeds/permissions.js`, `migration 20260902102000`,
`__tests__/security/authorization/myCapabilities.test.js`.

The contract is good — the three pinned items are the right three, and declaring the
non-user-actor and non-numeric cases **before** starting is what keeps them from being
discovered as bugs later. Five findings, two of which change what the SHA must contain.

## FINDING-1 (blocking) — contract item 1's stated mechanism is wrong, and the mutation it prescribes will not go red

The contract says: *"`authorizeMany` โยน `AuthorizationContractError` ทั้ง batch — org-scoped
action ที่ถามผิด scope ตัวเดียวจะล้ม org capabilities ทั้ง 8 ตัว"*, and prescribes the mutation
"merge the two batches into one `try` → must go red".

Measured: **no action in either list can throw that error.** `engine.evaluate` throws only
when `permission.scope` is `"org"` or `"workspace"` (`engine.js:150-160`), and the scope
column defaults to `'any'` for every row (`migration 20260902102000:30`). The only non-`any`
action in the tree is `org.member` (`ACTION_SCOPES = {"org.member": "org"}`,
`permissions.js:222`) — and `org.member` is **deliberately absent** from `ORG_CAPABILITIES`,
for the reason written at `system.js:99-102`.

So today, asking `workspace.create` (in `ORG_CAPABILITIES`) against a workspace resource does
not throw. It **silently answers**, and the answer is wrong in the dangerous direction: an
org-wide grant with `workspace_id NULL` matches every workspace, which is the
migration-044000 vulnerability the `org.member` comment names.

Consequences for the SHA:

- The prescribed mutation (merge the two `try` blocks) **passes**, because nothing throws.
  A contract item whose mutation cannot go red is an assertion that proves its own formula —
  the #78 shape, and the one this program keeps finding.
- The real risk is not a thrown error killing the org half. It is a **workspace-scoped
  question being answered by an org-wide grant**. That is worth an assertion of its own:
  a user holding an org-wide grant for a `WORKSPACE_CAPABILITIES` action must not have it
  reported `true` for a workspace they are not a member of — and since the lookup returns
  `workspace: null` for a non-member, that is already the behaviour; the test should pin
  that it is the *lookup* preventing it, not the engine.

**What I would ask for instead**, keeping the contract's intent (the org half survives a
failing workspace half) but with a mechanism that exists:

- Mutation A: make the workspace lookup throw (`Workspace.getWithUser` stubbed to reject).
  Assert the org half still returns all 7 keys with correct values and `workspace: null`.
  That fails against a single-`try` implementation and passes against two — the property the
  contract wants, driven by a failure that can actually happen (a DB blip is the realistic
  one, not a scope error).
- Mutation B: put an `ORG_CAPABILITIES` action into the workspace batch. Assert it is
  **absent** from `workspace.capabilities`. Today nothing stops this and the result would be
  a `true` derived from an org-wide grant.

## FINDING-2 (blocking) — `Workspace.getWithUser(null, …)` does not fail closed, it fails OPEN

The contract's declared handling for `service`/`embed` actors is `workspace: null`, fail
closed. Correct. But the implementation must not reach `getWithUser` at all, and it is one
missing guard away from doing so.

`getWithUser` builds `workspace_users: { some: { user_id: user?.id } }`
(`models/workspace.js:308-312`). Probed the clause shape:

```
user = null        -> {"workspace_users":{"some":{}}}
user = {id: 5}     -> {"workspace_users":{"some":{"user_id":5}}}
```

`some: {}` in Prisma means **"has at least one member"** — it matches every workspace with
any member at all. So `getWithUser(null, {id: 7})` returns workspace 7 to a caller with no
user, and the endpoint would report that caller's capabilities against a workspace it has no
relationship to. `Workspace.get` is not a safe fallback either; it filters nothing.

This is not hypothetical drift: every existing caller guards it with a ternary
(`multiUserMode(response) ? getWithUser(user, …) : Workspace.get(…)` —
`browserExtension.js:92`, `mobile/utils/index.js` ×5, `utils.js:55`), so the model itself has
never had to be safe on a null user.

**Require of the SHA:** the guard is on `actor.type !== "user"` → `workspace: null` **before**
any lookup, and there is a test with a `service` actor asserting `workspace: null` for a
workspace id that **exists and has members** — not for an absent id, which would pass
against the broken version too. The single-user deployment makes this reachable in the most
ordinary way: `SINGLE_USER_ACTOR` is `{type: "service", id: "single-user"}`
(`principals.js:16-20`), so on a single-user install *every* request takes the non-user path.

## FINDING-3 — byte-identical needs a raw-body compare; `content-length` will not catch the case it is there for

The contract asks for raw body **and** `content-length`. Right instinct. Measured: the
failure mode it guards against — key order — produces **identical** lengths:

```
{"capabilities":{"a":true},"workspace":null}   len 44
{"workspace":null,"capabilities":{"a":true}}   len 44
toEqual: passes.  byte compare: DIFFERENT.
```

So `content-length` equality is necessary but proves nothing on its own, and a test that
checks only it would read as stronger than it is. The assertion that does the work is
`expect(await absent.text()).toBe(await foreign.text())` on the raw strings. Worth one line
of comment saying which of the two is load-bearing, or a later reader will keep the weaker
one and drop the stronger.

**And one gap in the pairing:** the contract declares the non-numeric `workspaceId` case
answers `null` **without querying**. That makes three paths, and only two are compared:

| input | queries | response |
|---|---|---|
| absent id | 1 | `workspace: null` |
| foreign id | 1 | `workspace: null` |
| non-numeric | **0** | `workspace: null` |

The bodies match, which is what the contract asks. But `?workspaceId=abc` is measurably
faster than `?workspaceId=999999`, so a caller can still distinguish "the server looked" from
"the server did not" — and since a numeric absent id and a numeric foreign id both query,
that distinction leaks nothing about existence. I do **not** think this needs fixing; I think
it needs to be in the residual as a stated non-goal, because a later reader comparing the
three paths will otherwise find it and read it as an oversight.

## FINDING-4 — view-as-user works by construction; the test must be able to tell

`resolveActor` builds the impersonated actor with **the target's** id
(`actorResolver.js:138-144`), so `getWithUser(target, …)` and the capability batch both
resolve to the target automatically. That is the desired answer and needs no code.

But an implementation that reached for `response.locals.user` (the admin, on some paths) or
for `impersonatedBy` would silently report the **admin's** capabilities for the **admin's**
workspaces, and every fixture where both are members of the same workspace with the same
role would still pass. **Require:** admin and target in *different* workspaces with
*different* roles, asserting the target's answer and that the admin's workspace comes back
`workspace: null`.

Second required fixture: the impersonated actor's `WORKSPACE_CAPABILITIES` must include the
**write-shaped** ones (`workspace.write`, `document.create`, `chat.send`) reported as
**false**, because `engine.authorize` returns `impersonated_mutation_denied` before any
policy lookup for anything not in `READ_ACTIONS` (`engine.js:72-74`). Of the seven workspace
capabilities, only `workspace.read` is in `READ_ACTIONS`. So a view-as-user session sees a
workspace whose capability map is almost entirely false — that is correct, it is what
read-only means, but it is surprising enough that without a test pinning it, someone will
later "fix" it.

## FINDING-5 — the API-key ceiling does not leak through this endpoint, and the reason is worth pinning

The concern is right to raise. Traced it: for an `api-key` actor `resolveActor` returns
`{type: "service", id: "api-key:<n>", grantPrincipal: {type: "user", id: creator}}`
(`actorResolver.js:110-123`), and `engine.evaluate` resolves grants against `grantPrincipal`
(`engine.js:129-131`). So the org half of this endpoint already reports **the creator's**
capabilities to any holder of the key — the key's own scope list is enforced at ingress, not
here.

That is pre-existing and correct-by-design (the endpoint gates affordances, and the route
each affordance leads to re-decides with the scope intersection). It is not made worse by
task 2, because `actor.type !== "user"` sends the workspace half to `null` — provided
FINDING-2's guard is on `actor.type`, not on `actor.grantPrincipal`. **Guarding on
`grantPrincipal` would be the bug**: it is `{type:"user"}` for every key with a live creator,
so the guard would pass and `getWithUser(creator, …)` would report the *creator's* workspace
membership to the key holder. One line either way. Worth a test: an `api-key` actor whose
creator is a member of workspace W asks for W and gets `workspace: null`.

## Two smaller notes

- **`{id, all-false}` only for members** is stated as a rule but nothing enforces it
  structurally — it is a consequence of `getWithUser` returning null for non-members. If the
  lookup is ever widened, the rule breaks silently. One assertion that a non-member with an
  org-wide grant still gets `workspace: null` pins the consequence rather than the rule.
- **The existing 6 tests must stay untouched** — agreed, and `myCapabilities.test.js`
  currently has 3 `test()` in the first describe plus more in the second; whatever N is, the
  contract's "6 tests green without being edited" is the right gate. Note the file builds its
  app with `systemEndpoints(app)` directly and calls `fetch` with no auth header, so adding a
  `?workspaceId=` case there would need an actor — the new file is the right home for it,
  which is what the contract already says.

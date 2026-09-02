# Techlead review — #53 `8dc44a20` (`org.member` and the permission-scope column)

**Verdict: PASS.** The design was already right at pre-review; this SHA closes the rebase
blocker and all three items I raised, and two of the three came back stronger than asked. One
nit, no findings.

## The rebase blocker — closed, and verified by execution

I measured both sides rather than reading the diff:

```
branch (pre-rebase)  ALL_ACTIONS = 63   sso.issue: true
main   ba486811      ALL_ACTIONS = 61
this SHA 8dc44a20    ALL_ACTIONS = 62   sso.issue: false   org.member: true
```

62 is the correct number (61 + `org.member`), `sso.issue` is gone from `API_ACTIONS`,
`ALL_ACTIONS` and `setup_admin`, and `vocabulary-diff.test.js` asserts 62 with `org.member`
added to `approved`. `ba486811` is an ancestor. The two-issue collision in
`seeds/permissions.js` resolved correctly — `setup_admin` now reads
`settings.write, user.manage, key.manage, workspace.read, access.diagnose, role.grant,
role.revoke, org.member`, which is #50's removal and #53's addition both applied.

## The design (confirmed at pre-review, re-checked here)

**Migration 102000** — `DEFAULT 'any'` keeps every existing action answering exactly as it
does today, so only rows that name themselves opt in. `CHECK` over three values rather than
an enum, with the right reason: a typo in a later seed must fail at write time instead of
becoming a scope the engine does not recognise and therefore does not enforce.
`ON CONFLICT ("action") DO UPDATE SET scope = 'org'` makes it idempotent even when a fresh
database got the row from the seed file first.

Step 4 remains the best thing in the migration: a `DO $$ ... RAISE EXCEPTION` that refuses to
complete if org `member` carries anything beyond `chat.send` and `org.member`. A migration
that **proves** it did not do the dangerous thing, rather than merely not doing it — correct,
because the failure it guards is silent and reintroduces 044000.

**The scope check's placement** is right and, more importantly, is pinned as a property
rather than as a shape. It sits in `evaluate()` after `findUnique` and before
`grantPrincipalOf`, and two tests hold it there:

- `R5 is not overtaken by the scope check` — an impersonated actor asking a wrongly-scoped
  mutation still gets `impersonated_mutation_denied`, so the blanket guards in `authorize()`
  (which touch no database) keep running first;
- `the throw does not depend on the actor holding the action` — a stranger with no grants at
  all gets the contract error rather than `no_grants`, which is only true if the check runs
  before the grant read.

**Throw, not deny** — correct. A wrongly-scoped question is a wiring bug in the route, not a
decision about the actor, and a silent deny would let a miswired gate read as an ordinary
refusal and survive review. `requirePermission` maps it to 500, which the new test pins
against 503: 503 means "retry, the store is down", and a miswired gate would then retry
forever.

**The four gates and `:798`** — all four converted sites pair `org.member` with `orgResource`.
`:798` correctly keeps `chat.send`: its resolver is `chatByIdParam("id")`, which returns a
workspace-bearing resource, and the handler filters by `user_id` on top — a mutation on a chat
the caller owns, not a membership question. `chat.js:33,133` (stream-chat) likewise.

**The sweep is behavioural for a reason I would not have anticipated**: it resolves the
resolver and checks `workspaceId != null` rather than comparing identity against
`orgResource`, because another suite in the run calls `jest.resetModules()` and
`resourceResolvers` can be a second module instance — identity comparison would flag
correctly-wired routes. It carries `expect(checked).toBeGreaterThanOrEqual(4)` against a
vacuous pass. The companion `chat.send` test reads paths from the **mounted router** and
records that the recon named `POST /workspace/:slug/chat`, which does not exist — a
grep-built expectation would have asserted routes that are not there.

## The three pre-review items

### (1) `ORG_CAPABILITIES` — answered, and the answer is better than the question

I asked for a line saying why `org.member` was left out. What landed is the reason *plus* a
consequence I had not connected: `authorizeMany` re-throws a contract error for the **whole
batch**, not per resource, so a single org-scoped action in that list would take every other
capability down with it — `/system/my-capabilities` would 500 instead of answering.

That merges my items (1) and (2) into one fact, which is the correct reading: the reason not
to add it is not only "everyone holds it, so there is nothing to gate", it is also "adding it
would break the endpoint".

And it is **asserted, not just commented**: `ORG_CAPABILITIES holds no org-scoped action`
parses the list out of `system.js` and checks it against `ACTION_SCOPES`, with
`expect(listed.length).toBeGreaterThan(0)` as the anti-vacuous guard. A source-scanning test
fails open by default; that guard is what makes it real.

### (2) `authorizeMany` batch propagation — covered by the above

The behaviour is now documented at the call site and enforced by the sweep. Nothing else in
the tree calls `authorizeMany` with a mixed-scope action list.

### (3) `explainAccess` — the answer corrects my premise

I asked whether its route maps a contract error to 500 rather than 503. The answer is that
the question does not arise: `explainAccess` reads `document_acl` directly and **never calls
the engine**, so no contract error can originate there. A caller passing an org-scoped action
gets an empty ACL result.

I verified that independently — `grep authorize` in that module returns only comments and the
`action` parameter. My pre-review note treated it as a third surface where the error could
surface; it is not one. The comment now records that, which is worth more than the change I
asked for.

### NIT (from pre-review) — closed, and it is the strongest of the three

`NIT: the JS scope map and the database agree` compares `ACTION_SCOPES` against
`SELECT action, scope FROM permissions WHERE scope <> 'any'` with `toEqual`, plus
`Object.keys(fromDb).length > 0` because an empty map on both sides would satisfy the
equality.

This is the test that prevents the drift I was worried about: `ACTION_SCOPES` drives the seed
file and the sweep, the column drives the engine, and without this the two could disagree —
the engine enforcing a scope no author declared, or ignoring one they did. Two sources of one
fact, now joined.

## Also verified

- `engine.test.js`'s all-actions loop now asks each action at the scope it declares, with
  `expect(permissions.some(p => p.scope === "org")).toBe(true)` so the test cannot pass on a
  vocabulary where the column is inert. Without that change the loop would have been asserting
  that the engine *ignores* the new column.
- `BASELINE_GRANTABLE` gains `org.member` with the right criterion stated: granting something
  every principal already holds confers nothing.
- `requirePermission` exposes `.action` and `.resolveResource` on the returned middleware,
  matching `validApiKey.scope`'s precedent, so the sweep reads the mounted router rather than
  grepping source.
- Workspace-scoped roles deliberately do **not** get `org.member` — they are granted per
  workspace, so an org-only action reached through them would be unaskable by construction.
  Asserted by `all four org roles hold it; workspace roles do not`.
- `policy_versions` bump present; the vocabulary changed, so cached decisions must not be
  trusted across it.

## NIT-1 (low) — the two source-scanning tests are brittle by construction

`ORG_CAPABILITIES holds no org-scoped action` splits on the literal
`const ORG_CAPABILITIES = [`, and the 500-vs-503 test splits on
`error instanceof AuthorizationContractError`. Both throw a `TypeError` on `undefined` if
either string is reformatted — by prettier, or by someone renaming the constant.

That fails closed, which is the right direction, but the failure will read as "the test is
broken" rather than "the thing it guards moved". One line each — `expect(source).toContain(...)`
before the split — would turn a confusing crash into a message naming what disappeared.
Cosmetic; both tests are worth having as they are.

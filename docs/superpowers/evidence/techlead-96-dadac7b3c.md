# Techlead-1 — #96 `dadac7b3c` (group grants in the engine)

Reviewed against my pre-read (`techlead-96-preread.md`). Probes are in-process `node -e` in
detached worktree `/tmp/tl1-96` against the real helper with injected db doubles; no suite run
(§7.14).

**Verdict: PASS.** All four items PMO asked me to check hold under probe. One NIT, one
observation, neither blocking.

## (1) The memo does not leak across requests or actors — verified, four ways

`groupIdsFor`'s memo is created in `authorizeMany` (`engine.js:129`) and dropped when the call
returns; nothing module-level holds it. Beyond reading that, I drove the real helper:

```
one memo, two users:   user1 ["10"]  user2 ["20"]  user1 again ["10"]   queries: 2
one memo, two orgs:    org1  ["10"]  org2  ["10"]                        queries: 2
```

The key is `${orgId}:${userId}`, so a second user in the same batch gets its own entry and a
second org does not reuse the first's. Two of the four failure modes worth having: a shared
memo returning user 1's groups for user 2 would be a straightforward privilege leak, and an
org-blind key would carry membership across the tenant boundary the org filter exists to
enforce.

`authorize` accepts `memo = null` and defaults to no memo, so a single `authorize` call
issues its own query and caches nothing. That is the right default — the memo is an
optimisation the batch opts into, not a cache the system relies on.

## (2) The ALLOW half's group grants keep their scope

`readableScope` now builds `principalPairs` the same way the engine does and ORs them into
the grant query (`documentFilter.js:174-183`). The scope logic **after** the query is
unchanged, and that is what makes it correct: `orgWide` is derived per **grant row**
(`scoped.some((g) => g.workspace_id === null)`), and each row carries its own `workspace_id`
whether it was written against a user or a group. So a group grant scoped to workspace 5
contributes workspace 5 and nothing else; only a group grant with `workspace_id NULL` sets
`orgWide`, exactly as a user's own org-wide grant does.

That is the part I was most concerned about in the pre-read — an org-wide group grant reading
as "every workspace" is the migration-044000 shape — and the answer is that group grants
inherit the existing per-row scope handling rather than bypassing it. The test at `:617`
("workspace-scoped group grant reaches the member, and does not leak to other workspaces")
pins it.

Fixing the ALLOW half **with** the engine rather than after it is the right call, and the
comment gives the reason plainly: engine-only would have let `authorize()` permit a read the
filter then answered with nothing, which reads to a user as an empty workspace rather than a
refusal. That is a worse failure than the one being fixed.

## (3) A failed query removes its entry and does not poison the batch

Probed both the sequential and the concurrent shape:

```
sequential:  call1 THREW "db down"   memo size after failure: 0
             call2 ["7"]             queries: 2          (retried, succeeded)

concurrent:  3 callers, statuses rejected,rejected,rejected
             queries: 1              memo size: 0
```

Sequential: the rejection is not cached; the next caller retries. Concurrent: all three
callers share the one in-flight promise and **all three reject** — which is the fail-closed
answer. The rejection propagates out of `evaluate` into `authorize`'s catch, which wraps it
as `AuthorizationUnavailableError`, so the whole batch fails closed rather than half of it
silently returning "no groups". Storing the promise before the await (`:69`) is what makes
the 100-decision batch issue one query; deleting on rejection (`:70`) is what stops the
failure being remembered. Both are load-bearing and both are commented.

## (4) Residuals — all three present and correctly framed

`ledger-96.md:74-90` carries the three I raised: the `group_members` policy-version gap
(assigned to S4a, the first issue that writes membership), the new key-minting authority via
the ceiling, and the deploy-time behaviour change with the rollout-counting SQL. The second
is stated as *new authority on the day this merges, not a pre-existing state*, which is the
honest framing — it is the sentence a later reader needs.

## The helper's placement, and my pre-read ruling

I proposed `principals.js`. Dev3 declined, and correctly: that file exists **because** it
requires nothing (hotfix #39's cycle), and this helper takes a db handle. Its own file with
no imports is the right answer, and the header records the reason. This is the second time
this program has caught a suggestion of mine that would have re-created a solved problem;
the reasoning is better than mine was.

The "no third expansion" ruling is satisfied the way I asked — the inline copy in
`documentFilter` is **deleted**, not wrapped, and both halves plus the engine call one
function. The deny half's old bug (keyed on `actor.id`, so an api-key never matched a
membership, and unfiltered by org) is fixed as a side effect, which is what converging them
was for.

## NIT-1 — the api-key rule is written three times and the two files disagree in wording

The engine refuses expansion for an api-key actor (`engine.js:195-203`); `readableScope`
**does** expand — but only because it passes `grantPrincipal` through, and its comment says
"unlike in the engine". Reading the two side by side, the actual behaviour is:

| path | api-key expansion |
|---|---|
| `engine.evaluate` | **no** — explicit `"grantPrincipal" in actor` branch |
| `readableScope` (ALLOW) | **no** — same explicit branch, `documentFilter.js:176-182` |
| deny half | **yes** — `groupIdsFor(denyPrincipal, …)` where `denyPrincipal` is the creator |

So the ALLOW comment at `:171-173` ("an api-key actor is expanded here, unlike in the
engine") describes the **deny** half, not the code it sits above — that code takes the same
non-expanding branch the engine does. The asymmetry itself is right (a deny should reach as
widely as possible; an allow should not), but the comment as placed will mislead someone
comparing the two. One sentence moved.

Worth stating the invariant somewhere central: **group expansion widens denies for a key but
never widens allows.** That is the rule; today it is three comments that a reader has to
assemble.

## OBS-1 — the batch test counts queries through real middleware

`:918` registers a Prisma `$use` middleware and counts `group_members` queries for a
100-resource batch, asserting exactly 1. Counting issued queries rather than asserting on the
shape of the code is the right level, and the flag-gated counter (middleware cannot be
unregistered) is handled rather than left leaking into later suites. No comment beyond noting
it, because this is the assertion that would have caught the naive implementation I warned
about in the pre-read — `authorizeMany` calling `authorize` per resource, multiplying the new
query by up to 500.

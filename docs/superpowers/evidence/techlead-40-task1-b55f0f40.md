# Techlead — #40 task 1, `b55f0f40` (+ uncommitted working tree)

Reviewed: `.claude/worktrees/f40` at `b55f0f40`, plus the uncommitted modifications to
`resourceResolvers.js`, `workspaceCapabilities.test.js` and the plan doc — which is where the fixes to
my pre-review live. Reviewed as one unit since PMO asked whether this shape is acceptable before the
SHA is cut.

**Answer: yes, acceptable — with one condition that must be met before this can be trusted in CI.**
All four of my pre-review points are addressed, two of them better than I proposed. One new blocker-class
finding, and it is in the harness rather than in the production change.

## The four fixes

**resolverName stamp — done, all four factories.** `workspaceByIdParam`, `chatByIdParam`,
`promptHistoryByIdParam`, `memoryByIdParam` now build a named `resolve` and stamp
`resolve.resolverName`. Executed: all ten resolvers now classify correctly through `scopeOf`, including
the four that previously came back as an anonymous closure.

**`ORG_CAPS` pinned — done.** The mockup comparison now loops over both `["ORG_CAPS", ORG_CAPABILITIES]`
and `["WS_CAPS", WORKSPACE_CAPABILITIES]`. NIT-1 closed.

**Mockup SHA moved from `.infi/task-40.env` to the plan doc** — better than what I reviewed, and for a
reason worth stating: `task-40.env` is the file `task.sh check` reads, and the infi-dev docs themselves
record that nothing pins it (an agent can edit it later to match what it wrote). The plan doc is the
approved artifact. Verified live: plan line 5 says `2a30aa217f4dee61f3bde67056ea0a720ca5f379`,
`git hash-object` on the mockup returns exactly that.

**`scopeOf` no longer classifies by `catch`** — this was bypass 4 and the fix is right. The old version
returned `"workspace"` from the catch block, so *any* resolver that threw was called workspace-scoped;
a broken org resolver would have been silently reclassified. It now falls through to a
`resolverName`/`name` allowlist of the two org resolvers (`orgResource`, `grantScopeFromBody`) and
treats everything else as workspace. I ran all ten: classification is correct in both paths.

## FINDING-1 — closed, and by the better of the two options I offered

PMO's question was whether assertion 6 closes it without an allowlist. It does not close it *without*
one — but the code does have one (`DUAL_SCOPE_WORKSPACE_ACTIONS`), and that is the option I said was
more work and more useful. It asserts the **positive**: `document.create` and `document.delete` must
each have at least one org-scope gate *and* at least one workspace-scope gate. So the org routes are
now documented facts that fail if removed, not unexamined ones.

Measured from the mounted router (`API_KEY_PEPPER` set, everything registers):

| capability | scopes actually seen |
|---|---|
| `workspace.read` | workspace ×4 |
| `workspace.write` | workspace ×4 |
| `workspace.delete` | workspace ×2 |
| `workspace.members.manage` | workspace ×2 |
| `document.create` | **org ×8**, workspace ×5 |
| `document.delete` | **org ×2**, workspace ×2 |
| `chat.send` | workspace ×3 |

The vacuity I raised is gone: a workspace capability whose gates were all org-scoped now fails the
`toContain("workspace")` loop, and the two dual-scope actions are pinned in both directions.

Note `document.create` has **8** org gates, not the 2 I found by grep (`extensions/index.js:19,43`).
The rest come from routes the source sweep did not reach — which is itself the argument for the router
sweep. Whether all eight are legitimately org-level is a question for task 2's endpoint work; the
comment names only extensions and system-document deletes as the justification, so the reasoning
currently covers a subset of what the assertion now locks in. Worth a sentence, not a blocker.

## FINDING-2 (blocker for CI trust, not for the change) — `buildRouter` swallows registration failures

`routeGateSweepHelper.js` catches every registration error into `skipped[]` and continues. Nothing
asserts `skipped` is empty. Executed both ways:

```
without API_KEY_PEPPER:  skipped=4  routes=158  gates=114
with    API_KEY_PEPPER:  skipped=1  routes=242  gates=171
```

The four skipped without the pepper are `systemEndpoints`, `adminEndpoints`,
`browserExtensionEndpoints` (all `API_KEY_PEPPER must be at least 32 bytes`) and `agentWebsocket`.
Consequences in that state:

- `mountedRoutes.length > 100` **still passes** — 158 > 100. The guard is calibrated below the failure.
- `workspace.members.manage` has **0** gates (both live in `admin.js`), so assertion 6's
  `expect(scopes).toContain("workspace")` fails on an empty array — a real failure, but the message
  will read "this capability has no gate" when the truth is "admin.js never loaded".
- `workspace.create` has **1** gate, so the `toHaveLength(2)` assertion fails too — again for the
  wrong stated reason.

So today the suite fails loudly in the wrong words rather than passing silently. That is the better of
the two failure modes, but it is one calibration change away from the worse one: if the `> 100` guard
were raised to a number the reduced set also clears, or if a future capability happened to live only in
files that do register, a half-built router would pass the sweep while three endpoint files were absent.

**This suite sets no environment of its own.** Unlike the 34 other suites under `server/__tests__` that
set `process.env.API_KEY_PEPPER` at the top of the file, this one relies on the ambient environment —
CI supplies it (`ci.yml:30`), `server/.env` does not. A developer running this file locally gets the
reduced router.

Two changes, both small:
1. `expect(skipped.filter((s) => !s.startsWith("agentWebsocket"))).toEqual([])` — the websocket skip is
   expected and documented; every other skip is the harness failing to build what it claims to sweep.
2. Set `process.env.API_KEY_PEPPER` at the top of the file like the other 34 suites, so the sweep is
   the same locally and in CI.

Also, `registrations` is matched with `/^[a-zA-Z]+\(apiRouter\);$/gm`. I checked `index.js`: all 31
mounts are on one line in that exact shape, so nothing is missed today — but a mount written across two
lines, or one with an extra argument, would vanish from the sweep with no signal. Asserting
`registrations.length` against a known count would pin it. NIT, given (1) above would catch the
common case.

## Everything else from the pre-review still holds

- Both capability lists non-empty; every capability in `ALL_ACTIONS`; neither list carries an action of
  the opposing `ACTION_SCOPES` scope (near-vacuous today — only `org.member` is scoped — but the right
  assertion to have standing).
- `workspace.create` in `ORG_CAPABILITIES` with the correct justification, and both mount points pinned
  by count.
- The mockup comparison sorts full arrays, so omissions, additions and duplicates are all caught while
  order — which means nothing to `authorizeMany` — is ignored.

The `permissionGates` AST scanner and its self-test are gone from the suite, replaced by the router
sweep. That is the right trade: the mounted router is the ground truth and a source scan was always a
proxy for it. Nothing is lost, because the scanner's purpose was to find gates and the router now
enumerates them directly.

## What I did not do
Did not run the suite (§7.14). The tables above come from executing `buildRouter` and `scopeOf`
directly against the real modules under node 22 — claim verification, not a test run.

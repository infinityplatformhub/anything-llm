# Techlead-1 — #40 task 4 `1ca353edc` (plain; pre-read is the only gate)

§7.14: no suite run. Probes are in-process `node -e` in a detached worktree
(`git worktree add --detach /tmp/tl-40t4 1ca353edc`). Delta read against `b6ed23711`.

## Both gate failures are fixed at the cause, not the symptom

**Drift sweep.** `callsUpdateSystemPreferences` now strips line comments before matching
(`managerAllowedFieldsDrift.test.js:50-56`). Ran the walker's exact logic over
`frontend/src`: 13 files contain the string, 11 survive stripping, and the two that drop out
are `MemoriesContext.jsx:30` and `memoriesCapabilityGate.test.jsx:9` — both comments, both
the +2 that reddened the gate. The docblock states what it does not handle (block comments,
strings) and argues the direction: a false positive fails loudly, a false negative does not.
That is the right way to ship a heuristic. PMO's ruling against an allowlist was correct —
an allowlist would have recorded something false.

**Note the test-file exclusion PMO's message mentions is not in the code, and does not need
to be.** The walker still visits `.test.jsx` files (`:125-142`, no path filter); comment
stripping alone is what removes the test file, because its only occurrence is a comment. A
test that *called* the API would still be listed — correctly, since it would be a caller. So
the fix is narrower and better than "skip tests"; the ledger should say that rather than
claiming a filter that isn't there.

**M4.** `Sidebar/index.jsx:166` is inside `SidebarMobileHeader`, not `Sidebar` — Dev2 found
their first test was green without touching the site, exported `NewWorkspaceButton`, and added
a `SidebarMobileHeader` describe (`capabilityGate.test.jsx:154-203`) whose three cases
separate `workspace.create` from `settings.write` in both directions plus single-user. That is
the right shape: two capabilities on one surface, each proven to move independently.

## FINDING-1 — the M3 source assertions match their own explanatory comments

`workspaceCapabilityGate.test.jsx:199` and `:318` both assert:

```js
expect(source).toMatch(/visible && can\("workspace\.write"\)/);
```

Measured: mutate `ToolsMenu/index.jsx:72` to drop `visible` **while leaving a comment naming
the intent** —

```
mutation applied: true
source assertion still passes: true
```

— because the regex is unanchored over the whole file and both files carry comments that
spell the expression (`ToolsMenu:67`, `WorkspaceModelPicker:108-115` mention `visible`
repeatedly). The assertion is one comment away from vacuous, and this repo has just spent a
gate cycle on exactly that class: the drift sweep reddened because `source.includes` did not
separate code from comments. The same defect, in the test written to close the same issue.

Not a tautology today — the string only appears in code right now, so it does hold. But it is
green for a reason unrelated to the property, and the cheapest way to break it is to write a
comment, which is a thing this codebase actively encourages.

**Fix — strip comments before matching, same as the drift test now does:**

```js
const code = source.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
expect(code).toMatch(/visible && can\("workspace\.write"\)/);
```

One line, and it reuses the rule the sibling test just adopted.

**On the assertion's legitimacy:** the reasoning for asserting at the source is correct and I
accept it. `visible` is `state.workspace !== null` and `can()` reads
`state.workspace?.capabilities?.[action]` (`useCapabilities.js:119-125`), so `visible === false`
forces `can() === false` — no fixture can separate them through the DOM, and the comment says
exactly that. Pinning a defence against a future hook where they diverge is the right call;
it just has to be pinned against code, not prose.

## FINDING-2 (nit) — `ToolsMenu`'s `canSeeAgentSkills` keeps a disjunct that now means something different

```js
const canSeeAgentSkills = !user?.hasOwnProperty("role") || canConfigureWorkspace;
```

`!user?.hasOwnProperty("role")` is true for `user === null` (single-user, intended) **and** for
a user object that simply lacks a `role` key. Under the old code that was harmless — the next
clause read `user.role`, so both spellings meant "no role". Now the second clause is a
capability, so a `role`-less user object short-circuits to visible without any capability
being asked. Whether such an object exists depends on `useUser`; I did not verify one does.
`!user ||` is the disjunct every other converted site uses (`NewWorkspaceButton:200`,
`WorkspaceModelPicker:121`), and consistency here is worth more than the extra tolerance.

## Confirmed

- `PrivateRoute` splits `AdminRoute` → `settings.write` and `ManagerRoute` → `user.manage`, with the comment naming why the role check collapsed them (`admin.js:81,120,164,215`). Correct — these were one spelling of "not default" and are two different server gates.
- `|| !multiUserMode` untouched on both routes: single-user keeps its own settings.
- The `capabilitiesLoading` residual is recorded in **both** places — `ledger-40.md:340` and in the code at both routes, including why no test guards it (reproducing the ordering means driving `useIsAuthenticated`'s internals, i.e. testing the mock). Honest and correctly placed. The redirect-vs-hidden-button distinction it gives is the right reason to keep an unreachable line.
- M6 (rejection not cached) tested with a second reader — the `capabilitiesPromise` fix from task 3 now has the test it was missing.
- The transcribe+drift residual for `Home`/`SettingsSidebar` is recorded with #126 named as the follow-up, per the (a) ruling.

## Verdict

**One fix: strip comments in the two M3 source assertions** (`:199`, `:318`). Everything else
in the delta is right, and the two gate failures are fixed at the cause. Given the tier, I
would not hold the merge for a re-read — the change is one line in a test file and it is the
same rule the drift sweep already adopted.

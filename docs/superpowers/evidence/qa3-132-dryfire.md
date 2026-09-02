# QA-3 — #132 dry-fire against Dev4's RED scratch

Copied the three scratch files out of `/tmp/wt-132red` into my own `/tmp/qa3-127`
@ `5c9ea893d` (read-only on his tree; nothing written there). Everything below was run.

## 1. RED today — what my probe would say

`SystemReadRoute` does not exist. Both suites fail, and the split is informative:

| suite | result | failing |
|---|---|---|
| `systemReadRoute.test.jsx` | 5 failed / 1 passed | R1, R3, single-user, both R6 |
| `mobileConnectionsRouteTable.test.jsx` | 3 failed / 1 passed | route-uses, no-longer-AdminRoute, export-missing |

**R2 passes in RED, correctly** — it asserts `AdminRoute` still admits the principal, which
is true today and is the control that makes R1 meaningful. Not a false pass.

The React error is `Element type is invalid … got: undefined`, i.e. the import of a
non-existent export, so the RED is "the guard is missing" and not an assertion artefact.

## 2. Dev4's alias-stub finding — confirmed

With `export const SystemReadRoute = AdminRoute;` added:

```
Tests  3 failed | 7 passed (10)
  × R1: a principal WITHOUT system.read is refused before the page renders
  × R4: the route uses SystemReadRoute
  × R4: and no longer uses AdminRoute or ManagerRoute
```

Exactly his prediction: **R1 plus the two route-table assertions**. Seven tests — including
both R6 `hideUserMenu` cases, R3, and single-user — pass against a guard that asks
`settings.write`. So R3/R6/single-user are shape tests, not capability tests; R1 is the only
behavioural assertion that distinguishes the guards, and it carries the suite. Worth stating
in the ledger so nobody later "simplifies" R1 away as redundant with R3.

## 3. P-bleed against the brace-matched R4

To fire these I had to build a reference `SystemReadRoute` (copied from `AdminRoute`, asking
`system.read`) and wire the route, since R4 cannot be probed while it is red for a missing
export. That reconstruction is mine, not Dev4's code.

| # | mutation | R4 |
|---|---|---|
| P1 | route de-guarded (`<MobileConnections />`) | **RED** ✅ |
| P2 | reverted to `AdminRoute` | **RED** ✅ |
| P3 | prettier / indentation reflow, route correct | **GREEN** ✅ (the #127 version dies here) |
| P4 | de-guarded + guard name planted **below** the block | **RED** ✅ |
| P5 | de-guarded + guard name in a **trailing `//` comment** inside the block | **RED** ✅ |
| P6 | route path renamed away | **RED** ✅ |
| P7 | whole route block deleted | **RED** ✅ |
| **P8** | **de-guarded + guard name in a `/* */` block comment inside the block** | **GREEN — SURVIVES** ❌ |
| P9 | a decoy route elsewhere holds the guard, target de-guarded | **RED** ✅ |

His seven all behave as documented. The brace matcher is a genuine improvement on #127's
delimiter — P3 green and P1/P2/P4/P5 red is the combination the old version could not reach.

### P8 is a real hole

`stripLineComments` removes `//` to end-of-line and nothing else. A `/* */` comment
containing `SystemReadRoute Component={MobileConnections}` survives the strip, sits inside
the brace-matched block, and satisfies both text assertions while the route renders
**unguarded**:

```jsx
/* SystemReadRoute Component={MobileConnections} */
return { element: <MobileConnections /> };
```
→ `Tests 4 passed (4)`.

This is the same gap I recorded as a residual on #126 slice 1 (`df7d54f72`), but the
direction is reversed and that changes its severity. There it produced a **false positive**
(fails closed — annoying, harmless). Here it produces a **false negative**: an unguarded
admin route, green. On a `plain` issue I would have logged it; on this one it is worth the
two-line fix.

**Fix**: strip block comments before line comments, e.g.
`source.replace(/\/\*[\s\S]*?\*\//g, "")` ahead of the existing `//` pass. Then re-fire P8;
it must go red, and P3/P5 must stay as they are.

## 4. Fixtures that pass for the wrong reason

- **R3, R6 ×2, single-user** — all four survive the alias stub, so none of them can tell
  `system.read` from `settings.write`. Correct as shape/wiring tests; the risk is only that
  they read as capability coverage. R1 is the one doing that work.
- **`systemReadCapabilityExposed.test.js`** asserts `system.read ∈ ORG_CAPABILITIES`. On
  `5c9ea893d` that is already true (#121 added it), so this test is **green before the
  change and after it** — it pins a dependency rather than proving anything about #132.
  Fine, provided the ledger says so; it is not evidence the guard works.
- **R2** is a control and should never be "fixed" if it fails — a red R2 means the guards
  converged and #132's premise is gone.

## 5. What I will fire on the GREEN SHA

The nine P-bleed variants above, the alias stub (must fail ≥3), R1-alone-removed (the suite
must lose its only capability assertion — checks that R1 is not duplicated elsewhere), plus
my standing #132 plan items: exact reachability per real role, single-capability fixtures
proving the guard was reached rather than a sibling, and the G3 inherited-line question
(`multiUserMode && capabilitiesLoading` — it survived on #127 and my reference impl copied
it; if Dev4's does too, it arrives untested and should be declared).

## Housekeeping

`/tmp/wt-132red` untouched (read-only copy out). My tree restored: scratch tests removed,
`main.jsx` and `PrivateRoute/index.jsx` reverted, `git status --porcelain` clean at
`5c9ea893d`. No commits.

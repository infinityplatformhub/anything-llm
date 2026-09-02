# QA-3 — #132 GREEN probe (Dev4's scratch, uncommitted)

Copied out of `/tmp/wt-132red` into `/tmp/qa3-127` @ `5c9ea893d`; nothing written to his
tree. Snapshots at `/tmp/qa3-132/{pr,main}.green2.jsx` for restore between mutants.

**Verdict: PASS**, with one coverage gap that is not a defect in the change (§5) and one
count discrepancy to reconcile (§1).

## 1. Baselines

| | result |
|---|---|
| `yarn test src/components/PrivateRoute` | **exit 0**, 4 files / **26 passed** ✅ matches Dev4 |
| `yarn test` (all frontend) | **exit 0**, 19 files / 135 passed, no unhandled rejections |
| `jest systemReadCapabilityExposed --runInBand` | **exit 0**, **3 passed** |

Dev4 reports server **7/7**; the new file holds **3**. Adding
`workspaceScopedCapabilities.test.js` gives 26 across 2 suites — neither is 7. Not a
discrepancy in the code, but the number in his report does not match any suite I can run;
worth him naming which files he counted before it goes in a ledger.

## 2. P-bleed — all nine, on the real change

| # | mutation | result |
|---|---|---|
| P1 | route de-guarded | **RED** (1 failed) |
| P2 | reverted to `AdminRoute` | **RED** (2) |
| P3 | prettier / indentation reflow, route correct | **GREEN** ✅ (correct — #127's version died here) |
| P4 | de-guarded + name planted below the block | **RED** (1) |
| P5 | de-guarded + name in a trailing `//` comment | **RED** (1) |
| P6 | route path renamed away | **RED** (3) |
| P7 | whole route block deleted | **RED** (3) |
| **P8** | **de-guarded + name in a `/* */` block comment** | **RED** (1) ✅ — **the dry-fire hole is closed** |
| P9 | decoy route elsewhere holds the guard | **RED** (1) |

P8 was the false negative I found on his scratch (unguarded admin route, green). The block-comment
strip plus the string-literal guard kill it. This is the one that mattered and it is fixed.

## 3. Alias stubs — both shapes

| # | mutation | result |
|---|---|---|
| ALIAS-EXPORT | `export const SystemReadRoute = AdminRoute` | **RED** — 1 failed (R1) |
| ALIAS-ACTION | `SystemReadRoute` passes `action="settings.write"` | **RED** — 1 failed (R1) |

PMO expected ≥3 red; I measure **1**, and the difference is the refactor, not a regression.
On the pre-refactor scratch the alias also failed the two route-table assertions, because
`SystemReadRoute` did not exist as a distinct symbol. Now it does — the route table is
correct in both stubs, so only the behavioural assertion fires. **R1 alone carries the
capability claim**, which makes §4 the important result.

## 4. remove-R1 — the suite's single point of failure, confirmed

Deleting R1 **and** swapping the guard to `settings.write`: **exit 0, 25 passed.**

So R1 is the only assertion in 26 that can tell `system.read` from `settings.write`. R2/R3,
both R6 cases, single-user and the whole route table survive a guard asking the wrong
capability. That is fine — they are controls and wiring tests — but it must be written down,
or a future "these two look redundant" tidy-up silently removes the issue's only proof.

**Fixture discrimination (mirror check).** `HOLDS_SYSTEM_READ` sets `settings.write: true`
as well, so R3 cannot distinguish either. I narrowed it to `system.read` only:

- narrowed fixture, correct guard → **6 passed** (no test depended on the extra grants);
- narrowed fixture + guard swapped to `settings.write` → **4 failed**, up from 1.

So narrowing that one fixture turns R3, R6 ×2 into real capability assertions at zero cost.
Recommended, not required: the current suite is correct, just concentrated.

## 5. M10 / G3 — the declared inherited-untested line

Deleting `if (multiUserMode && capabilitiesLoading) return <FullScreenLoader />;` from the
**shared body**: **exit 0, 26 passed** — survives, as declared.

The mark is where PMO asked: `INHERITED-UNTESTED (#127 G3)` at `index.jsx:103`, immediately
above the shared `CapabilityGatedRoute` copy at `:115`. Confirmed on the one shared body,
not duplicated beside a duplicated one — which is the stated reason for the refactor and it
holds.

**One thing the mark does not cover:** there are **two** such lines. `:115` is the shared,
marked one; `:192` is a second copy inside `ManagerRoute`, which the refactor did not absorb.
Deleting *that* one is also green (**26 passed**) and it carries no mark. Not a #132 defect —
`ManagerRoute` is out of this diff — but the ledger should say the mark covers one of two
copies, or the next reader will believe the gap is single and closed by RF-L alone.

## 6. Housekeeping

Every mutation restored from snapshot; my tree returned to Dev4's GREEN state exactly
(same 6 paths, same content). `/tmp/wt-132red` untouched. `qa3_121` read-only. No commits.

# Techlead-1 — #124 `ab11d35a8` (plain; pre-read is the only gate)

§7.14: no suite run. Probes are in-process in a detached worktree at `4646ed17b` (code
identical to the verdict target `ab11d35a8`, which adds the ledger only).

## The three questions

**Does the stability test observe at a point where the value can actually differ? YES, now.**
The test reads `aria-label` only after `waitFor(getByText(modelName))` in each render
(`workspaceModelPickerA11y.test.jsx:108-126`), so under `aria-label={modelName}` the two reads
are `"gpt-4o-mini"` and `"claude-sonnet-4"` and `expect(secondName).toBe(firstName)` fails.
Confirmed the matcher still *finds* the button under the mutant (each matcher alternation
includes that render's model name), so the mutation dies on the comparison rather than on a
lookup error — which is the failure you want, because a lookup error would also be red for a
component that simply did not render.

The earlier version failing is worth the ledger line it got: unmount/remount reset the
component and both reads landed in the fallback window before the async model name arrived, so
both names were the same string and the mutant survived. That is a fixture green for an
unrelated reason, found by mutation rather than review.

**Is the label meaningful to a screen reader? YES.** `aria-label={t("chat_window.select_model")}`
→ "Select Model" in `en/common.js:1590`. Verified the key is present in **all 29 locale
bundles** (`for d in */; do grep -q select_model ...` — zero missing), so the reuse claim holds
and no locale falls back to the raw key in production. The visible `<span>` still renders
`modelName || t(...)`, so sighted users keep the value and the accessible name describes the
control. That split is the right one.

**96/96 exit 0** — reported by Dev4; not independently run (§7.14). The exit-code check is the
lesson from #40 t4's gate and it is being applied.

## FINDING (nit, not blocking) — `id="workspace-model-picker-btn"` is referenced by nothing

Added alongside the label but no `aria-labelledby`, `aria-controls`, `for`, test, or CSS rule
uses it (grep across the repo: the only hit is this line itself). An unused id on an
accessibility fix reads as an unfinished second half — a reviewer six months from now will
assume something points at it. Either drop it or say in the ledger what it is for.

While there: the button opens a panel (`showSelector`) and carries no `aria-expanded`. The repo
already uses that attribute (`ChainOfThought/index.jsx:91`), so the pattern exists. A screen
reader currently hears a constant name with no indication the panel opened — the same class of
gap this issue is closing, one attribute along. Not in scope for #124's stated goal, but it
belongs in the residual next to `action.jsx:100` rather than going unrecorded.

## Residual confirmed

`PromptInput/LLMSelector/action.jsx:100` carries `aria-label="LLM Selector"` — hardcoded
English, on a `<div>` with no role, so the label may not even be announced. Correctly recorded
as out of scope. Worth noting in that residual that it is two defects (untranslated *and* on a
non-interactive element), because a follow-up that only wraps it in `t()` would leave the
second.

## Verdict

**PASS.** The mutation that mattered is dead for the right reason, the label is constant and
translated everywhere it needs to be, and the visible text is preserved. Two nits for the
ledger: the unused `id`, and `aria-expanded` added to the residual list.

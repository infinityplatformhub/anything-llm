# ledger — #124 WorkspaceModelPicker accessible name

Branch `approof/124-picker-a11y`, base `510a4584a`, SHA `4646ed17b`.
Contract: `npx vitest --run .../workspaceModelPickerA11y.test.jsx` → `Tests  4 passed (4)`.
Full frontend suite 15 files / 96 tests / exit 0.

---

## Rulings

Ruling: the `aria-label` is a **constant string**, not the model name. The defect was never
"the button has no label attribute" — its accessible name came from its text content, which is
`modelName`. So a screen reader announced a VALUE ("gpt-4o-mini") with nothing saying the
element is a control or what activating it does, and that name changed under the user whenever
the model changed, so it could not be learned or searched for. `aria-label={modelName}` would
have satisfied every "has an accessible name" check and fixed none of that. If this is wrong,
the cost is a control whose spoken name differs from its visible text — which is the intended
trade: the visible text keeps showing the model, because that is the useful thing to SEE.

Ruling: the label reuses `chat_window.select_model` rather than adding a string. Verified, not
assumed: `grep -rn "select_model" frontend/src/locales/*/common.js` → **29 locale files**. A new
key would have shipped English into 28 locales. The fallback text already used this key, so the
label and the fallback now say the same thing in every language.

Ruling: `LLMSelector/action.jsx:100` is left alone. It carries a hardcoded English
`aria-label="LLM Selector"` — a real but smaller defect, and fixing it here would widen an a11y
diff past what was reviewed. Recorded so the pattern is not copied while someone is in the file.

## Corrections — two, and the first is the one that matters

**Correction 1: the mutation this issue's own contract promised to catch did not catch it.**

The contract, posted before implementation, said a test must reject `aria-label={modelName}`.
I wrote that test. It passed. Then I ran the mutant and it **survived** — `aria-label={modelName}`
was green on all four tests.

Cause: the test unmounted and remounted between the two model values, so both `aria-label` reads
happened during the fallback window, before the async model name arrived. Both reads saw the
same fallback string, and a value-derived label therefore looked perfectly constant.

Fix: read each name AFTER the model is visibly on screen —
`await waitFor(() => getByText(/gpt-4o-mini/))` before reading the attribute. That is the only
moment at which a value-derived label actually differs. The mutant now fails.

The generalisable rule, and the reason this is in a ledger rather than a comment:
**asserting that a value is STABLE requires observing it at a moment when it could have
changed.** A stability test that samples twice inside the same initial state proves nothing, and
it reads as thorough — which is what makes it dangerous. Second instance in this component group
after the `visible`/`can` case in #40 task 4, where a gate assertion was also true for a reason
unrelated to the property it named.

**Correction 2: a mock that did not match the real return shape.**

The visible-text test failed at first because I mocked `Workspace.bySlug` as resolving to
`{workspace}`. It resolves to the workspace ITSELF — it unwraps the response internally
(`models/workspace.js:249`). So `workspace.chatModel` was undefined, the model name never
rendered, and the test failed for a reason unrelated to the label. A mock that does not match
the real return shape tests the mock.

## Note on the matcher

i18next is not initialised under vitest, so `t("chat_window.select_model")` returns the KEY
rather than "Select Model". The tests match the key, because that is what the DOM carries in
this environment; matching the English string would pass only if some test happened to
initialise i18n and would fail for the wrong reason otherwise. The property under assertion —
the name is constant and describes the control — is satisfied either way.

## Correction 3 — QA-3 FAIL: the tests asserted text, not the label

Reproduced before fixing: deleting the `aria-label` line entirely left **4/4 green**. The issue's
own subject was unasserted.

Cause: `getByRole("button", {name})` matches the ACCESSIBLE NAME, which falls back to text
content. On this control the visible text during the fallback window is
`chat_window.select_model` — the same string as the intended label — so the matcher found the
button whether or not any label existed. Three knock-on effects: the head comment's "RED before
the fix" claim was false (it passed pre-fix in that window); the constancy test compared
`getAttribute("aria-label")` null to null; and the no-model test WAS the fallback path.

Fixed by waiting for the resolved state before every lookup, asserting the attribute directly
rather than inferring it from a name match, and requiring a non-empty string on both sides of
the constancy comparison. Mutants now: (a) label=modelName → 2 failed, (b) label deleted →
3 failed, (c) restored → 4 passed.

**The rule I got half right.** Correction 1 above states: *asserting a value is STABLE requires
observing it at a moment when it could have changed.* True, and I applied it only to the
constancy test. The same reasoning governs the REACHABILITY tests — a lookup performed in a
state where the label and the text are identical cannot distinguish them either. The general
form: **an assertion must run in a state where the property it names is the only thing that
could satisfy it.** Where a query has a fallback (accessible name → text content), assert the
mechanism directly instead.

## Residual

`LLMSelector/action.jsx:100`'s hardcoded English label (above). Not fixed here; worth folding
into whichever issue next touches that file.

# Ledger — issue 70, `SystemSettings.updateSettings` return value ignored

`_updateSettings` catches its own errors and returns `{success:false, error:<string>}` rather than throwing (`models/systemSettings.js:749`), so the returned value is the only signal a write failed and the `try/catch` around each call never fires. Five call sites discarded it and reported success. This is the third appearance of the same swallowed-error shape (QA-2 FINDING-1, #59, now here).

Ruling: **all five sites, including the three agent plugins.** PMO ruling. The three `updateConfig` methods (`gmail/lib.js:250`, `google-calendar/lib.js:46`, `outlook/lib.js:566`) are the ones the original Techlead finding missed — it counted four — because they are not endpoints and each is wrapped in a `try/catch` that looks like error handling. It is not: `updateSettings` never throws, so the catch is dead code on this path and `{success:true}` was returned unconditionally.

Ruling: **`system.js:1013` reads `error`, not `error.message`.** `_updateSettings` stores `error.message` of its own caught error, so the field is a **string**. `error.message` on a string is `undefined`, which meant the real failure text was silently replaced by the fallback on every failure. A one-character class of bug that only shows up on the path nobody exercises.

Ruling: **the sweep scans source, it does not enumerate today's callers.** A test asserting the five known sites behave correctly proves nothing about the sixth. `updateSettingsReturns.test.js` walks the runtime tree, finds every `SystemSettings.updateSettings(` / `._updateSettings(`, and checks the result is bound and read. If wrong, the parser's notion of "consumed" is heuristic and could mis-read an exotic call shape — the cost is a false red, which is the safe direction for a gate.

Ruling: **the silent unknown-key drop is NOT in this issue.** It is issue #72, filed separately with its own breaking-change note, because refusing unknown keys changes the `/v1` contract from 200 to 400. Sequenced after #70: this issue makes a failed write visible at the call sites, #72 then changes what counts as a failure. The other order would put a new refusal behind call sites that still cannot report it.

## Verification

GREEN: 12/12 across the two suites (`updateSettingsReturns` 8, `updateSettingsWriteFailureHttp` 4), confirmed by me rather than taken on report.

Four mutations run against the sweep, because a source-scanning gate that never goes red is the exact failure mode §7 warns about:

| # | mutation | expected | result |
|---|---|---|---|
| A | revert `admin.js:606` to the bare-await shape | RED, naming that site | RED — `["endpoints/admin.js:606"]` |
| B | add a NEW file with a call that ignores the result | RED, naming the new file | RED — `["utils/zzmut/newCaller.js:3"]` |
| C | add a NEW file that destructures `{success, error}` and returns them | GREEN (no false positive) | GREEN 8/8 |
| D | add a NEW file that assigns `const result = await …` and never reads it | RED | RED — `["utils/zzmut/goodCaller.js:3"]` |

B is the one that matters: it is the case the sweep exists for, and a fixture-list test would have stayed green through it. D shows the check is "the value is read", not merely "the value is assigned". C is the control — without it, a scanner that flags everything would look identical to a working one. Working tree restored and verified clean after each.

The HTTP suite drives the real stack through `require("../../index")` with real auth, a real API key minted through `ApiKey.create`, and mocks only `_updateSettings` — and it uses the real `/api/v1/admin/preferences` path, not the `/v1/admin/system-preferences` that does not exist. Positive controls present on both surfaces: a successful write still answers 200, so a route that refused everyone could not pass.

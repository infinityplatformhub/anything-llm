# Techlead — #70 settings-write return values, `65dc3890`

Reviewed: `approof/main...65dc3890` (Dev1, worktree `.claude/worktrees/pr65`,
branch `approof/65-updatesettings-returns`).
Verdict: **PASS.** No blocker, no major. Two NITs.

Diffstat: 10 files, +365/-11 — 3 endpoint call sites, 3 agent plugins, 2 new test files, recon, ledger.
Production change is 11 lines across 6 files; the rest is tests and docs.

## The two questions PMO asked

### Does the sweep catch "does not read the value", or only "does not assign it"? — **It catches both, for the shape that matters.**

I ran the sweep's own logic against synthetic call sites:

| call-site shape | sweep says |
|---|---|
| `await SystemSettings.updateSettings(u); response.status(200)` | **IGNORED** ✓ |
| `const r = await …(u); response.status(200)` — never read | **IGNORED** ✓ |
| `const r = await …(u); if (!r.success) throw` | CONSUMED ✓ |
| `const { success, error } = await …(u); …json({success,error})` | CONSUMED ✓ |

So for a **named binding** it genuinely tracks whether the identifier is read afterwards, not merely
that an assignment happened. That is the stronger of the two properties and the one the question was
about.

**Where it stops short:** a *destructured* binding is judged by the binding pattern alone
(`/\b(?:success|error)\b/.test(binding)`), so `const { success, error } = await …(u);
response.status(200).json({ success: true, error: null });` — the exact pre-fix body with a
destructure bolted on — reads as CONSUMED. I confirmed this. It is not reachable by accident: writing
that requires destructuring two names and then deliberately ignoring both, which is a stranger act
than the bare `await` this suite exists to catch. Recording it as the boundary of the guarantee, not
as a defect.

The named-binding branch has a matching soft edge: the identifier is searched for in the **rest of the
file**, so a binding named `result` that is unread here but used in an unrelated later function reads
as CONSUMED. Verified. Same character — a bounded imprecision, not a hole.

**Coverage is real, not theoretical.** The sweep walks all 528 `.js` files under `server/` (excluding
`__tests__`, `node_modules`, `coverage`) and finds **13** call sites across 9 files. I ran it and
every one is CONSUMED — and I read each of the 5 non-destructured ones to confirm the consumption is
genuine rather than an artifact of the identifier search:

- `assertDeploymentShape.js:50` — `if (!write?.success)` → logs and returns `repaired: false`.
- `liveSync.js:44` — `if (!update.success)` → 500 with the error.
- `communityHub.js:37` — `if (result.error) throw`.
- `system.js:772` (`modeUpdate`) and `:804` (`rollback`) — both read.

That the sweep finds 13 and the diff touches 6 is the point: the other 7 were already correct (#58,
#59 fixed several), and the sweep is what stops them regressing.

### Is the HTTP path really `/api/v1/admin/preferences`? — **Yes, and both routes are driven.**

`updateSettingsWriteFailureHttp.test.js:72,77` posts to `/api/admin/system-preferences` (UI) and
`/api/v1/admin/preferences` (API), through the real `app` from `server/index.js`, with a real JWT for
one and a real minted API key (`scopes: ["system.write"]`) for the other. Not a mocked router.

The mock is placed at `SystemSettings._updateSettings`, one level *below* the `updateSettings` the
routes call — so the route, the model's public method and the response assembly all run for real, and
only the database write is simulated. That is the right seam: mocking `updateSettings` itself would
have bypassed the very code being fixed.

`test.each` runs both routes through both arms — failure → 500 with the model's error, success → 200
with `{success: true, error: null}`. The success arm matters as much as the failure arm: without it,
a route hard-wired to 500 would pass the failure test.

## The change itself

**Correct at all six sites.** `admin.js:606` and `api/admin/index.js:782` replace
`response.status(200).json({success: true, error: null})` — a literal success claim — with
`response.status(success ? 200 : 500).json({success, error})`.

`system.js:1011` is a smaller but real fix: `error.message || …` → `error || …`. `_updateSettings`
returns `error` as a **string**, so `error.message` was always `undefined` and the fallback text
always won, discarding the model's actual message. Confirmed by reading `_updateSettings`'s return
shape. The test pins it by asserting the source contains `error || "Failed to update default system
prompt."` — a source-text assertion, which is weaker than driving the route, but this is a message
string rather than a status code and the route is already driven by the HTTP suite.

**The three plugins** return `{ success, ...(error && { error }) }`. Before, `updateConfig` returned
`{success: true}` unconditionally after a bare `await` — so a rejected settings write was reported to
the caller as a successful config update. The conditional spread keeps the success shape as
`{success: true}` exactly (no `error: undefined` key), which is why the "successful write" test can
assert `toEqual({success: true})` rather than loosening to `objectContaining`.

The plugin tests mock `SystemSettings.updateSettings` and assert **both** arms per plugin
(`test.each` × 3 × 2 = 6). The failure arm asserts the model's error string travels out verbatim, not
just that `success` flipped.

## NIT-1 — a call site with no preceding `;` is invisible to the sweep
The sweep locates the statement start with `source.lastIndexOf(";", match.index)`. A call written
without a preceding semicolon on its statement — the first statement in a block under ASI style —
takes the prefix from wherever the last `;` in the file happened to be, and the assignment regex then
fails to match. I verified: `async function h() {\n await SystemSettings.updateSettings(u)\n return
true\n}` reads as **IGNORED**, which is the safe direction (a false alarm, not a miss). But the same
shape *with* an assignment would also fail to match and be reported IGNORED, so the failure mode is
noise rather than silence. Fine as-is; noting that the parser is line-noise-sensitive in a way an AST
walk would not be, and #40's suite has just adopted `hermes-eslint` for the same class of problem.

## NIT-2 — the plugins now report failures that their own callers still discard
`OutlookBridge.updateConfig` is called at `outlook/lib.js:669` and `:742` (token refresh) and
`endpoints/utils/outlookAgentUtils.js:70` — all three `await` it and ignore the returned object. So
this change makes the plugins *tell the truth* without anyone yet listening: a failed settings write
during a token refresh still proceeds to set `this.#accessToken` and report success upward.

That is strictly better than before (the value is now correct when someone does read it) and is
outside #70's stated scope of `updateSettings` call sites. Raising it because the sweep is
action-specific — it greps `SystemSettings.updateSettings`, so `updateConfig`'s own ignored returns
are invisible to it, and the same defect class now lives one level up. Worth a residual line pointing
at the token-refresh path.

## What I did not do
Did not run the suite (§7.14). Every table above comes from executing the sweep's own logic and
reading the real call sites under node 22 — claim verification, not a test run.

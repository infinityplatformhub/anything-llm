# Ledger — issue 59, `_updateSettings` returns instead of throwing

`SystemSettings._updateSettings` catches its own errors and returns `{success:false,error}`. Four callers awaited it bare, so a failed write was indistinguishable from a successful one and execution continued as though it had worked.

Ruling: **checked at the call site, not by making `_updateSettings` throw** (PMO ruling 2). Two callers — `system.js:1103` and `:1138` — already destructure `{success, error}` and handle it correctly, and `systemSettings.js:694` deliberately passes the object through to its own callers. Changing the contract would break code that is already right, and Dev2 was working on `assertDeploymentShape` against the current shape. The four sites fixed here read `.success`; nothing else moves.

Ruling: **the forward write throws so the rollback runs.** At `system.js:799` a failed `multi_user_mode: true` now raises, which is what carries execution into the catch block. Returning 500 directly would leave the user rows the handler had just created — the admin exists, the mode is false, and that is deployment shape (b), the exact state #58's boot repair exists to correct. The recon said shape (b) needed a SIGKILL between two writes; it does not, a failing settings store reaches it through the supported path.

Ruling: **the rollback checks its own write too** (`:823`). The reason execution is in that catch is usually that the settings store is failing — which is precisely when the rollback's write fails as well. Unchecked, the recovery path reported itself as having run while doing nothing. It cannot retry usefully, so it logs at error level naming shape (b) and pointing at the boot repair, and the test asserts that log rather than trusting the 500.

Ruling: **`liveSync` returns 500 and does not start the workers.** Correcting my own earlier report to PMO: I said the write happened *after* the response was sent. It does not — it is before, and the defect is that its result was never read, so the handler fell through to `bootWorkers()` and a 200 saying live sync was enabled. Three states that cannot all be true: setting disabled, workers running, operator told it worked. The response reports the state that actually holds (`currentStatus`), not the one that was asked for.

Ruling: **`markOnboardingComplete` returns false on a failed write.** It returned `true` unconditionally, so onboarding would be offered again on the next boot while the caller had been told it completed.

Ruling (6): **`/request-token` guards the missing-password case, not only the missing-token one.** `bcrypt.compareSync` throws when either argument is not a string. #48 fixed the "no AUTH_TOKEN" half; QA-1's M10 found the other — a request omitting `password` answered 500 whether or not AUTH_TOKEN was set. Both now answer the same 401 `[003]` as a wrong password, and a test asserts the refusals are byte-identical: if they differed, the status or body would be an oracle for whether the instance has a password configured at all.

Three defects in my own harness, each caught by the suite going red:
- the `enable-multi-user` fixture authenticated with a user JWT. That route runs while the instance is still single-user — no user rows yet, which is the point of the route — and `validatedRequest` there expects a token carrying an encrypted `p` (the AUTH_TOKEN), not a user id. Both the failure cases and the positive control returned 401, which is a fixture that fails identically to a broken route.
- the login positive control 429'd: `/request-token` is rate limited per IP and per account, and the refusal cases ahead of it had spent the quota. `resetRequestControls()` in `beforeEach`.
- the liveSync mock stubbed `validations.experimental_live_file_sync` as identity. The real validator maps anything outside `enabled`/`disabled` to `"disabled"`, so with the identity stub the handler's "no change" short-circuit fired and the request never reached the code under test. The mock now mirrors the real function.

Also: `xml-crypto` was missing from the shared `node_modules` this worktree symlinked to — S2 SAML added the dependency to main, and the symlink pointed at a worktree still on an older branch. Not a code defect; noted because anyone sharing `node_modules` across worktrees will hit it after that merge.

Verification: 11/11 on the settings-failure suite, 6/6 on the liveSync suite. RED with all three checked sites reverted to bare awaits fails 7 of 11 — the 4 that stay green are every positive control. RED with the liveSync check removed fails 4 of 6, again leaving only its two controls.

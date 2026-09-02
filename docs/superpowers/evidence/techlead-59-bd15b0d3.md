# Techlead review — #59 `bd15b0d3` (settings writes that fail are no longer reported as successful)

**Verdict: PASS.** All four sites are fixed, M10 is closed, and the two rulings that decide
the *shape* of the fix — check at the call site, and throw at `:799` so the rollback runs —
are both right and both defended by tests rather than by comments alone. One FINDING (medium,
out of scope for this SHA but the same defect class), two nits.

## The ruling that matters most: throw at `:799`, do not return 500

`system.js:807-812` raises when `multi_user_mode: true` fails, and that is what carries
execution into the catch block.

Returning 500 directly would have been the obvious fix and the wrong one: by that point the
handler has already created the first admin, so a bare 500 leaves user rows present with
`multi_user_mode` false — **deployment shape (b)**, the exact state #58's boot repair exists
to correct. The ledger draws the conclusion I would have drawn and states it plainly: shape
(b) does not need a SIGKILL between two writes, a failing settings store reaches it through
the supported path. That corrects the #58 recon's characterisation, which said the window
was process death only.

`leaves no user rows behind — the rollback actually ran` asserts the consequence
(`users.count() === 0`) rather than the mechanism, so it survives the fix being rewritten.

## The rollback checks its own write

`:839-848`. This is the half most people skip, and the reasoning in the comment is exactly
why it cannot be skipped: **the reason execution is in that catch is usually that the
settings store is failing**, which is precisely when the rollback's own write fails too. An
unchecked rollback reports itself as having run while doing nothing.

It cannot retry usefully, so it logs at error level, names shape (b), and points at #58's
boot repair. The test asserts that log — `MULTI-USER ROLLBACK FAILED` and `shape (b)` — which
is the right assertion, because a 500 is returned either way and would prove nothing about
whether the rollback happened.

Ordering is correct: `User.delete({})` first, then the settings write. Reversed, a failure
between them would leave the mode reset with the admin still present — the same shape from
the other direction.

## The other two sites

**`liveSync.js:44-50`** — 500, and the response reports `currentStatus` (the state that
actually holds) rather than the state that was requested. Before this, three things that
cannot all be true: setting disabled, workers running, operator told it worked. The check
sits before `bootWorkers()`, so the workers are not started on a failed write, asserted
directly. The ledger corrects the author's own earlier report to PMO (they had said the write
happened *after* the response was sent; it does not) — a correction recorded rather than
quietly dropped.

**`systemSettings.js:806-812`** — `markOnboardingComplete` returns `false` instead of `true`.
Consequence named correctly: onboarding would be offered again on the next boot while the
caller had been told it completed.

## M10 — `/request-token` never answers 500 for a bad login

`system.js:381` now guards `!process.env.AUTH_TOKEN || typeof password !== "string"`.

`bcrypt.compareSync` throws when *either* argument is not a string. #48 closed the missing
`AUTH_TOKEN` half; QA-1's M10 found the other — a request omitting `password` answered 500
whether or not `AUTH_TOKEN` was set, which is the half that is reachable on a
correctly-configured instance.

The important assertion is `the refusals are indistinguishable from a wrong password`: if
the status or body differed between "no password field", "non-string password", "no
AUTH_TOKEN" and "wrong password", the difference would be an oracle for whether the instance
has a password configured at all. Testing that they are byte-identical, rather than testing
each returns 401, is the assertion that actually closes the oracle.

`typeof password !== "string"` rather than a falsy check is right: `password: 0` and
`password: []` are non-strings that `!password` would miss (`[]` is truthy and still throws
in bcrypt).

## The skipped sites — the ruling is correct

I verified each rather than taking the list:

- **`system.js:1126`, `:1161`** — already destructure `{success, error}` and branch. Correct
  to leave.
- **`systemSettings.js:694`** (`updateSettings`) — returns `this._updateSettings(updates)`
  directly, so it passes the result object to its own callers. Changing it would break the
  two sites above, which are already right.
- **`assertDeploymentShape.js:50`** — fixed by #58's follow-up (`a05c8796`), which I reviewed.
  Leaving it out avoids two branches editing one line.

The meta-ruling — **check at the call site rather than making `_updateSettings` throw** — is
the right call for a reason worth recording: making it throw would silently change the
contract for the two sites that already handle the object correctly, and for
`systemSettings.js:694`'s passthrough. A fix that breaks correct code to fix incorrect code
is a net loss even when the new contract is cleaner.

## FINDING-1 (medium, not this SHA) — the same defect exists on the PUBLIC `updateSettings`

`SystemSettings.updateSettings` (`systemSettings.js:694`) returns the same
`{success, error}` object, and it has seven callers. **Four ignore it exactly the way the
four `_updateSettings` sites did:**

| site | consequence of a failed write |
|---|---|
| `endpoints/admin.js:606` | `response.status(200).json({success: true, error: null})` — the admin settings form reports saved when nothing was written |
| `endpoints/api/admin/index.js:782` | same, on the `/v1` twin |
| `agents/.../gmail/lib.js:250` | credential rows not persisted; the agent behaves as configured until restart |
| `google-calendar/lib.js:46`, `outlook/lib.js:566` | same |

`endpoints/system.js:1046` and `communityHub.js:37` do check.

The two admin ones are the same user-visible lie #59 exists to remove — an operator is told
their settings saved. Out of scope here (PMO's brief named four `_updateSettings` sites), but
it is the same defect class in the same model, and the sweep that finds them is one grep.
Recommend a follow-up issue rather than widening this one.

## NIT-1 (low) — no sweep test pins the property

Every fix here is a call site reading `.success`. Nothing stops the fifth site from being
written as a bare await next month. A source-scanning test in the style of #48's
passthrough-condition sweep — every `_updateSettings(` / `updateSettings(` call outside the
model is either destructured or has its result assigned — would catch it, with the
anti-vacuous guard #48 established (assert the scan found a non-zero number of call sites).

Given FINDING-1 shows the class already recurs, this is worth more than the four individual
fixes.

## NIT-2 (low) — `liveSync`'s error body shape

`{liveSyncEnabled, error}` on the 500 path versus `{liveSyncEnabled}` on success. Not wrong,
but the success path has no `error: null`, so a client has to check for the key's presence
rather than its value. Every other route in this diff returns a consistent shape.

## The harness defects in the ledger

Three, each caught by the suite going red, each recorded with its cause:

- the `enable-multi-user` fixture authenticated with a **user JWT** — but that route runs
  while the instance is still single-user, so `validatedRequest` expects a token carrying the
  encrypted `p`, not a user id. **Both the failure cases and the positive control returned
  401**, which is a fixture failing identically to a broken route. That is the failure mode
  that makes a green suite meaningless, and it was caught only because the positive control
  existed.
- the login positive control 429'd — `/request-token` is rate limited per IP and per account,
  and the refusal cases ahead of it spent the quota. `resetRequestControls()` in `beforeEach`.
- the liveSync mock stubbed the validator as identity, but the real one maps anything outside
  `enabled`/`disabled` to `"disabled"` — so the handler's no-change short-circuit fired and
  the request never reached the code under test.

The third is the §7.9 shape: a mock more permissive than the real function means the test
exercises a path production never takes.

The `xml-crypto` note (a shared `node_modules` symlink pointing at a worktree on an older
branch, after S2 added the dependency) is environment, not code, and is correctly flagged as
such — worth keeping since anyone sharing `node_modules` across worktrees hits it.

## RED

11/11 and 6/6. Reverting all three checked sites to bare awaits fails **7 of 11** — the 4 that
stay green are every positive control, which is the correct signature: the controls prove the
route works, the other seven prove the failure is detected. Removing the liveSync check fails
4 of 6, again leaving only its two controls. The RED is named per site rather than as a total,
which is what makes it checkable.

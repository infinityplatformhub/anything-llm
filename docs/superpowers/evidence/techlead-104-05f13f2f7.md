# Techlead-1 — #104 `05f13f2f7` (+ ledger `bd77c0411`)

3 files, +356/-7: `updateENV.js` (+36/-8), `endpoints/system.js` (+13/-1),
`persistCredentialFailureHttp.test.js` (new, 314 lines). Reviewed against the blast-radius
answer I gave before the SHA. Probes in detached worktree `/tmp/tl1-104`; no suite run
(§7.14).

**Verdict: PASS.** All three questions answered below; the blast radius matches what I gave,
`process.env` staying live is the right direction, and the #80 comment is corrected properly.
One NIT — a second docblock on the same function still says the old thing.

## Q1 — does the blast radius match?

Yes, and the ledger's table is the one I sent, with the fourth row filled in correctly.

| caller | my answer | shipped |
|---|---|---|
| `POST /system/update-env` | 200→500, all 92 keys reachable | 500 on persist failure ✓ |
| `POST /v1/system/update-env` | 200→500, same | 500 ✓ |
| `POST /system/update-password` | `success:true`→`false`, strongest case | `success:false` + key name ✓ |
| `POST /system/enable-multi-user` | **needs a call-site change, (1) alone does nothing** | `const rotation = …; if (rotation.error) throw` ✓ |

The fourth is the one that mattered: it ignored the return entirely, so accumulating the
error in `updateENV` would have changed nothing there. The SHA reads the return and throws
into the **existing** catch, which already removes the user rows and resets
`multi_user_mode`. The test asserts the rollback ran — `users.count() === 0` and
`multi_user_mode !== "true"` — not merely that the status is 500. That is the distinction
between "the route failed" and "the instance is not half-enabled", and it is the assertion I
would have asked for.

My RF-3 (accumulate, do not `break`) is honoured and tested: `RF-3: a later key is still
applied when an earlier one fails to persist` drives `{OpenAiKey, LLMProvider}` with the store
failing, and asserts the later key **is** applied (`process.env.LLM_PROVIDER === "openai"`)
while `newValues` contains only `LLMProvider`. That is the half-state bug I wanted prevented,
prevented and witnessed.

`update-password` not rolling back is split to **#116** with a `ponytail:` marker in the test
naming the ceiling — two secrets rotate in one call, and undoing a partial rotation needs the
prior values read back and rewritten under the same failure, which is a transaction, not a
return check. Correct scope call: the shipped behaviour goes from a **lie** (200/success) to
an **accurate refusal**, which is the improvement; the rollback is a separate, larger change.

## Q2 — is leaving `process.env` in place the right direction?

Yes, and for the reason given rather than by default.

The value was written to `process.env` **before** the store was asked (`:1687`), and the
running process has already begun using it. Unsetting it would break the live instance on top
of losing the credential at the next restart — two failures instead of one, and the second is
the one the operator can least afford mid-request. Keeping it means the failure is exactly
"this survives until restart and no longer", which is what the error string says.

The comment states this explicitly. The behaviour is now: value live, key **absent** from
`newValues`, error naming the env key. Those three together are consistent — the operator is
told what changed, told what was lost, and the instance keeps working until they act.

Two things I checked because they would have made this wrong, and neither applies:

- **`postUpdate` hooks still run after an accumulated persist error.** Measured: of the 92
  `secret: true` keys, **zero** carry `postUpdate` or `postSettled` hooks. So nothing acts on
  a credential whose persistence just failed. If a future secret key gains a hook, that hook
  will run after a failed persist — worth a line in the residual, not a change now.
- **`runAfterAll` and `logChangesToEventLog` receive the mutated `newValues`.** Measured:
  **zero** keys declare `runAfterAll`, and the audit mapping covers only `LLMProvider`,
  `EmbeddingEngine`, `VectorDB` — none of them `secret: true`. So deleting a key from
  `newValues` cannot silently suppress an audit row today. Also worth the residual line, for
  the same reason.

## Q3 — is the #80 comment corrected correctly?

Yes. The old sentence — *"existing callers ignore it and keep their behaviour exactly — which
is deliberate"* — is replaced with the history and the reason it stopped being true: `dumpENV`
does not write `secret: true` keys either, so a failed persist leaves the credential in
exactly one place, this process's memory. I confirmed that premise rather than taking it:
`dumpENV` filters `KEY_MAPPING` on `secret !== true`, so those keys genuinely have no second
home.

Keeping the history rather than overwriting it is the right form. A reader who arrives via
#80 sees why the earlier decision was made and what changed, instead of finding a comment
that simply contradicts the commit they were reading.

This is the same correction class as #40 task 2's M4 ledger line: a comment asserting that a
swallow is deliberate is exactly what licenses the next caller to swallow. Fixing the comment
is not cosmetic.

## NIT-1 — `persistCredential`'s own docblock still describes the old contract

`updateENV.js:1806-1817`, immediately above the function:

> *A failure here is logged, not thrown: the value is already live in process.env and the
> setting has been accepted, so throwing would 500 a request whose work is done.*
> `@returns {Promise<void>}`

Both halves are now stale. The request **is** 500'd — by the caller, on the returned error —
and the function returns `{error}`, not `void`. The corrected comment lower down (inside the
body, at the `console.error`) is accurate, so the file now says two different things about the
same function twenty lines apart, and the **first** one a reader meets is the wrong one.

Same defect the SHA just fixed, one docblock over. Two lines: make `@returns
{Promise<{error: string|null}>}` and replace the "logged, not thrown" sentence with "returned
and logged; `updateENV` accumulates it into the response and every caller surfaces it".

## What I am not raising

The test file declares its own mode per test rather than sharing a `beforeEach` — the ledger
records why (the three routes live in different modes, and a fixture that works in only one
ordering looks like broken code). `RF-2` deletes the `JWT_SECRET` row and asserts `get()`
returns null before starting, because RF-1 writes the same key — that is the cross-test
contamination trap caught by the author rather than by a reviewer. `RF-1 control`
(update-password succeeds when the store accepts) is the positive control that stops RF-1
passing against a route that refuses every password change.

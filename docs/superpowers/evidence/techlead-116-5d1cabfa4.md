# Techlead-1 — #116 `5d1cabfa4`

7 files, +670/-4. The #116 subject is `endpoints/system.js` (+106) and
`__tests__/security/updatePasswordRollback.test.js` (339 new); the rest is #108's NITs in the
frontend lane. Reviewed against the ruling and the five RED fixtures I gave. Probes are
in-process `node -e`; no suite run (§7.14).

**Verdict: PASS.** All six fixtures (RF-1…RF-5 plus RF-2b) are present, each as its own named
test, and each asserts the thing that distinguishes the mutation rather than a proxy for it.
Two observations, neither blocking.

## The ruling is implemented as given, including the parts that are easy to drop

- **Priors read before any write.** `readInstanceCredentials()` runs before `updateENV`, and
  the comment says why reading afterwards returns the value just written.
- **Store only; `process.env` untouched.** The comment cites #104's ruling and states the
  reason in the operative form — *the store is what determines durability; the environment is
  what determines now.* That sentence is the one I wanted in the file rather than in a ledger.
- **Absence restored by `delete`, not `set(key, "")`.** This is the detail I did not spell out
  and it matters: `CredentialStore.set` refuses an empty value ("a credential must have a
  value; delete the row to clear it"), so `set("")` would fail and leave the row it meant to
  remove. Dev4 found that from the store's own contract and there is a test for it.
- **`restoreInstanceCredentials` returns a message rather than throwing**, because it runs
  under the same failure that caused the original — an exception would 500 and discard the
  error naming the non-durable credential.

## The fixtures, and what each one actually pins

**RF-1** — `both credentials are back to their prior stored values`, plus two siblings
asserting the error names the failed key and tells the operator the running instance is on
values that will not survive a restart. The store is read back, not the fixture object.

**RF-2** — two tests, and the second is the one that does the work:
`both reads happen before the first write` asserts on **call order** (`reads.every(r => r.index
< firstWrite)`), with the comment explaining that outcome alone cannot separate read-before
from read-after for every fixture. Outcome-only would have been the easy version and would
not kill the mutant.

**RF-2b** — split into its own describe *and* a second one for the finding it came from. The
assertion is through `CredentialStore.get`, not the fixture object, with the reason stated: a
compensation that left a row set to something falsy satisfies an object check and still hands
the next boot a credential. `prior values come from the STORE, never from process.env` seeds
the environment with values that appear nowhere in the store, so an env-sourced read fails —
and it names #115's hydrate window as the second bug that rule closes.

**RF-3** — the positive control, and stronger than I asked. Beyond `success:true` and the new
values being stored, it counts writes: `set` called **exactly twice**. A compensation that ran
and happened to write the same values would satisfy every other assertion and be invisible;
the count makes it visible.

**RF-4** — the restore itself fails; response is still 200/`success:false` and names both
problems. Asserts the original error survives (`/JWT_SECRET/`) alongside the restore failure.

**RF-5** — present, with the comment I asked for: *a future contributor adding an env rollback
"for symmetry" fails here.* This was the fixture I expected to be dropped.

## Ordering

`JWTSecret` first, `AuthToken` second — the reversal I suggested, and the comment says
explicitly that this is **not** the protection, the compensation is, and that the order only
improves the outcome in the window before compensation runs. That is the right framing: I
offered the ordering as a judgement held lightly, and it is recorded as such rather than as a
safety property.

## OBS-1 — `mentionsInstanceCredential` is a substring match on an error string

```js
INSTANCE_CREDENTIAL_KEYS.some((envKey) => String(error).includes(envKey))
```

Probed the error shapes `updateENV` can produce. Today this is exact:

| error | compensates |
|---|---|
| `JWT_SECRET was not persisted…` | yes ✓ |
| `OPEN_AI_KEY was not persisted…` | no ✓ |
| `unknown_keys: FOO_BAR` | no ✓ |
| validator messages for these two keys | no ✓ |

I checked the last row rather than assuming: `AuthToken`/`JWTSecret` validators return
`"Cannot set this setting."` and `"Your password has restricted characters…"` — neither names
the env key, so a check failure cannot trigger a spurious restore.

The coupling is still string-shaped: if a future validator message quotes `AUTH_TOKEN`, a
restore would run when nothing was written. Measured consequence: **harmless** — the priors
equal the current stored values, so the restore is a no-op rewrite. Worth one line in the
residual naming the coupling, not a change.

## OBS-2 — the compensation window is not atomic, and the residual should say so

Between `updateENV` returning and `restoreInstanceCredentials` finishing, the store holds one
new value and one old. A boot in that window sees the half-state this issue exists to prevent.
The window is milliseconds and closing it needs the transaction this issue deliberately did
not build, so this is correct as shipped — but "the store is put back" reads as atomic and it
is not. One sentence in the residual.

## The #108 lane

`adminRoute.test.jsx` and `Mailer/index.test.jsx` are frontend tests in the file lane PMO said
does not clash, and `updateEnvUnknownKeysHttp.test.js` picks a key by BLANK rather than by
position. I have not reviewed these as #116 subject matter; flagging only that they are in the
SHA so the merge record is accurate.

# QA-3 — issue #116, `5d1cabfa4` (Dev4) — PASS

Worktree `/tmp/qa3-104` at `5d1cabfa4`, `yarn install` + `prisma generate` after checkout,
database `qa3_104`, `--runInBand` throughout. Node 22. The before column is my own baseline
on `main` `909e98b9a`, measured before this SHA existed (`qa3-116-prereview.md`). My probe
is a separate file from Dev4's suite; both were run against every mutation.

Dev4's `updatePasswordRollback.test.js`: **12/12**. My probe: **7/7**.

## Before / after — all four values, and a real restart

`restart` below is the live variables dropped and the real `loadStoredCredentials()` run.

| | main `909e98b9a` | SHA `5d1cabfa4` |
|---|---|---|
| **A** `JWT_SECRET` fails, store | `AUTH=NEW`, `JWT=old` | `AUTH=old`, `JWT=old` |
| A after restart | `AUTH=NEW`, `JWT=old` | `AUTH=old`, `JWT=old` |
| **B** `AUTH_TOKEN` fails, store | `AUTH=old`, `JWT=new` | `AUTH=old`, `JWT=old` |
| B after restart | **old password authenticates again** | `AUTH=old`, `JWT=old` — deliberate |
| **C** control | — | `success:true`, all four durable |

`process.env` still holds the new values after the response in both A and B, which is the
ruling (`env not rolled back, store restored`). Verified as four separate values, not one.

```
A post  {"env_AUTH":"password-NEW","env_JWT":"ad9b4bc4-…","store_AUTH":"password-original","store_JWT":"jwt-secret-original-…"}
B post  {"env_AUTH":"password-NEW2","env_JWT":"3fb34fe0-…","store_AUTH":"password-original","store_JWT":"jwt-secret-original-…"}
```

Additional probes:

- **RF-2b** — no prior rows at all: store ends `{AUTH:null, JWT:null}`, not one row written.
- **D** — the compensation itself fails: `200 success:false`, no exception.
- **D2** — both restores fail: the message names both (`The previous AUTH_TOKEN and
  JWT_SECRET could not be restored in the credential store.`) and still no 500.
- **B2** — a JWT minted before the failed rotation still verifies after the restart, since
  the secret is back to the one that signed it.

## Mutations — Dev4's suite and my probe

| id | mutation | dev suite | my probe |
|---|---|---|---|
| M1 | compensation removed entirely | **7 of 12 failed** | **5 of 7 failed** |
| M2 | restore only `AUTH_TOKEN` (`INSTANCE_CREDENTIAL_KEYS` shortened) | **8 failed** | **4 failed** |
| M3 | `delete` → `set(key, "")` for a prior absence | **3 failed** | **1 failed** — RF-2b |
| M4 | read prior values **after** `updateENV` instead of before | **7 failed** | **4 failed** |

M3 is the narrow one and it lands where it should: only the no-prior-row case can see it,
because `CredentialStore.set` refuses an empty value, so the row it meant to remove
survives. Dev4 has a test named for exactly that (`the restore uses delete, not a write of
empty string`).

M4 is the ordering claim in the comment (`Read before, not after: reading afterwards
returns the value just written`) — and it is load-bearing, not decoration.

## An error of mine that would have produced a false PASS

My first stub failed **every** `CredentialStore.set` for the named key, including the
compensating write. A and B passed: the store still held the original values. But that was
not the restore working — it was nothing ever having overwritten them. The error string in
that run said `The previous JWT_SECRET could not be restored in the credential store.`,
which is the evidence I should have read before calling it a pass.

Fixed by failing only the **first** write for that key (`failOnce`), so the compensation is
genuinely exercised, and by adding an assertion that the error must **not** match
`/could not be restored/`. The table above is from that version. This is the green-for-the-
wrong-reason shape in its plainest form, and it was mine, not the code's.

## On the reordering

`JWTSecret` now precedes `AuthToken` in the `updateENV` call. The comment is careful to say
this is not the protection — the compensation is — and that is the right way round: a store
failing on its first write makes the common outcome "JWT not persisted, AUTH persisted",
which `ensure-secrets.js` repairs at boot, rather than the reverse, where `AUTH_TOKEN` ends
up absent and `validatedRequest`'s passthrough (`!AUTH_TOKEN || !JWT_SECRET`, a
disjunction) serves every request unauthenticated. M1 confirms the ordering alone does not
save it: with the compensation removed, A and B both fail regardless of order.

## Residual

- Restoring a prior **absence** returns the instance to its pre-password state, which
  `validatedRequest` treats as passthrough. The code comments this and calls it a residual
  rather than hiding it — correct, and worth PMO knowing it is a real state a failed first
  password-set can land in.
- The `#115` window is untouched by this SHA: `loadStoredCredentials()` still runs inside
  the `listen()` callback (`utils/boot/index.js:58` and `:113`). This fix reads prior values
  from the **store**, not `process.env`, so it is safe in that window — which is the
  ordering-independent answer to the question I raised in the pre-review. Dev4 has a test
  asserting exactly that (`prior values come from the STORE, never from process.env`).

## Files touched by me

None. Probe lived in `/tmp/qa3-104/server/__tests__/qa3probe/` and is deleted; every
mutation reverted. `git status` clean at `5d1cabfa4`.

# #116 recon — update-password leaves one key rotated when the other fails

Read-only. Base `origin/approof/main`. No code touched.

---

## The issue's premise is wrong, and the bug is worse than filed

#116 opens: *"After #104 a persist failure is surfaced — the route answers `success: false` with
an error naming the key that was not stored. What it does not do is undo the half that
succeeded."*

Two things are wrong with that.

**1. #104 is still OPEN.** Nothing in the tree surfaces a persist failure.

**2. `updateENV` cannot surface one.** `error` accumulates only from unknown keys, `checks`, and
`preUpdate` functions. The persist call at `updateENV.js:1687` is

```js
if (KEY_MAPPING[key]?.secret === true)
  await persistCredential(envKey, nextValue);
```

— the return value is discarded. `persistCredential` returns `{error}` (S11a #80 TL-1 made it
do so) and logs, but the loop ignores both.

Measured, not read. Forcing `CredentialStore.set` to fail on the second key only:

```
[credential-store] JWT_SECRET is live for this process but was not persisted; it will be
                   lost on restart: disk full
updateENV error: false
route would answer success: true
```

and on the first key only:

```
[credential-store] AUTH_TOKEN is live for this process but was not persisted...
FIRST key fails -> updateENV error: false | success: true
AUTH_TOKEN live in process: true
```

So the operator is told **the password change succeeded**. #116's "accepted risk in the
meantime" — *"the operator sees `success: false` naming the key that failed and retries"* — does
not happen. There is nothing on screen. The only evidence is a server log line.

**The loop does not stop either.** After the first key fails to persist, the second still
persists, so a first-key failure produces exactly the split state #116 describes rather than
stopping short of it.

## Why the silence matters more than the split state

`validatedRequest.js:29-36` is a **disjunction**:

```js
if (process.env.NODE_ENV === "development" ||
    !process.env.AUTH_TOKEN ||
    !process.env.JWT_SECRET) { next(); return; }   // passthrough, no auth
```

Consider `AUTH_TOKEN` persisted, `JWT_SECRET` not, and a restart. `ensure-secrets.js` generates
a fresh `JWT_SECRET` (it is in `GENERATED_KEYS`), so both are set and the instance is closed —
sessions are invalidated, the password works, recoverable.

Now the other order: `JWT_SECRET` persisted, `AUTH_TOKEN` not. `ensure-secrets` deliberately
does **not** generate `AUTH_TOKEN` (`ensure-secrets.js:9-19` — writing random bytes there is a
permanent lockout). So after the restart `AUTH_TOKEN` is absent, the disjunction's second clause
is true, and **the instance serves every request unauthenticated.** The operator believes they
just set a password.

That is the finding this issue should lead with, and it is not in the issue.

## What the fix actually needs — and what it does NOT need

#116 asks for read-prior-value-then-restore. Measured against the real store, that is the wrong
shape:

```
stored: old-value
[credential-store] failed to store PROBE_KEY: A credential must have a value...
failed set returned: "A credential must have a value; delete the row to clear it."
after failed set: old-value
```

**A failed `set` leaves the prior row intact** — it is an `upsert` inside a `try`, so a failure
writes nothing. There is no torn value to restore for the key that failed. The only key needing
attention is the one that **succeeded** before its partner failed.

So the smaller, more honest fix is two parts:

1. **Do not discard the persist result** (`updateENV.js:1687`). This is #104's subject one level
   down, and #116 cannot be tested without it — every assertion about "what the route reports"
   is unreachable while the report is always success.
2. **Make the pair atomic.** `CredentialStore.set` already takes an injectable `db`
   (`credentialStore.js:68`), and `prisma.$transaction` is used elsewhere in this codebase
   (`models/memory.js:306,387`, `models/workspaceUsers.js:16`, `models/passwordRecovery.js:22`).
   Writing both rows in one transaction removes the split state rather than compensating for it
   afterwards — and a compensating restore can itself fail, which #116 acknowledges but cannot
   solve, because the restore runs under the same conditions that just caused the failure.

Atomicity is available here. It was not available for the mailer (#80), where the two writes
span `credential_store` and `system_settings`; that is why the mailer records a residual instead.
Both keys here live in one table.

## Open questions for a ruling

1. **Scope.** Does #116 include fixing `updateENV.js:1687` (dropping the persist result), or does
   that belong to #104? They overlap: #104 is about `enable-multi-user` dropping `updateENV`'s
   return, this is `updateENV` dropping `persistCredential`'s. **Recommendation: fix it here**,
   because #116 is untestable without it — but it changes behaviour for **every** `secret: true`
   key, not just these two, and that is a bigger blast radius than the issue title suggests.
2. **Transaction vs. compensation.** Recommend the transaction. Needs confirming that
   `CredentialStore.set`'s `db` parameter accepts a Prisma transaction client (it is typed
   `db = prisma` and only calls `db.credential_store.upsert`, so it should).
3. **What should a failure return?** #116 says the route reports failure. Worth deciding whether
   `updateENV` returns an error (affecting every caller) or `update-password` checks
   specifically. The former is more correct and riskier.

## Interaction with #115 (hydrate window)

Different bug, same blast radius, and they compound: #115 means `loadStoredCredentials()` runs
inside the `listen()` callback, so requests are served before credentials are hydrated. During
that window `AUTH_TOKEN` is absent from `process.env` for a reason unrelated to #116 — and
`validatedRequest`'s disjunction opens the instance for exactly as long. #116 makes that state
durable; #115 makes it happen on every boot. Neither is the other's cause, and fixing one does
not fix the other.

## Interaction with #104

#104 is the same defect one layer up: a caller discarding a return that reports failure. Closing
#104 without closing this leaves `enable-multi-user` correctly checking a value that is always
`false`. Worth sequencing them together or noting the dependency on both.

## Tests (RED first)

- **The report**: with the store failing on `JWTSecret`, `POST /system/update-password` must not
  answer `success: true`. RED today — measured above.
- **Atomicity**: with the store failing on the second key, NEITHER row is written. Fails both
  keys does not exercise this; the failure must be on the second specifically (#116 says this
  and is right).
- **The lockout, asserted directly**: after a failed rotation and a simulated restart with
  `ensure-secrets` behaviour, `validatedRequest` must not take its passthrough branch. This is
  the consequence that matters and no test covers it today.
- **Positive control**: a rotation with a working store persists both keys and reports success —
  without it, a fix that refuses everything satisfies every assertion above.
- **Not stopping the loop**: assert that a persist failure on the first key does not leave the
  second key written.

## Size

Small if the ruling is "transaction + return the persist error": roughly `updateENV.js:1687`,
a transactional pair-write in `CredentialStore`, and the route. 8-12 tests. Large if every
`secret: true` caller must be audited for the newly-returned error, which is question 1.

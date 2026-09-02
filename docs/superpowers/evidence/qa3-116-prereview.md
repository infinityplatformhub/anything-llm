# QA-3 — #116 pre-review: what a half-persisted password rotation leaves behind

Baseline on `main` `909e98b9a` (immediately after #104 merged). Worktree `/tmp/qa3-104`,
own install, database `qa3_104`, `--runInBand`. `CredentialStore.set` is stubbed to fail
for **one named key**; everything else is real, including the restart, which is simulated
by dropping the live variables and calling the real `loadStoredCredentials()`.

`POST /system/update-password` writes two `secret: true` keys in one `updateENV` call:
`AuthToken` and a freshly minted `JWTSecret`. #104 made the failure visible; it did not
make it atomic. Both orderings below leave a coherent-looking response over an instance in
a state nobody chose.

## A — `JWT_SECRET` fails to persist, `AUTH_TOKEN` already landed

```
pre    env   AUTH_TOKEN="password-original"  JWT_SECRET="jwt-secret-original-at-least-12"
       store AUTH_TOKEN="password-original"  JWT_SECRET="jwt-secret-original-at-least-12"

status=200 body={"success":false,"error":"JWT_SECRET was not persisted and will be lost on restart: …"}

post   env   AUTH_TOKEN="password-NEW"       JWT_SECRET="9d77fd4c-…"      <- rotated, live
       store AUTH_TOKEN="password-NEW"       JWT_SECRET="jwt-secret-original-…"  <- OLD

after restart
       env   AUTH_TOKEN="password-NEW"       JWT_SECRET="jwt-secret-original-…"
```

- The **new password works after the restart** — `AUTH_TOKEN` persisted.
- `JWT_SECRET` silently **reverts to the previous value**.
- Every session issued between the rotation and the restart was signed with `9d77fd4c-…`
  and **does not verify afterwards**: `sessions verify after restart? false`.

So the operator is told the change failed, and the password half of it succeeded anyway.
They will most likely retry — with the new password, since that is what now works — and
each retry mints another JWT secret that may or may not persist.

## B — `AUTH_TOKEN` fails to persist, `JWT_SECRET` landed

```
status=200 body={"success":false,"error":"AUTH_TOKEN was not persisted and will be lost on restart: …"}

post   env   AUTH_TOKEN="password-NEW2"      JWT_SECRET="583607df-…"
       store AUTH_TOKEN="password-original"  JWT_SECRET="583607df-…"   <- old password, new secret

after restart
       env   AUTH_TOKEN="password-original"  JWT_SECRET="583607df-…"
```

The **old password comes back** after the restart while the JWT secret stays rotated. This
is the more dangerous direction: an operator who changed their password because it was
compromised has been told it failed, sees the new one working in the live process, and
after the next restart the compromised password authenticates again.

## C — control, both persist

```
status=200 body={"success":true,"error":false}
post/after restart: AUTH_TOKEN="password-NEW3"  JWT_SECRET="1a8266ed-…"   (both durable)
```

Confirms the failures above come from the stub and not from the fixture.

## What this means for the fix

The compensation has to restore **both** keys, in **both** stores, in **both** directions —
A and B fail differently and a fix that only handles one leaves the other. Specifically:

- `process.env` must go back, not only the row. #104 deliberately leaves the live value in
  place on a persist failure (its comment explains why), so a compensating write in this
  route has to override that decision for this caller. That is a genuine tension between
  the two issues, not an oversight, and the ledger should say which wins here and why.
- The previous `JWT_SECRET` must be captured **before** `v4()` mints the new one — after
  `updateENV` returns, the old value exists nowhere in the process.
- Restoring `AUTH_TOKEN` means writing the *old* password back through a path whose
  validator is `requiresForceMode`; the route already passes `force: true`, so a
  compensating call must too or it will refuse its own rollback.

## Probes I will fire on the SHA

1. A and B re-run — the tables above become the before column.
2. Positive control C — both persist, `success:true`, both durable, and the compensation
   must **not** have run (a rollback that fires on success is the #59 shape).
3. After compensation, a **restart** must show the ORIGINAL password and the ORIGINAL JWT
   secret in both `process.env` and the store — checked as four values, not one.
4. Live-session survival: a JWT minted before the failed rotation must still verify after
   the compensation, since the secret is back to what signed it.
5. Compensation that itself fails (stub both keys) — the response must not claim a
   successful rollback. This is the #59 lesson and it applies to this route too.
6. Mutations: remove the compensation → A and B red; compensate only `AUTH_TOKEN` → B red,
   A green; capture the old secret *after* `v4()` → the restore writes the wrong value.

## Interaction with #115

`loadStoredCredentials()` runs **inside** the `listen()` callback on both `bootHTTP`
(`utils/boot/index.js:113`) and `bootSSL` (`:58`), so the socket accepts requests before
the store has hydrated. For this route that window is not cosmetic: a rotation arriving
inside it reads `process.env.JWT_SECRET` as whatever the environment supplied, not the
stored value, so a compensation that restores "the previous value" could restore the
pre-hydrate one and overwrite a good stored secret with it. If #115 lands first the window
closes; if #116 lands first its compensation should read the previous values from the
**store**, not from `process.env`. Worth a ruling on ordering rather than leaving it to
merge sequence.

Files touched by me: none. Probe lived in `/tmp/qa3-104/server/__tests__/qa3probe/` and is
deleted; `git status` clean at `909e98b9a`.

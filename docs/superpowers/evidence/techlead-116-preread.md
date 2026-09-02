# Techlead-1 — #116 pre-read (`POST /system/update-password` partial rotation)

Read against `approof/main` + #104's `05f13f2f7`: `endpoints/system.js:903-945`,
`utils/helpers/updateENV.js:1683-1710,1840-1869`, `models/credentialStore.js:68-135`,
`utils/http/index.js:26-62`, `KEY_MAPPING` measured.

**Ruling asked for: two-phase vs compensate.** My answer is **neither as posed** — a third
shape that is smaller than both and does not need a transaction. Reasoning first, because it
turns on two measurements.

---

## Measurement 1 — the two keys are not symmetric, and that decides the ordering

```
AuthToken  envKey AUTH_TOKEN  secret:true  checks:2  preUpdate:0  postUpdate:0
JWTSecret  envKey JWT_SECRET  secret:true  checks:1  preUpdate:0  postUpdate:0
```

Both `secret: true`, so neither reaches the `.env` file — `dumpENV` filters `secret !== true`.
Both therefore live in exactly two places: `process.env` (this process) and
`credential_store` (durable). Neither has hooks, so nothing external observes the write.

The asymmetry is in what each one breaks:

- **`JWT_SECRET` not persisted** → `makeJWT`/`decodeJWT` (`utils/http/index.js:26,62`) sign
  and verify against the in-memory value. Next boot mints or loads a different one, and
  **every session issued in between stops working**. The operator is logged out along with
  everyone else, but the password still works, so they can get back in.
- **`AUTH_TOKEN` not persisted** → the new password is live for this process only. Next boot
  restores the **old** password from the store. Sessions survive (JWT_SECRET is intact), and
  the operator's *old* password still works.

So both partial states are recoverable, and neither locks the operator out permanently — the
worst case is confusion, not lockout. That matters for the ruling: this does not need the
strongest available mechanism, it needs an honest one.

## Measurement 2 — the store already has the primitive, and `updateENV` is the wrong layer

`CredentialStore.set` is an `upsert` on one row and returns `{envKey, error}` — it never
throws. `prisma.$transaction` is used elsewhere in the tree (`validApiKey.js:183`,
`PostgresJobQueue.js:88`), so a two-row atomic write **is** available.

But putting it in `updateENV` is wrong: that function is shared by all 213 settings and four
callers, and "these N keys must persist together or not at all" is a property of *this route's
pair*, not of the update path. #84 already refused the analogous move (a sentinel value in
the shared update payload) for the same reason.

---

## The ruling I would give: **compensate, in the route, with the store as the only thing
compensated**

Not two-phase, because two-phase means holding both values back from `process.env` until both
rows land — and `updateENV`'s whole contract is that `process.env` is the read path written
first (`:1687`). Restructuring that for one route is a large change to a shared function to
fix a two-key case.

Not "compensate" as posed either, if that means restoring `process.env`. The live values
should stay, for the same reason #104 kept them: this process is already using them, and
rolling `process.env` back mid-request breaks the running instance on top of the storage
failure. #104's ruling was accepted for exactly this and #116 should not contradict it.

**What to compensate is the store, and only the store:**

```
1. read BOTH current stored values first  (CredentialStore.get × 2, before any write)
2. call updateENV as today
3. if update.error mentions either envKey:
     restore the store to the values read in (1) — set(prior) or delete(if absent)
     leave process.env alone
     answer success:false naming which key, and that the instance is running on
     values that will not survive a restart
```

Why this is the right size:

- The failure being repaired is "the store holds one new value and one old one". Putting the
  store back to *both old* makes the durable state internally consistent again, which is the
  actual defect. The running process being ahead of the store is already the accepted state
  after #104.
- It needs no transaction and no change to `updateENV`. If the compensating write **also**
  fails, you are no worse off than today and the message says so.
- Reading the prior values **before** writing is the part that must not be skipped. Doing it
  after is reading what you just wrote.

**If PMO prefers atomicity anyway**, the smaller version is: keep `updateENV` untouched, and
have the route write both credentials itself inside one `prisma.$transaction` *before*
calling `updateENV` with `force` — but then `updateENV` writes them again, and two writers to
one row is worse than the problem. I would not.

## Safer ordering, if the pair stays sequential

**`JWT_SECRET` first, `AUTH_TOKEN` second.** Measured: `Object.keys({AuthToken, JWTSecret})`
is insertion order, so today `AUTH_TOKEN` goes first and `JWT_SECRET` second — the reverse.

Reason: if the *second* write is the one that fails (the common case for a store that starts
failing mid-call), you want the survivor to be the one whose loss is more confusing.
- Current order failing on write 2: password persisted, JWT not → next boot has the new
  password and a fresh secret; everyone is logged out and the operator does not know why,
  because the password change *appeared* to be the only thing that happened.
- Reversed order failing on write 2: JWT persisted, password not → next boot has the old
  password and the rotated secret; everyone is logged out **and** the new password does not
  work, which is a louder, more diagnosable failure that points straight at the password
  change.

That is a judgement call and I hold it lightly — but with compensation in place the ordering
stops mattering, which is another argument for compensating rather than tuning the order.

## Interaction with #115's window

I do not have #115's contents. What I can say is the constraint it must satisfy: **the
compensating write must happen before the response is sent**, not in a `finally` that races
the reply, and the route must not become async-after-response. If #115 introduces any window
where `process.env.JWT_SECRET` and the stored value are deliberately allowed to differ, #116's
compensation must not treat that as the failure it repairs — it repairs only the case where
`updateENV` reported a persist error for one of these two keys. Flag this to Dev4 as a
question rather than an assumption, since I cannot read #115 from here.

---

## REQUIRED RED FIXTURES

**RF-1 — the second store write fails; both keys end at their prior stored values**
```
fixture   : store accepts AUTH_TOKEN (or whichever is written first), rejects the second;
            assert CredentialStore.get(AUTH_TOKEN) === the PRIOR value and
            get(JWT_SECRET) === the PRIOR value — both read back from the store, not
            from process.env
mutation  : delete the compensating restore
green why : asserting `success:false` alone passes today, before any of this work —
            #104 already returns that. The claim is about the STORE's contents, and
            only a store read witnesses it.
```

**RF-2 — prior values are captured before the write, not after**
```
fixture   : store rejects the second write; assert the restored value equals the
            password that was in the store BEFORE the request, by seeding a known
            distinct prior value
mutation  : move the CredentialStore.get calls to after updateENV
green why : a fixture whose prior stored value is absent (fresh instance) restores
            "nothing" either way and passes against a read-after-write bug. The prior
            value must be present and DIFFERENT from the new one.
```

**RF-3 — positive control: nothing is restored when both writes succeed**
```
fixture   : store accepts both; assert both stored values are the NEW ones and that
            the compensating path did not run (spy on CredentialStore.set counting
            calls, or on delete)
mutation  : make the restore unconditional
green why : asserting success:true passes against a route that restores and then
            reports success — the operator would be told the password changed while
            the store holds the old one, which is the original bug wearing a hat.
```

**RF-4 — the compensating write itself fails**
```
fixture   : store rejects the second write AND the restore; assert the response still
            answers success:false and names both facts, and that no exception escapes
mutation  : let the restore throw / drop its return check
green why : a fixture where the restore succeeds never enters this path, and a store
            that has begun failing is exactly the store the restore is asked to use.
```

**RF-5 — `process.env` is deliberately NOT rolled back**
```
fixture   : store rejects the second write; assert process.env.AUTH_TOKEN and
            process.env.JWT_SECRET still hold the NEW values after the response
mutation  : add a process.env rollback "for symmetry"
green why : this is the assertion that stops a future reviewer completing the symmetry
            and breaking the running instance. #104 made this ruling; #116 must pin it
            rather than silently depend on it.
```

RF-5 is the one I would most expect to be left out, and it is the one that keeps #104's
decision from being undone by a well-meaning follow-up.

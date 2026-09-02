# Techlead-1 review — #80 `22cd99c9` (Dev3, `approof/s11a-mailer`) — **PASS**, 3 NITs

Final SHA: step 6 (settings/save/test routes) plus the fixes ruled on `719b7eee`.
Delta 719b7eee..22cd99c9 is 15 files / +1206 −149.

Per §7.14 no suites — in-process probes and a read of the assembled routes.
Reproduction at the end.

---

## FINDING-1 (limiters unmounted) CLOSED — and mounted on the right condition

```js
whenMailing(inviteMailRateLimit)
```

`whenMailing` reads `request.body?.email` and calls `next()` straight through when
absent. Body parsing happens at `index.js:81` before `app.use("/api", ...)` at `:103`,
so `request.body` is populated by the time the limiter runs — the one thing that
could have made this silently a no-op.

Metering only the mailing case is the right condition, and the pair of tests proves
both halves: mailed invites refused past the ceiling, copy-link invites **not**
metered. A single "429 eventually" test could not tell those two designs apart.

The flood test is the strongest thing in this SHA. It uses the **built-in default**
rather than setting the env, with the reason stated: *"a test that configures its own
ceiling proves the limiter reads config, not that the shipped default protects
anything."* That is exactly the distinction QA-3's 15-requests-all-200 measurement
exposed. It also asserts the refusal costs nothing downstream — `invites.count` for
the refused address is 0 **and** `fixture.messages` is 10 — because a limiter that
answers 429 *after* sending is worse than none.

## FINDING-2 (listing leak) CLOSED — masked, fixed-width, and identical on both routes

`whereWithUsers` takes `options.unmaskEmail`, defaulting to masked.
`GET /admin/invites` authorizes `user.manage` and passes the result;
`GET /v1/admin/invites` never passes it, so an API key cannot unmask — correct,
since the scope vocabulary cannot express `user.manage`.

`maskEmail` probed:

```
person@example.com     -> p***@example.com
a@b.co                 -> a***@b.co
ab@x.io                -> a***@x.io
averylong...@x.com     -> a***@x.com
@nolocal.com           -> ***
noatsign               -> ***
```

Fixed width regardless of local-part length, so the mask is not a length oracle —
and the test asserts that by comparing a 1-char and a 22-char local part for
**equality**, which is a better assertion than checking a pattern. The
"both listings mask the same address the same way" test compares the two routes'
output byte-for-byte, with the right reason: two spellings of "masked" is how one of
them quietly stops masking.

## NIT-1 (`/v1` 400 untested) and NIT-2 (`mailed` field) CLOSED

GAP-2 posts `{email}` to `/v1/admin/invite/new` with an `invite.create` key and
asserts 400 + `invite: null`. `mailed` is now a boolean field on all three outcomes
(true, false, and false-with-error), tested separately.

## OBS-1/OBS-2 CLOSED

`SETTING_KEYS` carries `smtp_allow_untrusted_cert` explicitly and `driverFor` /
`driverFromSettings` map each consent to exactly one option. `actorKey`'s comment
was corrected as proposed.

## The save gate — step 6

Both mailer routes sit behind `system.write` (ruling A), and `/mailer/test` carries
`mailerTestRateLimit` with the port-scanner reasoning stated. The save path is the
order I asked for:

1. `configHash(settings, password)` compared against the stored hash — **refuse
   before writing either table**;
2. `persistCredential` first, and its `{error}` checked — 500 with "Nothing was
   saved" if it failed;
3. `process.env` set only after that;
4. settings written last.

So a verified marker can never describe a credential the next boot cannot find,
which is the FINDING-2 chain from `35c91ab0` closed at the layer that actually writes.
`GET /mailer/settings` returns `hasPassword: Boolean(password)` rather than the value
— the right answer to a question the admin does need. Four tests pin the gate's whole
point: editing the host invalidates the proof, rotating the password invalidates it,
a failed test licenses nothing.

`assertChannelReady()` still runs again inside `sendInvite`, so a settings row written
by any other path cannot bypass the gate at send time.

## The 9 new `supportedFields` labels do NOT break #78

`supportedFields` goes 28 → 37. Checked against #78 `86d2fe96`:

- #78's drift test asserts the **set relation** `allowed ∪ forbidden === supported`,
  not a count, so the new labels land in `forbidden` and it stays green — which is
  what I asked for in the #80 pre-read.
- #78's HTTP suite derives `forbiddenFields` from `supportedFields` at runtime, so
  `it.each(forbiddenFields)` simply grows to cover the smtp keys. No hardcoded 23
  anywhere in either #78 test file (`grep -n "\b23\b"` returns nothing).
- Consequence worth stating: after both merge, a manager posting `smtp_host` to
  `/admin/system-preferences` gets 403 `forbidden_keys`. That is correct and
  desirable — the mailer's own routes are `system.write`, so the settings route must
  not be a side door into them.

`smtp_*` are not in `publicFields`, so none of them reach the unauthenticated
settings read.

---

## NIT-1 — `smtp_verified_hash` is writable through `updateSettings`

It is in `supportedFields`, so `POST /admin/system-preferences` with
`{smtp_verified_hash: "..."}` reaches `_updateSettings`. It is HMAC'd under `SIG_KEY`
so it cannot be *forged*, and after #78 a manager is refused — but a `system.write`
holder can still overwrite or clear the proof through a route that has nothing to do
with the mailer. Clearing it is harmless (the gate fails closed). Copying a hash from
a staging instance with the same `SIG_KEY` is the case worth thinking about.

It has to be in `supportedFields` for `/mailer/test` to write it through
`updateSettings`. The cheaper fix is to write it with `_updateSettings` from the
mailer route and add it to `protectedFields` — then only the code that proves a
configuration can record the proof.

## NIT-2 — the test-then-save gate is per-configuration, not per-actor

`/mailer/test` writes the hash; `/mailer/settings` reads it back. Nothing binds those
two calls to the same session or actor. Both are `system.write`, so this is not a
privilege issue — but a hash left behind by one admin's test lets another admin save
that configuration without testing it themselves. Given the gate's stated purpose
("saving requires a successful test bound to the exact configuration"), that is
arguably correct as designed: the proof is about the *configuration*, not the person.
Worth a sentence in the comment saying so deliberately, since a reader will ask.

## NIT-3 — `/mailer/test` sends real mail to a caller-supplied address, metered at 6/min

The route is `system.write` and rate limited, so this is bounded. But it is a
send-arbitrary-text-to-arbitrary-address primitive whose body is fixed, which is the
right constraint — recording it so the next person adding a `body` parameter to the
test route sees why it does not have one.

---

## Verdict

**PASS.** Everything from my two previous rounds is closed, and the flood and mask
tests assert the properties rather than the symptoms. NIT-1 is worth doing before
merge if it is cheap; NIT-2 and NIT-3 are comments.

## Reproduction

```
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd .claude/worktrees/s11a-mailer/server        # at 22cd99c9
node -e '<Invite.maskEmail over 6 shapes>'
node -e '<supportedFields length; smtp_* in publicFields; verified_hash writable>'
grep -n "whenMailing" -A6 utils/middleware/requestControls.js
grep -n "bodyParser.json\|app.use(\"/api\"" index.js        # 81 before 103
cd ../../pr78/server && grep -n "\b23\b" __tests__/api/managerForbiddenKeysHttp.test.js __tests__/endpoints/managerAllowedFieldsDrift.test.js
```

Read-only: the worktree was checked out at this SHA; nothing modified.

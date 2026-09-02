# Techlead-1 review — #80 `35c91ab0` (Dev3, `approof/s11a-mailer`) — **NOT MERGEABLE**

Step 4 driver review. Diff is 14 files / +1362 −35 against `merge-base approof/main`:
driver + errors + fixture SMTP server + `smtpDriver.test.js` (340 lines) +
`inviteExpiryHttp.test.js` (250) + migration 093000 + `Invite.create/get/markClaimed`
+ `User.validateNewCredentials` + `nodemailer@7.0.10`.

Per §7.14 I ran no suites — only in-process probes driving the real driver against the
real fixture. Every claim below is measured; transcripts under Reproduction.

**One security finding and two contract gaps.** Everything else is good, and some of
it is better than the recon asked for.

---

## FINDING-1 (security) — `allowInsecure` makes two different decisions, and an operator only consents to one

`_transport()`:

```js
tls: this.allowInsecure ? { rejectUnauthorized: false } : undefined,
```

Measured:

```
secure=true  allowInsecure=true   -> rejectUnauthorized = false
secure=true  allowInsecure=false  -> tls = undefined        (Node defaults: validated)
```

The flag is named, documented, and *tested* as "I accept plaintext on a trusted
link" — `_assertTransportAllowed` is the only place the suite exercises it. But it
also silently disables **certificate validation on TLS connections**. The sequence
that bites: an operator points the mailer at an internal relay on port 25, ticks
"allow insecure" because the link is inside the network, later moves to a TLS relay
and sets `secure: true`. They believe they upgraded to an encrypted, authenticated
channel. They have an encrypted channel that accepts any certificate — an on-path
attacker terminates it and reads the SMTP password in AUTH PLAIN.

That inverts the file's own rule #1 ("the password never leaves the transport"): the
transport is exactly where it goes, and this makes the transport untrustworthy under
a setting the operator understood to be about something else.

The comment concedes the coupling — *"The fixture and most internal relays present no
usable certificate. Only reachable once insecure transport was explicitly accepted
above"* — but "reachable only after another consent" is not the same as "consented
to". S3's own precedent is the argument against it: plaintext is refused unless
explicitly accepted, per *decision*, not per *category of laxity*.

**Fix:** split the flag. `allowInsecureTransport` (plaintext, what the tests already
assert) and `allowUntrustedCertificate` (TLS without validation, defaulting off,
needed only by the fixture). Two settings, two consents. The fixture passes the
second explicitly; no production path gets it by having answered a different
question. Add the test that is missing either way: `secure: true` with the plaintext
allowance set must still validate certificates.

## FINDING-2 (contract) — `notificationId` idempotency is specified in two places and implemented in none

Recon §2: *"seam 6 makes `notificationId` the idempotency key across retries … deriving
`notificationId` from the event id makes the two agree instead of competing — worth
stating in the driver, because a second independent key is how the same mail gets sent
twice."* Recon §7 lists it as a case the fixture must make reachable: *"duplicate
`notificationId` returns the existing delivery rather than sending twice."*

Measured against the real fixture:

```
two sends, identical notificationId "n-1"
  messages at relay = 2        (expected 1)
  same deliveryId?  = false    (expected true)
```

`_accepted` is keyed by `deliveryId` — which comes back **from the relay** after the
send — so it can only ever answer "did I already send this?" *after* sending it
again. The map is the wrong index for the job it was named for. No test in
`smtpDriver.test.js` sends the same `notificationId` twice.

This is not cosmetic under S11: `event_deliveries` retries on backoff, so the first
real retry of a transient failure that actually reached the relay mails the invite a
second time. Key `_accepted` by `notificationId`, return the stored
`{deliveryId, acceptedAt}` on a repeat, and assert `fixture.messages` has length 1.

## FINDING-3 (contract) — `retryAfterMs` is documented as the point of the class and never set

`errors.js` on `NotificationUnavailableError`: *"Carries `retryAfterMs` when the
server named one — honouring it is the difference between backing off and being
blocked."* The recon repeats it: *"temporary failure (4xx) → retryable with
retry-after."* The constructor accepts it. `_classify` never passes it:

```
4xx from the fixture -> NotificationUnavailableError  retryable=true  retryAfterMs=undefined
```

Either parse it from the relay's response and pass it, or delete the field and the
two comments that promise it. A documented capability nobody supplies is worse than
an absent one — a future `CoreJobWorker` reading `error.retryAfterMs` gets `undefined`
and silently falls back to its own backoff, which is the behaviour the comment says
is wrong.

---

## NIT-1 — the driver renders the message, which seam 6 says it must not

```js
subject: notification?.subject ?? "You have been invited",
text: notification?.data?.inviteUrl ?? notification?.text ?? "",
```

The file's own header says *"It is handed a finished notification and puts it on the
wire"*, and seam 6 forbids a driver from deciding what the message says. This one
supplies an invite-specific default subject and reaches into `data.inviteUrl` to
build a body. That is the template service's job, and §5's scope includes it — so
this is a seam that has not been drawn yet rather than one that was crossed
deliberately. Note it in the plan so the template lane removes these two lines rather
than growing a second copy of them.

## NIT-2 — header injection is closed by nodemailer, and nothing pins that

Probed `fromName: "App\r\nBcc: attacker@evil.example"` and
`subject: "Hi\r\nX-Injected: yes"`. Neither injected: nodemailer quotes the display
name and folds CRLF to a space —

```
From: App Bcc:"evil@evil.example" <no-reply@example.com>;
Subject: Hi X-Injected: yes
RCPT TO: ["<a@b.example>"]     <- one recipient, no Bcc
```

Safe today, and the safety belongs entirely to a dependency. `fromName` will be an
operator-writable `system_settings` value once the config lane lands, which makes it
attacker-adjacent input the moment a manager can write it. One test asserting a CRLF
`fromName` produces exactly one RCPT and no `Bcc:` header costs two lines and pins
the property to this repo rather than to nodemailer's changelog.

## NIT-3 — `_accepted` grows without bound

One entry per successful send, never evicted, for the process's life. Five sends →
five entries, confirmed. Harmless at invite volume; worth a cap or a TTL when the
same driver instance serves a queue. Mentioning it because FINDING-2's fix makes the
map load-bearing rather than incidental.

---

## What is right, and is worth keeping

- **The fixture is the real thing.** No `jest.mock("nodemailer")` anywhere in the
  suite, a real socket, and a transcript both halves of QA-3's ruling 4 assert
  against: the link *did* cross the wire (`messages[0].data` contains it) and the
  password reaches neither `console` nor an error message — in **both** literal and
  base64 forms. Checking `SMTP_PASSWORD_ENCODED` is the detail that makes it real:
  AUTH PLAIN is where a raw-conversation dump would leak, and a grep for the literal
  would have missed it. The dotless `greetingHost` for the same reason is exactly
  right.
- **`status()` cannot return `delivered`**, and the third test asserts it across
  every path rather than trusting the two happy cases — the correct shape for a
  negative property.
- **`validateConnection` answers with data, not an exception**, and I confirmed it
  refuses plaintext before connecting: `{ok:false, details:{reason:"NotificationConfigurationError"}}`,
  no credential in `details`.
- **`markClaimed` is now conditional** (`updateMany` with `status:"pending"` and the
  expiry re-checked in the WHERE, `count !== 1` → refusal). That closes a
  double-claim race that predates #80, and the route treats a lost race as a refusal
  rather than reporting success on an account that owns nothing.
- **My pre-read FINDING-3's shape is answered**: `User.validateNewCredentials` runs
  *before* `Invite.get`, and every post-lookup failure collapses to one refusal
  string, so a taken username no longer proves a code was live.
- **Migration 093000 is right about defaults**: both columns nullable, `expiresAt`
  with no column DEFAULT, and the comment states why — a default would retire every
  pre-existing invite at deploy time. `Invite.create` refuses `email` without an
  expiry, enforced at the one function both creation routes pass through.

## Scope note

This SHA carries **no route change**: `email` is not accepted by either
`/admin/invite/new` or `/v1/admin/invite/new` yet (`git diff` touches only
`endpoints/invite.js`). So my pre-read FINDING-3 (`email` leaking into both
`invite.read` listings) and FINDING-4 (neither create route is rate limited) are not
yet reviewable — they land with the route lane, and both must be checked there.

## Verdict

**NOT MERGEABLE** on FINDING-1. FINDING-2 and FINDING-3 are items from the issue's
own contract list and should land in the same SHA; NIT-1 belongs to the template
lane, NIT-2 and NIT-3 are cheap and can ride along.

## Reproduction

```
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd .claude/worktrees/s11a-mailer/server
node -e '<startSmtpFixture + two sends with the same notificationId>'   # 2 messages, 2 ids
node -e '<mk({secure:true,allowInsecure:true})._transport().options.tls>'  # rejectUnauthorized:false
node -e '<fail:"temporary" send, inspect error.retryAfterMs>'          # undefined
node -e '<fromName/subject CRLF, print messages[0].data and .to>'      # folded, one RCPT
```

Read-only: nothing in the worktree was modified.

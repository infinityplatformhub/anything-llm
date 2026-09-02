# QA-3 evidence — #80 S11a pre-review on `0e223c69`

Author: QA-3 (anything-llm-ea). Worktree `/tmp/qa3-80`, read-only. The redaction
probes below ran against the real `redactEventData` on this SHA — which already
carries #71's credential pattern (`/apw-[a-z]{3}-[A-Za-z0-9_-]{16,}/g`).

## 1. Nothing in the system redacts an SMTP password

#71 closed the credentials **this system issues**. An SMTP password belongs to
someone else's mail provider, has no shape to match, and is therefore not covered
by anything. Measured:

```
LEAKS  plain password under `name`
       out={"name":"Sup3rSecret!Mail#2026"}                       hits=[]
LEAKS  Google app password
       out={"name":"abcd efgh ijkl mnop"}                          hits=[]
LEAKS  password in a sentence under `reason`
       out={"reason":"auth failed for mailer with Sup3rSecret!..."} hits=[]
LEAKS  password nested in changes
       out={"changes":{"smtp":"none => Sup3rSecret!Mail#2026"}}     hits=[]
```

### The connection-URL case is worse than a plain leak

A URL carrying inline credentials sometimes survives and sometimes does not, and
the reason it survives has nothing to do with passwords:

```
clean  smtps://mailer:Sup3rSecret@smtp.example.com:465  ->  smtps://mailer:[redacted:email]:465
clean  smtps://mailer:Sup3rSecret@10.0.0.5:465          ->  smtps://mailer:[redacted:email]:465
LEAKS  smtps://mailer:Sup3rSecret@smtp:465              ->  unchanged
LEAKS  smtps://mailer:Sup3rSecret@localhost:1025        ->  unchanged
```

The PDPA **email** pattern is matching `mailer:Sup3rSecret@smtp.example.com`,
because that substring looks like an address. When the host has no dot — a Docker
service name, `localhost`, a dev fixture — the pattern does not fire and the
password goes to disk in full. So the two "clean" rows are accidents, not
protection: the same value is redacted or not depending on whether the hostname
happens to contain a period.

**Consequence for #80:** the driver must be structurally prevented from putting
the password anywhere near a log or an event, and the tests must assert that
directly. Adding a pattern is not available as a fix — a free-form password has
nothing to match on. Three channels need asserting with a real password value
present: `console.log`/`console.error` output, `event_logs` rows, and the HTTP
response body.

## 2. Invite links in mail bodies

#71's pattern does cover a real invite code inside a URL, and that is proven in
`qa3-71-cfaadf32.md`. The trap for S11 is test construction: a literal like
`apw-inv-AAAA` is under the `{16,}` bound and passes through untouched, so a test
written with a short fake code proves nothing. Use a code from `Invite.create`.

## 3. Expiry has two enforcement points, not one

`invites` today: `id, code, status, claimedBy, workspaceIds, createdAt,
createdBy, lastUpdatedAt`. No `expiresAt`.

`Invite.get({code})` is called from `endpoints/invite.js:16` (GET) and `:40`
(POST), and both gate on `status !== "pending"` only. Enforcing a new `expiresAt`
at those two call sites leaves the third one — S11 adds resend and preview paths —
to be forgotten. The check belongs in `Invite.get`, where every reader passes.

## 4. `markClaimed` is not atomic, and S11 widens the window

`POST /invite/:code` runs `Invite.get` → `User.create` → `Invite.markClaimed`
with no lock across them. Two concurrent redemptions of one code create two
accounts; the second `markClaimed` overwrites the first.

Low risk today, because a code travels by hand. S11 mails the link: mail clients
prefetch URLs, and forwarding an invite to a colleague is ordinary behaviour. The
same defect starts being exercised.

The fix is shaped like the one already used elsewhere in this codebase — claim
the row first, then act on the result:
`updateMany({where: {id, status: "pending"}, data: {status: "claimed"}})` and
proceed only when `count === 1`.

Not #80's scope. Noted the way #71 was: S11 is what makes it matter.

## 5. `secret: true` is the right mechanism, and the test must not check the table

`dumpENV` builds `protectedKeys` as
`Object.values(KEY_MAPPING).filter(v => v.secret !== true).map(v => v.envKey)`
(`updateENV.js:1935-1937`), so a `secret: true` entry drops out of `.env`
automatically. `CredentialStore.set` binds the AAD to the `envKey`
(`credentialStore.js:78`), so a value stored under one key cannot be decrypted as
another.

A test asserting `KEY_MAPPING.SMTP_PASSWORD.secret === true` passes while the
pipeline is broken. The test that means something: set the password, run
`dumpENV`, read the `.env` file, assert the value is absent from it.

## 6. `status()` — the seam permits `delivered`, so assert the driver, not the type

Seam 06 declares `status: "queued"|"delivered"|"failed"|"unknown"`. `delivered`
is contract-valid; the ruling is that this driver must never return it, because a
250 means the next hop accepted the message, not that a mailbox received it.

A single test showing `queued` on the happy path does not establish that. Every
reachable path must be asserted: 250 accepted, auth failure, 4xx, 5xx, connection
refused, and a duplicate `notificationId`. None may answer `delivered`.

## 7. Fixture shape

The ruling is a real SMTP fixture, not a mocked `nodemailer`, so that assertions
can be made about what crossed the wire. To make that usable, the fixture should
retain the raw conversation — every line the client sent — and each test should
assert on both sides at once:

- **positive:** the body that reached the relay contains the real invite link
- **negative:** captured `console` output and `event_logs` contain neither the
  password nor the link

Both in the same test. Split apart, the negative half passes trivially whenever
nothing was sent at all.

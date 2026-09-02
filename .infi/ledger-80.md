# Ledger — #80 (S11a): mailer seam, invite email and expiry

Branch `approof/s11a-mailer`, worktree `.claude/worktrees/s11a-mailer`, cut from
`origin/approof/main`, bootstrapped with `scripts/wt-bootstrap.sh s11a_mailer`.

| SHA | what |
|---|---|
| `5ac9facf` | the four NITs carried from #77 and the mockup review |
| `85617c79` | migration 093000, expiry in `Invite.get`, the O1 oracle, OBS-1 |
| `35c91ab0` | driver, fixture SMTP server, errors |
| `37712d41` | TL-1 F1/F2/F3 and the header NITs |
| `503916b0` | QA-1's two leaks, the save gate's fingerprint |
| `719b7eee` | the route lane — mailing an invite |
| `22cd99c9` | settings routes, save gate, listing mask, limiter mount |

## Rulings

Ruling: `expiresAt` has NO column default. If wrong, nothing — the default lives
in `Invite.create` and is testable there. The other way round, the migration
would have retired every invite already in the table at deploy time, each one
failing indistinguishably from a code that was never real.

Ruling: expiry is enforced inside `Invite.get`, returning null. If wrong,
`deactivate` and the listings need their own handling — they already have it,
because they read the table directly and should. The alternative was a third copy
of the check per route, and the two byte-identical copies already in
`endpoints/invite.js` are the evidence that copies get missed.

Ruling: `email` implies `expiresAt`, enforced in `Invite.create`. Both creating
routes come through that function, so it is the only place that sees every
creation.

Ruling (QA-1 O1): every redemption failure past the lookup returns one body, and
caller-fixable input is validated BEFORE the lookup. The oracle it closes:
reaching `User.create` proved the code was valid and pending, so a username
collision answered differently from an unknown code.

Ruling: `User.validateNewCredentials` is pure BY REQUIREMENT. It runs before any
lookup, so it must not read a row, and must never report that a username is
TAKEN — that is a fact about the database and belongs behind the flat refusal.

Ruling (TL-2 OBS-1): `markClaimed` is a conditional `updateMany`, `count === 1`
the answer. Unconditional, the route's read-create-claim spans three awaits and
both racers win.

Ruling: a REAL fixture SMTP server, never `jest.mock("nodemailer")`. Mocking the
transport removes the wire, and the wire is where the property lives.

Ruling: connection config is separate fields, never a URL. A URL carries the
credential as one string, and QA-3 measured that the redaction email pattern
needs a `.` in the host — so `smtps://user:pass@smtp` and `@localhost` leak in
full while an FQDN is scrubbed by accident.

Ruling: tests use a DOTLESS host as the primary case, so a leak cannot be hidden
by that same coincidence.

Ruling: `status()` returns `queued` or `unknown`, never `delivered`. A 250 means
the next hop accepted the message.

Ruling: the transport's own error message is never propagated — it quotes the
failing command, and AUTH is a command.

Ruling (TL-1 F1): plaintext and untrusted certificates are SEPARATE consents. One
flag meant accepting "plaintext is fine on our LAN" also disabled certificate
validation for every TLS connection — the case where the certificate is the only
thing identifying the far end.

Ruling (TL-1 F2): `notificationId` is the idempotency key, and only SUCCESSFUL
sends are remembered. Recording failures would turn one outage into permanent
silence, which is what the queue's retry exists to prevent.

Ruling (TL-1 F3): `retryAfterMs` is REMOVED rather than declared. SMTP has no
standard way to say "come back in N seconds", and `CoreJobWorker` falls back
silently — the field would look respected while being undefined everywhere.

Ruling: `persistCredential` returns its error as well as logging it. Existing
callers ignore it and keep their behaviour; the mailer save path must not,
because a verified hash written after a failed persist claims a credential the
next boot cannot find.

Ruling: `updateENV.js:1655` is NOT reordered. Considered and rejected —
`persistCredential` cannot throw (`CredentialStore.set` catches and returns), the
log line states the intent outright ("live for this process but was not
persisted"), and reversing it would leave a failed persist with the credential
neither stored nor live, stopping a working provider while the UI reports
success. No RED could be written for the reported symptom, which was the tell.

Ruling (ruling A): the mailer routes sit behind `system.write`, not
`settings.write`. They carry a relay credential and open an outbound connection
to a caller-named host.

Ruling (ruling B): the save gate refuses BEFORE writing either table, and the
hash is HMAC over the config AND the plaintext password. Unkeyed, a digest over a
host, port and username is precomputable — anyone able to write one settings row
could forge a "verified" marker for a configuration nobody tested. Including the
password means rotating it invalidates the proof.

Ruling (ruling D): mailing requires `user.manage`; `invite.create` alone keeps
copy-link. One address per request. Channel off or unverified with an address is
a 4xx, never a silent 200.

Ruling: `/v1/admin/invite/new` REFUSES an address rather than ignoring it. The
API-key scope vocabulary has no `user.manage` — it stops at `user.read` and
`user.write` — so a key cannot demonstrate the permission the rule requires and
there is no honest gate. Silently dropping the field would return 200 for an
invitation nobody sent. Adding such a scope is a product decision, not this
issue's.

Ruling (TL-1): the recipient address is MASKED in both listings unless the caller
holds `user.manage`. This branch created the exposure: `invites.email` was always
null before, so returning whole rows was harmless. `/v1` never unmasks — an API
key cannot hold that permission, and fail-closed is the honest default.

Ruling (QA-2): the mail limiter is mounted on the REAL route, and only for
requests carrying an address. A copy-link invite costs a database row and touches
no relay; throttling it would slow ordinary admin work to protect a resource it
never uses.

Ruling (TL-1 OBS-2, corrected per C5): `actorKey` decodes the session `id`
without verifying it. The safety comes from `validatedRequest` rejecting forged
tokens before any handler — NOT from a property of the limiter. If this limiter
is ever mounted on a route without that middleware, the reasoning does not hold.

Ruling (ruling E): the mailer's non-secret settings join `supportedFields`.
`updateSettings` silently drops unknown labels, so without this the save route
wrote nothing and then 409'd against its own missing hash.

## What testing found that reading would not

**AUTH PLAIN base64-encodes the credential** (RFC 4954). The first
password-leak test asserted the literal string on the wire and failed. A leak
check greping the literal would miss the encoded copy a raw-transcript log emits.
Both forms are now asserted against every log surface.

**Quoted-printable wraps long lines.** Asserting the invite code against a raw
message body fails on a perfectly correct message; the test decodes soft breaks
first.

**No seeded role holds `invite.create` without `user.manage`.** The permission
test would have passed before the rule existed, because a lesser role is refused
by the middleware first — green, proving nothing. It needed a purpose-built
grant.

**`nodemailer` quotes an injected address inside the display name**, where it is
inert. The CRLF test originally asserted the string was absent, which would fail
against correct behaviour; it now asserts no new header line and no second
envelope recipient.

**Suites contend on `prisma migrate deploy`.** In parallel, three suites fail to
LOAD with zero test failures. The contract runs `--runInBand`.

## Mutation proof

| mutant | result |
|---|---|
| expiry removed from `Invite.get` | 2 failed |
| `expiresAt: null` read as expired | 3 failed, incl. copy-link regression |
| `markClaimed` unconditional | 2 failed |
| `<` for `<=` on expiry | **survived — equivalent** |
| `jest.mock("nodemailer")` | absent by construction |
| driver logs the body | 1 failed |
| credential interpolated into the error | 1 failed |
| `status()` claims delivered | 2 failed |
| plaintext without consent | 1 failed |
| TLS flags recoupled | 2 failed |
| idempotency disabled | 1 failed |
| `SMTP_PASSWORD` `secret: false` | 1 failed |
| `user.manage` gate removed | 1 failed |
| `isVerified` skipped | 1 failed |
| **limiter mount removed** | 1 failed |
| **UI listing unmasked** | 2 failed |
| **`/v1` listing unmasked** | 2 failed |
| **key deleted from `SETTING_KEYS`** | 1 failed (after GAP-1; 0 before) |
| **invite code prefix changed** | 2 failed |

`<` versus `<=` is a genuine equivalent mutant: they differ only when `expiresAt`
equals `now` to the millisecond, which needs frozen time to reach. Recorded as
surviving rather than killed by a test that would prove nothing.

## Residual risks

- No `$transaction` spans `system_settings` and `credential_store`. The save path
  orders the writes so the credential lands first and the hash last, but a crash
  between them leaves settings saved and unverified — which fails closed.
- Mailing an invite through the API is not possible until a `user.manage`-class
  scope exists. A product decision, recorded on the issue.
- Codes already exported in an audit feed before #71 cannot be recalled.

## Evidence

Contract: `inviteExpiryHttp` + `inviteCodeAuditHttp` + `inviteCreate` +
`__tests__/security/notifications/` + `requestControlsHttp` +
`credentialPersistence`, `--runInBand` — Tests: 122 passed, 122 total, 9 suites.

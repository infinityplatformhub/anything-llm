# Ledger — #80 (S11a): mailer seam, invite email and expiry

Branch `approof/s11a-mailer`, worktree `.claude/worktrees/s11a-mailer`, cut from
`origin/approof/main`. Bootstrapped with `scripts/wt-bootstrap.sh s11a_mailer`
(§7.6c — fresh deps, fresh DB, migrate, seed, generate).

Commits so far: `5ac9facf` (NITs), `85617c79` (steps 2+3), `35c91ab0` (step 4).

## Steps

1. NITs carried from #77 and the mockup review — **done**
2. Migration 093000, `invites.email` + `expiresAt` — **done**
3. Expiry in `Invite.get`, O1 oracle, OBS-1 conditional claim — **done**
4. Mailer seam: errors, fixture SMTP server, `SmtpNotificationDriver` — **done**
5. Route + ingress validation — **pending scope answer (rulings A, D)**
6. Backend save-gate bound to a config hash — **pending scope answer (ruling B)**

## Rulings

Ruling: `expiresAt` has NO column default. If this is wrong, nothing — the
default lives in `Invite.create` and is testable there. If it were wrong the
other way, the migration would have retired every invite already in the table at
deploy time, and each one would fail indistinguishably from a code that was never
real. Same reasoning as #71's: the failure mode is silent.

Ruling: expiry is enforced inside `Invite.get`, which returns null. If this is
wrong, `deactivate` and the admin listings would need their own handling — they
already have it, because they read the table directly and should: "can this be
redeemed" and "does this row exist" are different questions. The alternative was
a third copy of the check at each route, and the two byte-identical copies
already living in `endpoints/invite.js` are the evidence that copies get missed.

Ruling: returning null for an expired invite is also the non-disclosing answer.
Not a happy accident — it is the same response an unknown code receives, so the
endpoint cannot be asked "was this code ever real?".

Ruling: `email` implies `expiresAt`, enforced in `Invite.create`. If this is
wrong, a route could create a mailed invite with no expiry; it cannot, because
both creating routes come through this function and it is the only place that
sees every creation. A CHECK constraint would also be right and is not a
substitute — the model is what supplies the value.

Ruling (QA-1 O1): every redemption failure past the lookup returns one body, and
caller-fixable input is validated BEFORE the lookup. If this is wrong, a user
retypes a password that can never be accepted with no explanation. The oracle it
closes: reaching `User.create` at all proved the code was valid and pending, so a
username collision answered differently from an unknown code — confirming a live
invite to anyone willing to guess, without redeeming it.

Ruling: `User.validateNewCredentials` is pure BY REQUIREMENT, not by accident. It
runs before any lookup, so it must not read a row, and it must never report that
a username is TAKEN — that is a fact about the database and belongs behind the
flat refusal. Stated in its docstring so the next person to extend it knows the
constraint is load-bearing.

Ruling (TL-2 OBS-1): `markClaimed` is a conditional `updateMany` on status and
expiry, with `count === 1` as the answer. If this is wrong we pay one extra
`findUnique` per claim. If it were left unconditional, the route's
read-create-claim spans three awaits and both racers win: two accounts from one
invite, the second silently overwriting the first's `claimedBy`.

Ruling: the route now checks `markClaimed`'s result. Found while making the claim
conditional — it previously ignored it. Losing a race would create the user but
grant none of the workspaces the invite promised, and answering `success: true`
there is a lie about access.

Ruling: a REAL fixture SMTP server, never `jest.mock("nodemailer")` (M6). If this
is wrong we carry ~150 lines of fixture. Mocking the transport removes the wire,
and the wire is where the property lives: this suite asserts what reached the
relay against what reached a log, and a mock answers neither honestly.

Ruling: connection config is separate fields — host, port, secure, username —
never a URL. If this is wrong, an operator who thinks in connection strings has
to decompose one. A URL would carry the credential as a single string, and QA-3
measured that the audit redaction's email pattern needs a `.` in the host, so
`smtps://user:pass@smtp` and `@localhost` leak in full while an FQDN is scrubbed
by accident. A shape that cannot hold a credential cannot leak one.

Ruling: tests use a DOTLESS host as the primary case. If this is wrong, nothing.
Using an FQDN would let the accidental pattern match hide a real leak — the test
would pass because of a coincidence rather than because the driver is correct.

Ruling: `status()` returns `queued` or `unknown` and never `delivered` (M8). If
this is wrong an operator gets less information than the protocol could give.
SMTP's 250 means the next hop accepted the message; a driver claiming delivery is
trusted while mail bounces two hops away, which is worse than admitting the
protocol does not know.

Ruling: the transport's own error message is never propagated. If this is wrong,
an operator loses the relay's wording and reads `cause` instead. nodemailer
quotes the failing command, and for an auth failure that command IS the encoded
credential.

## What testing found that reading would not

**AUTH PLAIN base64-encodes the credential** (RFC 4954). The first version of the
password-leak test asserted the literal string appeared in the transcript and it
failed — the wire carries `\0user\0pass` base64-encoded. That matters beyond the
test: a leak check greping for the literal password would miss an encoded copy,
which is exactly what a driver dumping a raw SMTP conversation into a log emits.
Both forms are now asserted against every log surface.

## Mutation proof

| step | mutant | result |
|---|---|---|
| 2+3 | M1: expiry removed from `Invite.get` | 2 failed (expiry + GET oracle) |
| 2+3 | M3: `expiresAt: null` read as expired | 3 failed, incl. copy-link regression |
| 2+3 | OBS-1: unconditional `update` | 2 failed (race + expired claim) |
| 2+3 | **M2: `<` for `<=`** | **survived — equivalent** |
| 4 | M6: `jest.mock("nodemailer")` | absent by construction |
| 4 | M7: log the body on failure | 1 failed (invite-link test) |
| 4 | M7b: interpolate the credential into the error | 1 failed (auth-leak test) |
| 4 | M8: `status()` claims delivered | 2 failed (both status tests) |
| 4 | M10: plaintext without consent | 1 failed |

M2 is a genuine equivalent mutant: `<` and `<=` differ only when `expiresAt`
equals `now` to the millisecond, which needs frozen time to hit. Recorded as
surviving rather than killed by a test that would prove nothing.

## Rulings received, not yet implemented (A–E, TL-1 pre-read)

Scope question raised with PMO before starting: three of these reach outside the
mailer.

- **A** mailer save/test route sits behind `system.write`, not `settings.write`.
- **B** verified-hash = HMAC(SIG_KEY, envKey + plaintext + non-secret fields);
  the gate refuses before writing either table; `process.env` is set only AFTER
  `persistCredential` resolves. That last part is a real pre-existing bug —
  `updateENV.js:~1655` sets it before the await, so a failed write still mutates
  the environment. No `$transaction` spans the two tables; that goes to
  residual-risks.
- **C** admin invite listings mask the address unless the session holds
  `user.manage`; `email`/`recipient` must NOT be added to the audit allowlist.
- **D** invite-by-email is rate limited per key/org rather than per IP, requires
  `user.manage` (plain `invite.create` stays copy-link), accepts one address per
  request, and returns 4xx — never a silent 200 — when the channel is off.
- **E** SMTP non-secret fields join `supportedFields`; #78's forbidden-count test
  must assert a set relation rather than a hardcoded number (needs Dev1).

## Evidence

Contract (posted on the issue, replacing `placeholder`):
`__tests__/api/inviteExpiryHttp.test.js` + `__tests__/security/notifications/smtpDriver.test.js`
+ `__tests__/requestControlsHttp.test.js` — Tests: 36 passed, 36 total.

Per §7.14 this branch runs the named suites only; the full run is the gate's.

`nodemailer@7.0.10` is now a direct dependency of `server/`, pinned exactly. It
previously existed only in `collector/yarn.lock` as a transitive of `mailparser`
(inbound parsing), which is not a transport the server could use.

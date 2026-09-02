# Techlead-2 review — #80 (S11a) route lane `719b7eee`

**Verdict: PASS**, with three gaps recorded — all three are missing tests, not wrong code,
and each has a named consequence if it later regresses. Eleven mutations run, eight caught.

Independent worktree `/tmp/tl2-80b` (`git worktree add --detach`), `node_modules`
hardlink-copied from `/tmp/qa1-80` (it carries `nodemailer`, which this slice adds), `prisma
generate` run, Node v22.23.1, my own PostgreSQL 16 on `:55472`. Per §7.14 no full-directory
run — only the four suites this slice adds, plus mutations against them. Worktree clean; all
four mutated files restored from backups.

Baseline: **61 passed, 61 total**, `--runInBand`.

---

## The design decisions, checked against the code

**Ruling D — mailing is a second capability, and it is enforced before the invite exists.**
`endpoints/admin.js` resolves the address, checks `user.manage` against `orgResource()`, and
calls `assertChannelReady()` **before** `Invite.create`. The comment states the reason:
*"a created-but-unsent invite is a code an admin cannot see and did not ask for."* That is
the right ordering, and it is the one my OBS-1 argument on the earlier stage was about —
refusals belong before the state change, not after it.

**`/v1` refuses rather than ignores.** The scope vocabulary stops at `user.read`/`user.write`,
so an API key cannot demonstrate `user.manage`; the route answers 400 and says so. Dropping
the field silently would have been worse — a 200 that invited nobody — and the comment says
exactly that.

**The config hash includes the plaintext password.** This is the one I raised as OBS-3 on the
recon (the hash must treat "no credential" as part of the configuration). The implementation
goes further than I asked: the password *value* is an input, not merely its presence, so a
rotated credential invalidates the proof. It is HMAC-keyed with `SIG_KEY` rather than a bare
digest, with the reason recorded — host, port and username are guessable, so an unkeyed digest
could be precomputed and written into `system_settings` to forge a "verified" marker. The
comparison is `timingSafeEqual` behind a length check.

**`isVerified` is checked at send time, not only at save time.** Settings can be written by
another path, so a save-time-only gate is defeated by anything else writing a row.

**`notificationId` is `invite:<id>:<address>`** — my OBS-5 (fan-out collision) is handled: the
recipient is in the key, so one event to two people is two messages.

**No `jest.mock("nodemailer")` anywhere.** The fixture is a real SMTP server on an ephemeral
socket (`__testHelpers__/smtp/server.js`) that keeps the raw transcript, and its header states
why: a mock removes the wire, and the property under test is what crossed the wire versus what
reached a log. It models 535 / 451 / 550 / mid-session drop so the four error classes are
distinguished by behaviour rather than by assertion.

## Mutation results

| # | mutation | result |
|---|---|---|
| M4 | config hash drops the password | **2 failed** |
| M4b | hash drops `smtp_allow_untrusted_cert` | 0 failed — **GAP-1** |
| M4c | HMAC → plain SHA-256 (forgeable marker) | **1 failed** |
| M5 | send-time verification removed | **1 failed** |
| M5b | `isVerified` fails OPEN when `SIG_KEY` is missing | **1 failed** |
| M-D1 | `user.manage` check removed from the mail path | **1 failed** |
| M-D2 | `/v1` silently drops the email instead of 400 | 0 failed — **GAP-2** |
| M-D3 | an array of addresses accepted (bulk mailer) | **1 failed** |
| M-D4 | `notificationId` drops the recipient | 0 failed — **GAP-3** |
| M-D5 | mail failure answered as success | 0 failed — **GAP-3b** |
| M-D6 | `assertChannelReady` skipped before create | **2 failed** |

M5b is the one I am most glad to see caught: a `catch` that returns `true` turns a missing
`SIG_KEY` into "everything is verified", and the code's own comment says fail-closed. It is
tested rather than asserted.

## GAP-1 — `smtp_allow_untrusted_cert` is in the hash but nothing proves it

Removing that key from `SETTING_KEYS` leaves 61/61 green. The field is in the list with a good
comment (TL-1 OBS-1: turning off certificate validation changes what the configuration means,
so a proof taken before it was turned off no longer describes the configuration) — but no test
verifies a hash a change to that field.

Consequence if it regresses: an operator verifies a configuration with certificate validation
ON, then turns it off, and the "verified" marker survives — which is precisely the scenario
the separate consent exists to prevent. The other connection fields are covered; this one is
in the list on trust.

One test: hash a settings object, flip `smtp_allow_untrusted_cert`, assert the digest changed.
A table over every entry of `SETTING_KEYS` would close the whole class rather than this
instance — the same shape as the dialect table on #30.

## GAP-2 — the `/v1` 400 has no test

Disabling the guard entirely (`if (false)`) leaves 61/61 green. Grep confirms no test hits
`POST /v1/admin/invite/new` with an `email` field; `routeScopes.test.js` only asserts the
route's scope name.

Consequence: the refusal reverts to a silent drop, and an API caller gets a 200 believing
someone was invited. That is the exact failure the comment says it is avoiding, and it is the
only guard here with no assertion behind it.

## GAP-3 — the admin route's own behaviour is untested past the happy path

Two mutations survive together and share a cause:

- `notificationId` dropping the recipient (M-D4) — the idempotency test lives in
  `smtpDriver.test.js` and passes its own ids, so the *construction* of the key in
  `inviteMailer.js` is never exercised.
- mail failure answered as `error: null` (M-D5) — no test drives a send failure through
  `POST /admin/invite/new`.

Both are route-level behaviour. `inviteMailRoutes.test.js` covers the happy path, the
`user.manage` refusal, the request-shape refusals, the channel-off and unverified refusals,
and the two log-leak assertions — thorough on refusals, silent on what happens when the mail
attempt itself fails after a successful create.

Consequence for M-D5 specifically: the admin sees success, waits for someone who was never
contacted, and the invite quietly expires in seven days. That is the failure the code's own
comment describes and it is the one not tested.

For M-D4: a fan-out would silently deliver one message instead of two. My OBS-5 asked for
"one event, two recipients, two messages" — that test is what would catch it.

## Also verified

- The invite code and the recipient address are both asserted absent from `event_logs`
  (two separate tests), which continues #71's rule that the allowlist does not grow for a new
  call site. The address is personal data and the audit row records *that* an invite was
  mailed, not to whom.
- The mail failure path logs `mailError.message`, never the error object — a transport error
  can carry the credential.
- `driverFromSettings` builds from stored settings only, never from request input.
- `smtp_allow_insecure` and `smtp_allow_untrusted_cert` are kept separate in the driver
  (`allowInsecureTransport` vs `allowUntrustedCertificate`), so accepting plaintext on a
  trusted network does not also mean believing an untrusted certificate.

## Reproduction

```
git worktree add --detach /tmp/tl2-80b 719b7eee
cp -al /tmp/qa1-80/server/node_modules /tmp/tl2-80b/server/node_modules
cd /tmp/tl2-80b/server && npx prisma generate
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" STORAGE_DIR=$(mktemp -d) \
       SIG_KEY=$(openssl rand -hex 32) SIG_SALT=b API_KEY_PEPPER=$(openssl rand -hex 32) \
       DATABASE_URL="postgresql://postgres:pw@127.0.0.1:55472/t5"
npx jest __tests__/security/notifications/ __tests__/models/inviteCreate.test.js --runInBand
```

`SIG_KEY` must be at least 32 characters or `configHash` throws by design. Mutations were
applied to working copies of `utils/notifications/{inviteMailer,mailerSettings}.js`,
`endpoints/admin.js` and `endpoints/api/admin/index.js`, each restored immediately after its
run.

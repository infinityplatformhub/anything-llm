# Recon — S11 SMTP/mailer (seam 6, first driver)

Read against `approof/s3-ldap` @ `b415aa08`. Read-only: no code changed.
Scope per PMO ruling: **driver + template service + invite only.**

## 1. What exists today

**No mail infrastructure at all.** No `nodemailer`, `@sendgrid/*`, `postmark`,
`resend`, or SES in any of the three `package.json` files; no `SMTP_*`/`MAIL_*`
in any `.env.example`; no `sendMail`/`transporter` in app code.

Two near-misses that are not a mailer: the Outlook agent skill calls Microsoft
Graph `/me/sendMail` on the *user's* behalf via OAuth
(`utils/agents/aibitat/plugins/outlook/lib.js:1295`), and `nodemailer@7.0.10`
appears in `collector/yarn.lock` only as a transitive of `mailparser` (inbound
parsing). Neither is a system transport, and neither is reusable here.

So S11 is greenfield on the transport, and **entirely non-greenfield on
everything around it** — which is the useful finding.

## 2. What S11 must plug into, not rebuild

| Need | Existing seam | Status |
|---|---|---|
| Queue + retry | `PostgresJobQueue` / `CoreJobWorker` (P0-6) | exists |
| Event trigger | `eventBus.subscribe({subscriberId, eventTypes, handler, maxAttempts})` | exists |
| Retry/backoff/DLQ | `event_deliveries` — exponential backoff, dead-letter, `@@unique([subscriberId, eventId])` | exists, free |
| SMTP password | `CredentialStore.set/get` (AES-256-GCM, AAD-bound) | exists |
| Non-secret config | `systemSettings.js` allowlists + validators | exists |
| Admin UI | `GeneralSettings/*` — 3-file wiring | exists |

`AuditEventSubscriber` registers as `eventTypes: ["*"]` (`utils/events/index.js:13`)
and is the pattern a mailer subscriber copies. **No new queue** (PMO ruling).

The idempotency stories line up: seam 6 makes `notificationId` the idempotency key
across retries, and `event_deliveries` is already unique on
`[subscriberId, eventId]`. Deriving `notificationId` from the event id makes the
two agree instead of competing — worth stating in the driver, because a second
independent key is how the same mail gets sent twice.

## 3. The blocking constraint: there is no address to send to

`users` has **no email column** — users are identified by `username`
(`schema.prisma:67+`). The only email in the schema is `identity_links.email`
(`:392`), and that model's own header says the identity is `provider + subject`,
**never** email: it is what an IdP asserted, not an address this system vouches
for or would accept mail bounces from.

`invites` likewise has no `email`, and no `expiresAt` — status moves only
`pending → claimed | disabled` (`:48-57`), so an unclaimed invite is redeemable
forever.

**Ruling (ก):** S11 sends only to an address supplied at the call site.
`recipient.type: "address"` is implemented; `recipient.type: "user"` throws
`NotificationContractError` until a verified `users.email` exists. That keeps the
driver inside seam 6's boundary — a driver "MUST NOT read app models to enrich
messages" — and it means S11 never has to answer who verified an address, whether
it syncs from the IdP, or whether a user may change it. Those belong to the
separate `users.email` issue, with a verification policy (backlog note).

## 4. Schema — slot 093000

```
invites.email     String?    -- nullable
invites.expiresAt DateTime?  -- default 7 days for mailed invites
```

Both nullable so the **copy-link flow keeps working unchanged when `email` is
null** (PMO ruling). A mailed invite must expire: a link sent to an inbox and
valid forever is a permanent bearer credential sitting in mail history, and
unlike the copy-link case nobody can say where it ended up.

### Where expiry has to be enforced (recon done, independent of the A/B choice)

Read the call sites rather than guessing. Every route reaches invites through
`Invite.*`, and nothing queries `prisma.invites` directly:

| site | call | validates status? |
|---|---|---|
| `endpoints/invite.js:16` (`GET /invite/:code`) | `Invite.get({ code })` | yes — `status !== "pending"` |
| `endpoints/invite.js:40` (`POST /invite/:code`) | `Invite.get({ code })` | yes — its own copy of the same check |
| `endpoints/admin.js:257`, `api/admin/index.js:309` | `whereWithUsers()` | no — listing only |
| `endpoints/admin.js:277`, `api/admin/index.js:365` | `create()` | n/a |
| `endpoints/admin.js:308`, `api/admin/index.js:436` | `deactivate(id)` | n/a |

So the redemption path has **two independent status checks, duplicated across two
routes** — and `Invite.get` itself validates nothing; it is a thin `findFirst`.

**Enforce expiry inside `Invite.get`, not at the routes.** A third copy of the
rule at each call site is a third place to forget it, and the existing
duplication is the evidence: the two checks are already byte-identical by
coincidence rather than by construction. A job that sweeps expired invites is
strictly worse on its own — between expiry and the sweep the link still works,
and that window is exactly when a leaked link gets used.

A job may still be wanted for tidiness (flipping `status` so the admin list shows
reality), but it must not be the thing redemption depends on.

Two consequences for the plan:

- `Invite.get` returning null for an expired invite means both routes report
  "not found or invalid" with no new branch — which is also the non-disclosing
  answer QA-3 asked for, since it is the same response an unknown code gets.
- The listing calls (`whereWithUsers`) deliberately keep showing expired rows.
  An admin needs to see that an invite expired unredeemed; that is not the same
  question as whether it can be redeemed.

**Note on the response shape** (QA-3): `POST /invite/:code` answers `200` with
`{success: false}` rather than a 4xx, deliberately — a status code is readable
without a body and would make the endpoint an oracle. Tests must assert the
BODY, not the status; asserting `expect(status).toBe(404)` here would fail
against correct behaviour.

## 5. What the driver is, and is not

Per `design/seams/06-notification.md`:

```js
static channelId()                    // "smtp"
static async validateConnection(cfg)  // → {ok, details}
async send(notification)              // → {deliveryId, acceptedAt}
async status({deliveryId})            // → {status, occurredAt}
```

Errors: `NotificationContractError` (non-retryable — bad recipient/template),
`NotificationConfigurationError` (auth/config failure; disables the channel),
`NotificationUnavailableError` (retryable, carries retry-after),
`NotificationRejectedError` (permanent provider rejection → delivery-failed event).

**`status()` returns `queued` or `unknown` — never `delivered`** (PMO ruling).
SMTP gives a 250 when the next hop accepts the message; that is not delivery to a
mailbox, and a driver that claims otherwise is worse than one that admits it does
not know, because an operator will trust it while mail is silently bouncing
downstream.

Boundaries that shape the tests more than the code: the driver decides no
recipients, reads no app models, and **logs no body, token, or invite link**.

## 5b. Saving a configuration requires a successful test (QA-3)

Mockup B shows a setup that cannot be saved until it has actually sent a message.
That gate must live in the **backend**, not in the wizard: the save endpoint is
reachable without the page, so a client-side check protects nobody.

The rule: the save endpoint refuses a configuration unless a successful test send
is on record **for that exact configuration**. Binding it to the configuration
rather than to the session is the whole point — otherwise an operator verifies
one host, goes back, types a different one, and saves on the first one's
evidence. A hash over the connection-determining fields (host, port, TLS mode,
username, and the credential's identity — never its value) is enough to tie a
test result to the settings it proved, and any edit to those fields invalidates
the result by construction.

Two consequences worth stating before implementation:

- The mockup's `verified` flag is the visible half only. It must be *read*
  before the save button acts (it now is), but the authoritative refusal is the
  endpoint's.
- Changing the encryption mode away from plaintext clears the operator's
  acceptance of unencrypted sending. Consent is to a specific choice, not a
  ticked box that survives changing the choice.

## 6. Configuration

- `SMTP_PASSWORD` → `CredentialStore`, with a `KEY_MAPPING` entry marked
  `secret: true` (PMO ruling). Without that entry it cannot be persisted or
  cleared through the existing credential seam (`utils/helpers/updateENV.js:1892`).
- Host, port, TLS mode, from-address, from-name → `system_settings`.
- TLS: the S3 precedent applies directly — refuse plaintext unless an operator
  explicitly accepts it, and say so loudly at boot rather than at first send.

## 7. Testing

**A real fixture SMTP server, not a mocked `nodemailer`** (PMO ruling). The
reason is §7.9b from S3: a mock shallow enough to assert "send was called" cannot
assert the boundary that actually matters — that no body, token, or link reached
a log. The fixture must expose what crossed the wire so a test can assert on it,
and the log assertions must run against real transport output.

Cases the fixture has to make reachable: accepted (250); auth failure →
`NotificationConfigurationError`; temporary failure (4xx) → retryable with
retry-after; permanent rejection (5xx) → `NotificationRejectedError`; connection
refused → retryable; plaintext refused unless explicitly allowed; duplicate
`notificationId` returns the existing delivery rather than sending twice.

Per §7.14, this branch runs `jest --findRelatedTests` only; the full suite is the
gate's single run.

## 8. Prerequisite, opened separately

`invite_created` already writes the full invite code to the audit log — see
`docs/superpowers/recon/s11-invite-code-in-audit.md`. Pre-existing, but S11
multiplies live invites while seam 6 forbids the driver from logging invite
links, so fixing the driver while the triggering event still writes the link to
disk would be theatre. **Fixed before S11, as its own issue** (PMO ruling).

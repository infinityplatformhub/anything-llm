# S11c (#107) recon — mailer delivery log

Read-only. Base `origin/approof/main`. **No code written, and none should be until the user
decides they want this** — S11b deferred the panel; it did not commit to building it.

---

## What exists today, measured

**There is no delivery record of any kind.** The only memory of a send is an in-process map on
the driver instance (`SmtpNotificationDriver.js:82-93`): `notificationId → {deliveryId,
acceptedAt}`, deliberately **bounded** and **expiring**, because its job is idempotency across a
retry window, not history. It dies with the process.

So `status({deliveryId})` can answer `queued` only for a send this process made recently, and
`unknown` for everything else — including every send made before the last restart. A log is
therefore a NEW record, not a query over something already stored.

**`event_deliveries` is not it.** The table exists (`schema.prisma:734`) and looks close —
`state`, `attempts`, `lastError`, per subscriber — but it belongs to the event bus
(`utils/events/PostgresEventBus.js`), tracks delivery of an EVENT to a SUBSCRIBER, and the mail
driver never writes to it. The driver only *mentions* it in a comment explaining why its own map
exists. Reusing it would mean giving the mailer a fake subscriber row and overloading `state`
with SMTP semantics; that is a coincidence of shape, not a shared concept.

**Status vocabulary is already settled and must not be widened.** `status()` returns
`"queued" | "failed" | "unknown"` and its docblock says it *"NEVER returns 'delivered', and
cannot be made to"* — SMTP's 250 means the next hop accepted the message; forwarding,
greylisting or a bounce two hops away are invisible. The mockup's footer says the same thing to
the operator. Any log column must use this vocabulary; adding a "delivered" state would make the
UI claim something the protocol cannot support, and it would be believed.

## The table

Four columns the mockup needs, and nothing more:

| column | source | why not more |
|---|---|---|
| `occurredAt` | `acceptedAt` from the driver | — |
| `recipient` | `notification.recipient.id` | see the retention section — this is personal data |
| `templateId` | `notification.templateId` (`"invite"`, `"mailer-test"`) | an identifier, never rendered content |
| `status` | `queued` / `failed` | the existing vocabulary, unextended |

Plus `notificationId` for correlation with the idempotency key, and `lastError` for a failed
row — the operator's question after a failure is *why*, and `NotificationRejectedError` vs
`NotificationUnavailableError` already distinguishes "bad payload" from "relay down"
(`utils/notifications/errors.js`).

**What must never be columns**, and the reason is not tidiness:

- **No subject, no body, no link.** `inviteMailer.js:107` builds
  `${base}/accept-invite/${invite.code}` — the invite code IS the credential that creates an
  account. A log row carrying it turns "can read the mail log" into "can accept anyone's
  invite", which is privilege escalation through an observability feature. #71 already
  established that the code must not reach a log on the way; a log table is the most obvious
  place for it to reappear.
- **No rendered text at all**, for the same reason one level up: today only the invite template
  embeds a credential, but the rule "log identifiers, never content" is the one that stays true
  when a future template embeds something else.

## Retention is a requirement, not a nicety

The recipient address is personal data, and this table accumulates one row per email sent
forever unless something removes them. Two things follow:

1. **A retention window must ship WITH the table**, not after. A log that grows without bound is
   a disk problem eventually and a disclosure problem immediately — the longer it lives, the
   more of an organisation's contact graph one leaked backup reveals.
2. **Deletion needs a mechanism that actually runs.** There is a `BackgroundService`
   (`utils/boot/index.js` boots it) and `AssertionReplay.purgeExpired` is an existing precedent
   for a scheduled purge with a test. Reusing that shape is cheaper than inventing one, and it
   comes with the lesson already learned: a purge nobody scheduled is a purge that never runs.

Open question for the ruling: **how long?** 30 days covers "did the invite I sent last month go
out"; 7 days covers "is mail working right now". I would default to 30 with the window as a
setting, but this is a data-retention decision and belongs to the user, not to me.

## Endpoint

`GET /mailer/log`, gated `[validatedRequest, requirePermission("system.write", orgResource)]` —
the same gate as the other three mailer routes. Not a weaker one: the log names who was
contacted, which is more sensitive than the SMTP host, and only `super_admin` holds
`system.write` today (measured for S11b).

Paged, newest first. The UI shows a recent window; an unbounded response would be a slow query
and a large payload for a table nobody scrolls to the bottom of.

## Size

Table + migration, a write at the two points that send (`sendInvite` and the mailer test route),
the endpoint, the purge job, and the UI panel replacing S11b's summary block. Roughly 12-18
tests: the write on success and on failure, the log's absence of subject/body/link asserted
directly, the permission gate, paging, the purge removing old rows and keeping recent ones, and
a test that the status vocabulary excludes "delivered".

**Not small.** The table is the least of it; retention and the "never log content" invariant are
what need care.

## Recommendation

Do not build this on my judgement. S11b's summary panel answers the common question — *is mail
configured and did the last test work* — and the log answers a different one: *what did this
instance send, and to whom*. That second question is worth a table only if someone actually
needs to audit it, and the person who can say is the user who approved the mockup.

If they do want it: the retention window and whether the recipient address is stored in full
are their calls, not implementation details.

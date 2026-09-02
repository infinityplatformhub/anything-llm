# Recon — invite codes are stored verbatim in the audit log

Found while reconnoitring S11 (SMTP/mailer) against `approof/s3-ldap` @ `b415aa08`.
Read-only: nothing changed. **Pre-existing, not introduced by S11** — but S11 is
the change that would make it worse, which is why it is written up separately and
fixed first.

## The defect

`POST /admin/invite/new` emits an audit event carrying the invite code:

```js
// server/endpoints/admin.js:282-288
await emitAuditEvent(
  "invite_created",
  {
    inviteCode: invite.code,
    createdBy: response.locals?.user?.username,
  },
  response.locals?.user?.id
);
```

`inviteCode` is on the audit sink's ALLOWLIST (`server/utils/events/redaction.js`,
under "invites, embeds, community hub"), and none of the four PDPA patterns
(Thai national ID, credit card, email, Thai phone) match an invite code, so the
value passes both guards untouched and lands in `event_logs.metadata`.

Proven rather than argued, against the real generator
(`server/models/invite.js:7-10`, `apw-inv-${randomBytes(32).base64url}`):

```
input code: apw-inv-NlboSgTWm9RGrQy-jRo3fKRrGyJEWWj1odsHVtZlX0Q
stored    : apw-inv-NlboSgTWm9RGrQy-jRo3fKRrGyJEWWj1odsHVtZlX0Q
identical : true
redactions: []   dropped: []
```

## Why it matters

An invite code is a **bearer credential**. `POST /invite/:code`
(`server/endpoints/invite.js:33`) is public and rate-limited only; anyone holding
the code creates an account with the `default` role and is auto-joined to every
workspace the invite names (`server/models/invite.js:63`). There is no second
factor and no check on who is redeeming.

Three properties compound it:

- **Invites never expire.** `invites` has no `expiresAt`; status only moves
  `pending → claimed | disabled` (`schema.prisma:48-57`). A code sitting in the
  audit log stays redeemable indefinitely.
- **The audit log is built to be exported.** S5's whole purpose is shipping these
  rows to a SIEM. A credential in an audit record travels wherever the audit
  records travel, and outlives the system that issued it.
- **The audit log is append-only by design.** It cannot be cleaned up in place;
  `deleteAuditEvents` is the single sanctioned path
  (`AuditEventSubscriber.js:34-37`), enforced by a boundary test.

## What bounds it

`GET /audit/...` requires `audit.read` (`server/endpoints/audit/index.js:86`),
and that action is granted to `super_admin` **only**
(`migrations/20260902050000_t6_audit/migration.sql:18-23`). So this is not
readable by ordinary users or by workspace admins today. It is a privilege
*escalation-persistence* problem rather than an open door: anyone who reaches the
audit log, or any downstream SIEM copy of it, holds live account-creation
credentials for every invite ever issued.

## Why S11 makes it worse

S11 mails invite links. That multiplies the number of live invites, and seam 6
states plainly that a notification driver "MUST NOT log bodies, reset tokens,
invite links, credentials" (`design/seams/06-notification.md`, Boundaries). S11
would be honouring that rule in the driver while the event that *triggers* the
driver already writes the same link to disk. Fixing the driver alone would be
theatre.

## The fix, and what it costs

Removing `inviteCode` from `ALLOWED_KEYS` is one line, and the allowlist is
designed so an unknown key is dropped rather than stored. The question it raises
is what the event is still worth afterwards: `invite_created` would then say only
*that* an invite was created and by whom. That is arguably the correct audit
content — the join key belongs on the invite row, not the credential.

The honest replacement is to emit the invite's **id** (or a short prefix of the
code, the way `keyPrefix` already works for API keys — that key is on the
allowlist for exactly this reason). An id ties the event to the row without
carrying anything redeemable.

Two follow-on questions this recon does NOT answer, both needing a ruling:

1. **Existing rows.** Codes already written stay live until an admin deactivates
   the invite. Nothing here purges them, and `deleteAuditEvents` is the only
   sanctioned path. A one-off scrub is a data migration against an append-only
   log, which needs its own decision.
2. **`link`**, also on the allowlist, is document-link metadata today. Worth
   confirming nothing routes an invite URL through it before S11 adds new call
   sites.

## Tests this needs (RED first)

The regression that keeps it fixed is a redaction test asserting a real generated
invite code does **not** survive `redactEventData`, plus an HTTP-stack test that
creates an invite through the real route and asserts the code does not appear in
`event_logs`. The second matters because the first can pass while a new call site
puts the code under a different, allowlisted key — the same shape of gap that
forced the allowlist to exist (`redaction.js`, header note on `models/user.js`).

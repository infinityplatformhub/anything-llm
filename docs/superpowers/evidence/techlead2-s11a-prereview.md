# Techlead-2 pre-review — S11a SMTP mailer, `recon/s11-smtp-mailer.md` @ `d65973bc`

Design review before Dev3 writes code. Nothing is implemented; this reads the recon
(including the expiry section merged as `623269b1`) against the code on `approof/main` at
`d65973bc`. Read-only — no worktree, no file touched.

The recon is accurate on every claim I could check, and its two central rulings — enforce
expiry inside `Invite.get`, and bind the save-gate to a configuration hash — are both right.
Five observations follow. OBS-1 is the one I would fix before anything else; the rest are
smaller. A twelve-entry mutation list closes it.

---

## Verified against the code

| recon claim | check |
|---|---|
| `Invite.get` validates nothing — a thin `findFirst` | confirmed, `models/invite.js`: `findFirst({where: clause})`, returns `invite \|\| null` |
| every route reaches invites through `Invite.*`; nothing queries `prisma.invites` directly | confirmed by grep across `server/` |
| the redemption path has two independent, duplicated status checks | confirmed — `endpoints/invite.js:17` and `:41`, both `!invite \|\| invite.status !== "pending"`, byte-identical by coincidence |
| `POST /invite/:code` answers `200` with `{success:false}`, so tests must assert the BODY | confirmed, `invite.js:42-45`. `GET` does the same with `{invite:null}` at `:18-20` |
| `whereWithUsers` is listing-only, no status check | confirmed, `admin.js:257`, `api/admin/index.js:309` |
| an email pattern already exists in the audit redaction | confirmed, `redaction.js:65` — `/[\w.+-]+@[\w-]+\.[\w.]+/g` |
| `KEY_MAPPING` marks secrets with `secret: true` | confirmed (`OpenAiKey`). Note a **third** value exists: `secret: "url"` (`AzureOpenAiEndpoint`), which strips inline credentials from an endpoint rather than storing the whole value in the credential store. If the SMTP host is ever stored as a URL rather than host/port, that is the value to pick — worth stating so the choice is made rather than defaulted. |

---

## OBS-1 (fix first) — `markClaimed` never re-reads the row, so expiry in `Invite.get` does not cover redemption

Putting expiry in `Invite.get` is the right call, and the recon's argument for it is sound.
But `markClaimed` does not go through it:

```js
// models/invite.js
markClaimed: async function (inviteId = null, user) {
  const invite = await prisma.invites.update({
    where: { id: Number(inviteId) },
    data: { status: "claimed", claimedBy: user.id },
  });
```

An unconditional `update` by primary key. The route's sequence is:

```js
// endpoints/invite.js:40..59
const invite = await Invite.get({ code });          // ← the only check
if (!invite || invite.status !== "pending") { ...return; }
const { user, error } = await User.create({ ... }); // ← bcrypt hash + user INSERT
await Invite.markClaimed(invite.id, user);          // ← unconditional
```

`User.create` sits between the check and the write, and it is not a fast operation — a bcrypt
hash plus a database insert. So the row can expire, or be deactivated by an admin, or be
claimed by a concurrent request, in the gap.

The concurrency half is not hypothetical and is not new: **two simultaneous POSTs with the
same valid code both pass `:41` today**, both create a user, and both call `markClaimed`. The
second `update` simply overwrites `claimedBy`. Adding expiry makes a narrow TOCTOU window
alongside a double-claim hole that already exists.

Both close with one change — make the claim conditional and let the database arbitrate:

```js
const { count } = await prisma.invites.updateMany({
  where: {
    id: Number(inviteId),
    status: "pending",
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
  },
  data: { status: "claimed", claimedBy: user.id },
});
if (count !== 1) return { success: false, error: "Invite not found or is invalid." };
```

`updateMany` with the predicate in the `WHERE` is atomic against concurrent writers, which a
read-then-write is not regardless of how the read is written. The `expiresAt: null` arm is
what keeps the copy-link flow working — see M3, which is the most expensive regression
available in this change.

Worth a test in its own right: **two concurrent redemptions of one code produce exactly one
success.** That assertion is impossible to satisfy with a read-then-write and trivial with the
conditional update, which is what makes it a good gate.

## OBS-2 — expiry in `Invite.get` must not reach `deactivate`

`deactivate(inviteId)` does its own `findUnique` rather than calling `get`. That is correct
and must stay correct: an admin needs to disable an invite that has already expired, and an
expired invite that `get` reports as `null` would make `deactivate` answer "Invite not found".

The recon already protects the listing path (`whereWithUsers` keeps showing expired rows, with
the reason). `deactivate` needs the same protection and is not mentioned. The risk is a
tidying pass — "these both look up an invite, why do they differ?" — so the comment on
`Invite.get` should say what it is *for*: the redemption path only, never listing and never
admin actions.

## OBS-3 — the configuration hash must treat "no credential" as part of the configuration

§5b binds the save-gate to a hash over host, port, TLS mode, username and **the credential's
identity, never its value**. Right, and the reason given — otherwise an operator verifies one
host, edits it, and saves on the first one's evidence — is the correct threat.

The gap is removal. Hashing the credential's *name* leaves this sequence green:

1. configure SMTP, run the test send, it succeeds — hash `H` recorded as verified
2. clear `SMTP_PASSWORD` through the credential seam
3. save — host, port, TLS and username are unchanged, so the hash is still `H`, and the
   endpoint accepts a configuration that cannot authenticate

The hash input needs the credential's *state*, not its label: presence plus a version or
`updatedAt`, so setting, changing, or clearing it all move the hash. Clearing is the case that
looks least like an edit and most needs to invalidate the evidence.

## OBS-4 — say plainly what `deliveryId` is for, or someone will implement `delivered`

`status()` returning only `queued` / `unknown` is correct and the reasoning is exactly right:
a 250 means the next hop accepted the bytes, not that a human has mail.

But `send()` returns a `deliveryId` that `status()` takes as its argument, and on SMTP there
is nothing to look up. `nodemailer`'s `messageId` is generated **client-side**, so it
identifies what we sent, not anything the server will answer questions about. If `status()`
returns `unknown` for every id, the parameter is decorative.

That is defensible — the seam's shape is shared with providers that *can* answer — but it
should be written down: `deliveryId` exists for idempotency and log correlation, not for
querying delivery state, and on SMTP `status()` cannot do better than `unknown`. Without that
sentence the next person reads an unimplemented method and implements it, arriving at
`delivered` by the same reasoning the ruling already rejected.

## OBS-5 — `notificationId` derived from the event id collides when one event fans out

Deriving `notificationId` from the event id to line up with `event_deliveries`'
`@@unique([subscriberId, eventId])` is a good idea: two independent idempotency keys is how
the same mail gets sent twice.

It holds only while one event produces one message. The moment an event fans out — an invite
to several addresses, or an event that triggers both an invite mail and a notification — the
derived ids collide and the second message is swallowed as a duplicate. Silently, and in the
safe-looking direction, which is why it would not be noticed.

Define it now: `notificationId = hash(eventId, recipient)` (or whatever discriminator the
driver actually varies on), or state that one event is one message and make the fan-out case
throw rather than dedupe. Test: one event, two recipients, two messages delivered.

---

## Mutation list

| # | mutation | must be caught by |
|---|---|---|
| M1 | expiry moved from `Invite.get` to the two routes | a test calling `Invite.get` **directly** with an expired invite, expecting `null` |
| M2 | expiry boundary flipped (`>=` for `>`) | a test with `expiresAt` exactly now |
| M3 | `expiresAt: null` read as expired | the copy-link flow: `email` null, `expiresAt` null, still redeemable — **the most expensive regression in this change**, it breaks every existing invite silently |
| M4 | config hash omits the credential's identity | test passes as user A, switch to user B, save must be refused |
| M5 | save-gate implemented only in the wizard | an HTTP test hitting the save endpoint directly, expecting refusal |
| M6 | `nodemailer` mocked | not a mutation — **grep**: no `jest.mock("nodemailer")` anywhere in the slice's tests, and the fixture must open a real socket (§7.9b) |
| M7 | driver logs the body, token, or invite link | a test capturing console **and** transport output, asserting no `apw-inv-` and no body text |
| M8 | `status()` returns `delivered` | assert only `queued`/`unknown` on every path |
| M9 | duplicate `notificationId` sends again | idempotency test |
| M10 | plaintext accepted without explicit consent | both flag states |
| M11 | `SMTP_PASSWORD` declared `secret: false` | `clearStoredCredential("SMTP_PASSWORD")` works, and the value never appears in `dumpENV` output |
| M12 | an email address reaches an audit event under an allowlisted key | the pattern at `redaction.js:65` exists, but the allowlist filters **top-level keys only** — assert redaction for every allowlisted key the mailer touches, including nested (`changes.*`) and free-text (`name`) |

**M3 and M12 are the two to design against.**

M3 because it is invisible: every existing invite is `expiresAt: null`, so a null read as
"expired" turns off invites globally while every new mailed invite keeps working. The test
suite would be written around mailed invites — the new feature — and pass.

M12 because it is the same defect I measured on this repo three days of work ago, in
`s11-invite-code-in-audit`: the allowlist gates key names at the top level and never inspects
values beneath them. An invite code survived `changes.code`, `link`, a nested object under an
allowlisted key, free text in `name`, and an array — five paths, all green. An email address
in the mailer's audit events will behave identically unless the assertion is made per key
rather than once.

## Reproduction

Everything above is read from `approof/main` at `d65973bc`:
`server/models/invite.js` (`get`, `markClaimed`, `deactivate`, `whereWithUsers`),
`server/endpoints/invite.js:13-31` and `:33-70`,
`server/endpoints/admin.js:257`, `:277`, `:308`,
`server/endpoints/api/admin/index.js:309`, `:365`, `:436`,
`server/utils/events/redaction.js:65`,
`server/utils/helpers/updateENV.js:12-32` (`KEY_MAPPING` shapes) and `:1886-1889`
(`clearStoredCredential` refusing `INSTANCE_AUTH_KEYS`).

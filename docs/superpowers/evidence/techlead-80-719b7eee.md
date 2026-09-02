# Techlead-1 — #80 `719b7eee` (route lane) — 2 findings, 2 NITs

Delta 37712d41..719b7eee is 8 files / +673 −0: `utils/notifications/inviteMailer.js`,
the `email` path on `/admin/invite/new`, the `/v1` refusal, `actorKey`'s JWT decode
(OBS-2), `smtp_allow_untrusted_cert` in `SETTING_KEYS` (OBS-1), and
`inviteMailRoutes.test.js` (369 lines).

Per §7.14 no suites — in-process probes only. Step 6 (save/test route) is still to
come, so this covers pre-read F3 and F4 and the two OBS, not the whole issue.

---

## The `/v1` decision is right, and for the reason given

`user.manage` genuinely has no counterpart in the API-key scope vocabulary
(`apiKeySecurity/scopes.js` stops at `user.read`/`user.write`), so a key cannot
demonstrate the permission ruling D requires. Given that, the three options were:
mail anyway on a weaker scope, drop the address silently, or refuse. Refusing is the
only one that does not lie — and a silent drop here is the exact defect #78 was
opened for. **Endorsed.** The 400 body says what to do instead, which is what makes
it actionable rather than merely correct.

One consequence to state in the issue rather than discover later: an integration
that mails invites through the API cannot be built until a `user.manage` scope
exists. That is a product decision, not a bug, but it should be written down.

## OBS-1 CLOSED — each setting feeds exactly one consent

`smtp_allow_untrusted_cert` is in `SETTING_KEYS`, so it is in the hash, and
`driverFromSettings` maps `smtp_allow_insecure → allowInsecureTransport` and
`smtp_allow_untrusted_cert → allowUntrustedCertificate` with the comment stating
why they must not cross. This is the seam where F1's fix could have been silently
reassembled; it was not.

## F4 (pre-read) — PARTLY closed

**`user.manage` is enforced, and enforced before the invite exists.** The order in
the handler is: parse address → authorize `user.manage` → `assertChannelReady()` →
*then* `Invite.create`. So a refusal leaves no orphan invite, and the test asserts
both halves (403, zero messages, zero rows for that address). One address per
request, malformed address refused before creation, channel-off and unverified both
4xx — all four tested against the real fixture.

`assertChannelReady()` is also called again inside `sendInvite`, with the comment
explaining that settings can be written by another path. Belt and braces on the one
gate that matters; correct.

### FINDING-1 (blocker) — the rate limiters are still not mounted

`grep -rln "inviteMailRateLimit"` over `endpoints/`, `utils/` and `__tests__/`
returns **only** `requestControls.js`, where it is defined and exported. The
middleware array on `/admin/invite/new` is unchanged:

```js
[validatedRequest, requirePermission("invite.create", orgResource), simpleSSOLoginDisabledMiddleware]
```

and `/v1/admin/invite/new` is `[validApiKey(scopeFor(...))]`. Neither carries
`inviteMailRateLimit`. So the first item of ruling D — "rate limit both create
routes, per key/org" — is defined but inert.

`user.manage` narrows *who* can mail; it does not bound *how much*. A single
compromised admin session mails an arbitrary list from the customer's domain at
whatever rate the relay accepts, which is the abuse this limiter was specified to
stop. Mount it on both routes and add the 429 test — the suite has no assertion that
any limit exists, so nothing would catch this if it shipped.

## F3 (pre-read) — the audit path is clean; the listing leak is real and confirmed

Audit: two tests assert neither the invite code nor the recipient address reaches
`event_logs`, on the real route with a real send. The address is not in
`ALLOWED_KEYS` and is not added — the comment says so explicitly. Good.

### FINDING-2 — `invites.email` reaches both `invite.read` listings at this SHA

`Invite.whereWithUsers` is unchanged: no `select`, no projection, and no mention of
`email` anywhere after its definition (checked). It feeds `GET /admin/invites`
(`admin.js:264`) and `GET /v1/admin/invites` (`api/admin/index.js:309`), both
`invite.read`. So every `invite.read` holder — including a long-lived API key that
cannot even mail an invite — now reads the address of everyone ever invited.

PMO says this is tracked as #85. That is the right place to fix it, but the leak is
**introduced by this SHA**: before it, `invites.email` was always null. Shipping the
column and the write path while the read path is deferred means the window between
#80 and #85 is a live disclosure, not a pre-existing one. Either land the projection
change here (it is one `select` in `where`), or hold #80 until #85 lands with it.

## OBS-2 — closed as ruled, and the safety argument holds; the comment overstates one clause

The JWT decode is in and tested (two sessions for one user share a bucket, two users
do not, API keys still hash whole). Probed the forgery angle:

```
same id, different signing secret   -> same bucket      (intended)
forged unsigned token with id=7     -> same bucket as real id=7
two forged random ids               -> two different buckets
```

The last line is the one the comment addresses: *"spending someone else's bucket is
a worse deal for the attacker than spending their own"*. That is true for
**impersonating a known id** — but a forged token with a *random* id gets a **fresh
empty bucket**, and a new random id gets another. So an unauthenticated attacker can
still evade the limit entirely by rotating fabricated ids.

This is not a hole *here*, because `validatedRequest` rejects the forged token
further down and the request never reaches the handler — the limiter is not the
control keeping them out. But the reasoning as written ("a forged id picks which
bucket to spend from, never what the caller may do") is only half the story, and the
half it omits is the one that would matter if this key generator were ever reused on
an unauthenticated route. Narrow the comment to say: safe **because every route this
guards also verifies the token**, so an unverified id can never buy a fresh budget
for a request that actually does anything.

## NIT-1 — the `/v1` refusal has no test

`grep -rn "v1/admin/invite"` across `__tests__/` finds only `inviteCodeAuditHttp`
(#71's audit test) and `routeScopes`. Nothing posts `{email}` to
`/v1/admin/invite/new` and asserts 400. It is the one decision on this SHA I was
asked to rule on, and the assertion that a future contributor does not "helpfully"
wire mailing into the API route is exactly the thing worth pinning. Three lines.

## NIT-2 — the partial-failure response is a 200 with an error string

When `sendInvite` throws after the invite exists, the handler answers `200 {invite,
error: "The invite was created but the email could not be sent."}`. The reasoning is
sound — the invite is real, the admin should get the code — and it matches the
existing `{invite, error}` shape on this route. But a 200 with a populated `error`
is the shape #72 and #78 spent this sprint removing elsewhere, and a client that
checks only the status will report success. Consider `207`, or a distinct
`mailed: false` field the UI can branch on rather than parsing prose.

---

## Verdict on this SHA

FINDING-1 blocks: ruling D's first item is unimplemented, and no test would notice.
FINDING-2 blocks unless #85 lands with #80 — this SHA is what creates the disclosure.
OBS-1 closed; OBS-2 closed with a comment correction; the `/v1` refusal is the right
call. Final verdict on the issue waits on step 6.

## Reproduction

```
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd .claude/worktrees/s11a-mailer/server        # at 719b7eee
grep -rln "inviteMailRateLimit" endpoints utils __tests__     # only requestControls.js
grep -rn "v1/admin/invite" __tests__                          # no email test
node -e '<actorKey with forged unsigned tokens, random ids>'
node -e '<read models/invite.js: whereWithUsers has no email projection>'
```

Read-only: the worktree was checked out at this SHA; nothing modified.

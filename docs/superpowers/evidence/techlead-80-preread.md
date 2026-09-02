# Techlead-1 pre-read — #80 (S11a lane: authz + save-gate) on main `0657de64`

Read-only. Source: `docs/superpowers/recon/s11-smtp-mailer.md` §5b, plus the live
tree at `0657de64`. Per §7.14 I ran no suites — only in-process `node -e` probes,
noted where used. QA-1 (DB), QA-3 (secret) and TL-2 (seam) cover the other lanes;
this is authz and the save gate only.

Four questions asked, four answered. **Two change the ruling.**

---

## 1. Which permission guards SMTP config write / test / save

Measured, not assumed:

| what | where it lands | route | gate |
|---|---|---|---|
| `SMTP_PASSWORD` (secret) | `credential_store` via `updateENV` → `persistCredential` | `POST /system/update-env` (`system.js:673`) | `settings.write` |
| host, port, TLS mode, from-address, from-name | `system_settings` | `POST /admin/system-preferences` (`admin.js:579`) | `settings.write` **+** `system.write` narrowing |

`setup_admin` holds `settings.write` and **not** `system.write`
(migration `20260902020000_t1_authz_schema:302` — the grant list is
`settings.write, user.manage, key.manage, sso.issue, workspace.read,
access.diagnose, role.grant, role.revoke`). So on today's wiring:

- a manager **cannot** write SMTP host/port through `/admin/system-preferences`
  (the #78 filter drops them — they will not be in `managerAllowedFields`);
- a manager **can** write `SMTP_PASSWORD`, and every other one of the 91
  `secret: true` entries, through `/system/update-env`, because that route has
  **no manager narrowing at all**. Probe: `KEY_MAPPING` has 213 keys, 91 with
  `secret: true`; `system.js:673` carries `[validatedRequest,
  requirePermission("settings.write", orgResource)]` and nothing else.

### FINDING-1 — the #78 forbidden list does not conflict with #80; it is contradicted by a route #78 never touched

The two routes disagree about what `settings.write` means. #78 is about to
establish "a manager may write 5 of 28 settings", and one route over, the same
principal writes 213 env keys including every provider credential. That is not a
#80 defect — it predates both — but #80 is the first issue that makes the gap
*asymmetric in a way an operator will notice*: SMTP host is manager-forbidden
while the SMTP password is manager-writable. Half a config each side of a
boundary is worse than either whole.

**Ruling asked for:** put the mailer's save and test endpoints behind
`system.write`, not `settings.write`, and state in #80 that `/system/update-env`
remains `settings.write`-wide as known debt with its own issue. Reason to prefer
`system.write`: a working mailer is send-as-your-domain to an arbitrary address.
That is a phishing capability, not a preference, and `setup_admin` is the role
this program has been narrowing all sprint.

Second-order, worth one line in the plan: the non-secret SMTP fields must be
added to `supportedFields` (28 today). #78's manager list is a literal allowlist,
so new keys are forbidden-by-default — the drift direction is safe. But the
forbidden count moves 23 → 23+N, so any #78 test that hardcodes 23 will go red
on the day #80 lands. Assert the *set relation*, not the count.

## 2. The save gate: does the config hash actually close the race?

**No, and for two separate reasons.** The recon says the hash is stored "beside
the config atomically". Nothing in the write path is atomic:

- `_updateSettings` (`systemSettings.js:718-751`) builds an array of independent
  `prisma.system_settings.upsert` calls and runs `await Promise.all(...)`. No
  `$transaction` — probe: `grep -n 'prisma.\$transaction' systemSettings.js
  updateENV.js` → **0 matches** in either file. A partial write is reachable:
  host updated, port not, hash row either present or absent. Some interleavings
  leave a stored hash that matches a configuration nobody tested.
- The secret does not go through that path at all. `SMTP_PASSWORD` is written by
  `updateENV` → `persistCredential` into `credential_store`, a different model in
  a different call. "Beside the config" is two tables and two code paths; making
  them atomic means one `$transaction` spanning both, which does not exist today.

### FINDING-2 — hashing the credential's *identity* leaves the gate open on the field most likely to change

The recon binds the hash to "host, port, TLS mode, username, and the credential's
identity — never its value". The credential's identity is the envKey
`SMTP_PASSWORD` — a **constant**. Rotate the password and change nothing else,
and the hash is unchanged, so the prior successful test still certifies a
credential that was never tested. That is precisely the failure the gate exists
to prevent, one field to the left of the one it guards.

Fix that keeps the recon's "never its value" property: include a
**fingerprint** of the plaintext — an HMAC under `SIG_KEY`, or SHA-256 of
`envKey + value` — in the hashed tuple. The stored artefact is still not the
secret and still not reversible, and rotation now invalidates the test result by
construction, the same way editing the host does.

Third item on the same path: `updateENV:1655` sets `process.env[envKey] =
nextValue` **before** `await persistCredential(...)`. A failed persist leaves the
live process sending under an untested credential with no stored record of it.
The gate should refuse before either write, not between them.

## 3. `/v1/admin/invite/new` taking `email` — expiry, and audit leakage

**Expiry in `Invite.get` is the right layer, and I confirmed the premise.**
`Invite.get` is a bare `findFirst` (`models/invite.js:78-87`), and the only
callers in the tree are:

```
endpoints/invite.js:16   GET  /invite/:code
endpoints/invite.js:40   POST /invite/:code
```

(`grep -rn 'Invite\.get\|Invite\.where\|Invite\.count'` — the other two hits are
`whereWithUsers` at `admin.js:257` and `api/admin/index.js:309`, both listings.)
Both redemption sites re-check `status !== "pending"` in their own copy, so the
recon's "two byte-identical checks by coincidence" is accurate.

NIT: `Invite.get` takes an arbitrary `clause`, and `where` / `count` /
`whereWithUsers` bypass it entirely. Enforcing expiry inside `get` is correct
*given today's call graph* — but that is the #40 shape: a guard that a call site
added later walks around silently. Pin it with a test that asserts the redemption
routes reach invites **only** through `Invite.get`, so a future
`prisma.invites.findFirst` in a route is red rather than quietly unexpired.

**Audit leakage: measured, and today's redaction holds.** In-process probe
against `utils/events/redaction.js`:

```
{email:"alice@example.com", inviteId:7}  → dropped:["email"]  _droppedKeyCount:1
{recipient:"alice@example.com"}          → dropped:["recipient"]
{changes:{email:"..."}}                  → {"email":"[redacted:changed]"}
{name:"invite for alice@example.com"}    → "[redacted:email]"
{username:"alice@example.com"}           → "[redacted:email]"
{link:".../apw-inv-AAAA…"}               → "[redacted:credential]"
```

`email` and `recipient` are not in `ALLOWED_KEYS`, so a mailer event naming
either is dropped, and the PDPA `email` pattern catches an address that arrives
inside any allowlisted free-text key. So **do not add `email` or `recipient` to
`ALLOWED_KEYS`** — the audit row wants `inviteId`, which already names which
invite without carrying the address or the code.

### FINDING-3 — the disclosure to check is the listing route, not the audit log

`invites.email` as a column means `Invite.whereWithUsers()` returns it, and that
feeds **both** `GET /admin/invites` (`invite.read`) and `GET /v1/admin/invites`
(API-key scope `invite.read`). Every `invite.read` holder — including a
long-lived API key — would read the address of every person ever invited. The
audit path is guarded; this one is not, and the recon does not mention it.
Ruling needed: either omit `email` from the listing projection, or accept it
explicitly and say so.

## 4. Does invite-by-email use the existing `user.manage`?

Today neither invite route asks for `user.manage`: `POST /admin/invite/new` is
`invite.create` (`admin.js:270`), and `POST /v1/admin/invite/new` maps to the
scope `invite.create` (`apiKeySecurity/scopes.js:11`). Adding `email` does not
change *who may create an invite* — but it changes what creating one **does**.

### FINDING-4 — the create routes have no rate limit, and `email` turns that into an open relay

Probe: `grep -n 'inviteRateLimit\|RateLimit'` over `endpoints/admin.js` and
`endpoints/api/admin/index.js` → **0 matches**. `inviteRateLimit` exists and is
mounted only on the public redemption routes (`endpoints/invite.js:13,34`).

So after #80, `POST /v1/admin/invite/new {"email": "<anyone>"}` with a single API
key holding `invite.create` sends unmetered mail from the customer's domain to
addresses the caller chooses, with content the recipient sees as legitimate. The
permission question is real but secondary; the missing limiter is what makes it
abusable at scale.

**Ruling asked for, in order of what I would take:**
1. Rate-limit both create routes — per-key and per-org, not per-IP; an API key's
   IP is meaningless.
2. Keep `invite.create` for the copy-link flow. Require the **mail send** to be
   separately authorised — `user.manage` is a defensible choice since it is what
   `setup_admin` already holds for managing people, and it keeps a read-only
   `invite.create` key from becoming a mailer.
3. Bound it: one address per request, and reject a request carrying `email` when
   the mailer channel is disabled, rather than creating the invite and silently
   not sending — the #78 lesson about a silent `200 {success:true}` on a dropped
   write applies unchanged here.

---

## Summary for the plan

| # | finding | ask |
|---|---|---|
| 1 | `settings.write` writes 213 env keys incl. 91 secrets on `/system/update-env`; #78 narrows only the 28-key route | mailer save/test behind `system.write`; state the other route as known debt |
| 2 | no `$transaction` anywhere in the settings write path; hash over credential *identity* survives a password rotation; env set before persist | fingerprint the value, not the envKey; gate before either write |
| 3 | expiry in `Invite.get` is correct today but bypassable by a later call site; `invites.email` would flow to two `invite.read` listings | pin the redemption path by test; rule on the listing projection |
| 4 | neither invite-create route is rate limited | limit per key/org; separate authority for the send; reject `email` when the channel is off |

Redaction needs **no change** for S11: `email` and `recipient` are dropped by the
allowlist and addresses inside free text are caught by the PDPA pattern.

## Reproduction

```
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd server
node -e 'const {KEY_MAPPING}=require("./utils/helpers/updateENV.js"); ...'   # 213 / 91
node -e 'const {redactEventData}=require("./utils/events/redaction.js"); ...' # 6 shapes above
grep -n "prisma.\$transaction" models/systemSettings.js utils/helpers/updateENV.js  # 0
grep -n "inviteRateLimit" endpoints/admin.js endpoints/api/admin/index.js           # 0
```

No file in any worktree was modified.

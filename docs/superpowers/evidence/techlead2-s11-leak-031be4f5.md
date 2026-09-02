# Techlead-2 review — `recon/s11-invite-code-in-audit.md` @ `031be4f5`

Requested as a design review of the recon's proposed fix, not a code gate — nothing is
implemented at this SHA. **The finding is correct and I reproduced it. The fix as written
does not close it**: four of the five ways an invite code can reach `event_logs` survive
the proposed change, and three further gaps sit alongside it.

Measured against the pristine `031be4f5` copy of `server/utils/events/redaction.js`, with
codes from the real generator (`Invite.makeCode`, `apw-inv-` + 32 random bytes base64url).

---

## The finding reproduces exactly

```
code: apw-inv-6FYLPXxbYofGt5uKSY4VQmIhmlx0K4zLaJb7nyI6m44

A {inviteCode}                   LEAKS   dropped:[] redactions:[]
B {code}                         blocked dropped:["code"] redactions:[]
C {changes:{code}}               LEAKS   dropped:[] redactions:[]
D {link}                         LEAKS   dropped:[] redactions:[]
E {inviteCode:{value}}           LEAKS   dropped:[] redactions:[]
F {name} free text               LEAKS   dropped:[] redactions:[]
G {changes:{invites:[]}}         LEAKS   dropped:[] redactions:[]
```

Row A is the recon's finding, confirmed: the value passes both guards untouched. Row B
shows the allowlist working as designed on an unknown key.

## HOLE-1 (the important one) — removing `inviteCode` from `ALLOWED_KEYS` closes one path of five

I applied the recon's proposed change — and only that change — to the same file and re-ran
the identical shapes:

```
--- proposed fix ONLY (drop inviteCode from ALLOWED_KEYS) ---
A {inviteCode}                   blocked
C {changes:{code}}               LEAKS
D {link}                         LEAKS
F {name} free text               LEAKS
G {changes:{invites:[]}}         LEAKS
```

The allowlist filters **top-level keys only**. Once a key is permitted, `scrubValue`
recurses through its contents applying `PATTERNS`, and none of the four PDPA patterns
(Thai national ID, credit card, email, Thai phone) matches `apw-inv-…`. So the code travels
freely inside any allowlisted key:

- `changes` — an object of arbitrary field names (C, G)
- `link` — the recon's own open question 2, and it leaks today (D)
- `name`, `username`, `workspaceName` — any free-text field (F)
- `inviteCode` itself as a nested object rather than a string (E) — note this one is
  *dropped* under the fix, but only because the whole key goes; it demonstrates that "the
  key is allowlisted" and "the value was checked" are different claims.

The recon states the requirement itself — its second test exists because "a new call site
puts the code under a different, allowlisted key" — but the proposed remedy cannot satisfy
it. A key-level fix cannot constrain values.

**Recommendation: add a pattern, not (only) a key removal.**

```js
{ name: "invite_code", re: () => /\bapw-inv-[\w-]{16,}/g },
```

`scrubString` runs over every string at every depth, so one pattern covers all five shapes
at once — including `link`, which answers the recon's open question 2 without needing a
separate audit of call sites. The key removal is still worth doing (an invite code has no
business being a first-class audit field), but the pattern is what makes the fix hold.

## HOLE-2 — `/v1/admin/invite/new` emits no audit event at all

`server/endpoints/api/admin/index.js:317-370` creates an invite and returns it. There is no
`emitAuditEvent` call anywhere in that handler; the file's only emit is `api_user_deleted`
at `:260`. The audited route is the UI one (`endpoints/admin.js:282`).

So today, an invite created through an API key leaves no audit trace whatsoever. That is a
coverage gap rather than a leak, and it is not what the recon set out to find — but it
belongs in the same decision. Fixing only the UI route produces a system where one path
audits an invite correctly and the other does not audit it at all, which is a worse story
to explain than the current one. S11 mailing invites makes it live: a mailed invite created
via `/v1` would be delivered with no record that it existed.

## HOLE-3 — the invite id does not address the reason the recon gives for fixing this

The recon's central argument is persistence: invites never expire (`schema.prisma:48-57`
has no `expiresAt`; status only moves `pending → claimed | disabled`), so a code in the
audit log stays redeemable indefinitely. I confirmed the schema.

Emitting `inviteId` fixes what *future* events carry. It does nothing about the codes
already written, which remain live until an admin deactivates each invite by hand. The
recon files that as open question 1 — "a one-off scrub is a data migration against an
append-only log, which needs its own decision" — but that framing makes the hard option the
only option.

**There is a cheaper path that matches the threat model better: invalidate the codes rather
than the records.** A bulk `status: "disabled"` over `pending` invites created before the
fix runs through `Invite.deactivate`'s normal update path, touches no audit rows, and makes
every leaked code inert immediately. Scrubbing `event_logs` afterwards becomes a
housekeeping question rather than a security one — and `deleteAuditEvents`
(`AuditEventSubscriber.js:34-37`) stays the single sanctioned delete path, unmodified.

The cost is honest and should be stated in the ruling: pending invites that were legitimately
issued and not yet redeemed stop working, and their holders need a new link. Given S11 is
about to start mailing these, doing it *before* that lands is the cheapest it will ever be.

## HOLE-4 — the two proposed tests can both pass while the leak is open

The recon proposes (a) a redaction unit test asserting a real generated code does not
survive `redactEventData`, and (b) an HTTP-stack test asserting the code does not appear in
`event_logs` after creating an invite through the real route.

- (a) passes under the key-removal fix while C/D/F/G still leak — shape A is the only one
  it exercises.
- (b) drives the one route that already emits, so HOLE-2's route is invisible to it.

**Add a table test**: put a real code into *every* allowlisted key that accepts a string,
plus one nested under `changes`, and assert none survives. That is the same shape as #30's
dialect table — asserting one property across every entry rather than testing one entry
thoroughly — and it is what makes "a new call site under a different allowlisted key"
actually covered. With the pattern in place it passes by construction; without it, it fails
on four rows, which is the point.

## HOLE-5 (minor) — `keyPrefix` is not a usable precedent here

The recon offers "a short prefix of the code, the way `keyPrefix` already works for API
keys" as an alternative to the id. An API key prefix works because it is non-secret by
design and still distinguishes keys. `apw-inv-` is a constant: every invite shares it, so a
prefix of that length is not a join key at all, and any prefix long enough to distinguish
invites has started leaking the secret. Use `inviteId` and drop the prefix option.

---

## What the recon got right, and is worth keeping

- The finding is real, proven against the real generator rather than argued.
- The bound is stated accurately: `audit.read` is `super_admin`-only
  (`migrations/20260902050000_t6_audit/migration.sql:18-23`), so this is
  escalation-persistence, not an open door. Not overstated.
- "Fixing the driver alone would be theatre" is exactly right, and it is the same reasoning
  that applies to HOLE-1 one level down — fixing the key alone is theatre too.
- Writing it up separately from S11 and fixing it first is the correct sequencing.

## Suggested spec

1. `invite_code` pattern in `PATTERNS` (covers all five shapes, and `link`).
2. `inviteCode` out of `ALLOWED_KEYS`; emit `inviteId` instead. No prefix.
3. `emitAuditEvent("invite_created", …)` at `/v1/admin/invite/new` too.
4. Bulk-disable `pending` invites created before the fix; scrub of old rows becomes
   optional housekeeping.
5. Tests: the table across every allowlisted key, plus HTTP tests on **both** creation
   routes.

## Reproduction

```
git show 031be4f5:server/utils/events/redaction.js > /tmp/tl2-s11/redaction.js
node /tmp/tl2-s11/probe.js
```

The probe generates a code with the real `crypto.randomBytes(32).toString("base64url")`
recipe, runs the seven shapes through `redactEventData`, then recompiles the same source
with `"inviteCode", ` removed and re-runs five of them. Nothing in any worktree was
modified; the s3-ldap worktree was read only.

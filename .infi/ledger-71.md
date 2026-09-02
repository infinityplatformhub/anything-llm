# Ledger — #71: invite codes stored verbatim in the audit log

Branch `approof/s3-ldap`, SHA `cfaadf32`, on top of `origin/approof/main`.
Found while reconnoitring S11; opened and fixed ahead of S11 by PMO ruling.

## The defect, as measured

`invite_created` (`endpoints/admin.js`) passed `inviteCode: invite.code`.
`inviteCode` was on the redaction ALLOWLIST and none of the four PDPA patterns
match `apw-inv-<base64url>`, so the credential passed both guards and reached
`event_logs` byte for byte. Proven by running the real generator, not by reading:

```
input code: apw-inv-NlboSgTWm9RGrQy-jRo3fKRrGyJEWWj1odsHVtZlX0Q
stored    : apw-inv-NlboSgTWm9RGrQy-jRo3fKRrGyJEWWj1odsHVtZlX0Q
identical : true      redactions: []   dropped: []
```

Severity: `POST /invite/:code` is public and mints an account with workspace
access; invites have no expiry; the audit log is built to be exported to a SIEM.
Bounded by `audit.read` being `super_admin` only
(`migrations/20260902050000_t6_audit`), so this is credential *persistence and
propagation*, not an open door.

## Rulings

Ruling: the fix is a VALUE pattern in `PATTERNS`, not only removing the key from
the allowlist — because the allowlist filters TOP-LEVEL KEYS ONLY. Techlead-2
measured five surviving paths (`changes: {code}`, `link`, nested object, array
element, any free-text allowlisted key). `scrubString` walks every string at
every depth, so one pattern closes all of them. If this is wrong we carry a
regex on a hot write path; if the key-only fix had shipped, four of five leak
paths would have remained open while the issue read as closed.

Ruling: `inviteCode` leaves the allowlist and `inviteId` replaces it, with no
short-prefix variant. If this is wrong the audit row loses the ability to name a
specific invite — it does not: the id ties the row to the invite without
carrying anything redeemable, the same trade `keyPrefix` already makes for API
keys. A short prefix was considered and rejected: there is no prefix length that
is both useful for correlation and safe against a narrowed brute force.

Ruling: the pattern matches the `apw-<three letters>-` FAMILY, not a list of
known prefixes. An explicit `(?:inv|key|brx)` alternation shipped first and
missed `apw-tat-` (`models/temporaryAuthToken.js`), caught by Techlead review —
which is the argument for the family: a list is only as complete as the last
person to grep for generators, and the failure mode is silent leakage until
someone notices. If this is wrong, a non-credential string shaped
`apw-xyz-<16 chars>` gets redacted too; nothing in the tree is shaped that way,
and over-redacting a log line is recoverable in a way that publishing a live
credential is not.

Ruling: the length bound is `{16,}`, not `{40,}` as first proposed. If this is
wrong we accept a theoretical false positive — impossible in practice, since the
`apw-*-` prefix is ours. A bound tied to today's 43 characters would silently
stop matching the moment a generator emitted something shorter: failing open,
invisibly, which is the failure mode this whole issue is about.

Ruling: NO `\b` anchor (Techlead FINDING-1). Measured: with `\b`, four of five
probe shapes leaked — `x<code>`, `_<code>`, `id<code>`, `token<code>` — because
`\b` requires a non-word character before the match and `_` is a word character.
If this is wrong the pattern matches inside a longer token, which is precisely
what is wanted. An anchor that fails open on string concatenation is worse than
no anchor.

Ruling: old rows are handled by bulk-disabling every `pending` invite
(migration `20260902110000`), NOT by rewriting `event_logs`. If this is wrong,
codes already written stay readable in the log — accepted, because they are
already exported and unrecallable, so rewriting history would buy nothing while
setting a precedent that audit rows may be edited by any migration that finds
them inconvenient. The audit log is append-only by design and
`deleteAuditEvents` is its single sanctioned mutation path.

Ruling: `/v1/admin/invite/new` gains `api_invite_created` with NO userId. If
this is wrong the actor is under-specified; claiming a user id the API key does
not have would be worse, and `api_user_deleted` in the same file sets the
precedent.

Ruling: the key-carrier tests enumerate `ALLOWED_KEYS` at runtime rather than a
hand-picked list. If this is wrong the suite grows as the allowlist does — which
is the point: a key added later is covered the day it is added.

## What I got wrong, and how it was caught

I reported to PMO that no `emitAuditEvent` call site passes a `link` key. False
— `endpoints/workspaces.js:219` (`link_uploaded`) and
`endpoints/api/document/index.js:493` (`api_link_uploaded`) both do. I had
grepped for `link:` while both write the shorthand `{ link }`. QA-3 caught it.

The conclusion ("no extra work needed for `link`") survived, but the reasoning
was wrong in a way that mattered: I had it as a dead entry with no carrier, when
in fact it is live, cannot be removed without losing document-upload audit
records, and is closed only by the pattern. Anyone trusting the original
reasoning would later have read an invite URL in `link` as safe. Corrected in an
`updated` comment on the issue rather than quietly.

## Mutation proof

| mutant | expected kill | result |
|---|---|---|
| remove the `credential` pattern entirely | the key-carrier table | 89 of 98 failed |
| restore the `\b` anchor | the concatenation cases | 44 of 143 failed |
| narrow the family back to `(?:inv\|key\|brx)` | the sibling-credential case | exactly 1 failed |
| rename the constraint (#68, for contrast) | — | n/a, different issue |

The first number is the useful one: the table is load-bearing, not decoration.

## Also found (pre-existing, reported not fixed)

`/v1` routes mount under `/api`. A request to `/v1/admin/invite/new` without the
prefix does not 404 — it HANGS until the test times out, because no route
matches and nothing ever responds. Cost me a 30s timeout that first read as a
logic failure. Reported to PMO; recorded as §7.15.

## Evidence

`__tests__/utils/events/auditRedaction.test.js` + `__tests__/api/inviteCodeAuditHttp.test.js`
— Tests: 146 passed, 146 total, 2 suites. Per §7.14 the full suite is the gate's
single run; this branch ran `--findRelatedTests` only.

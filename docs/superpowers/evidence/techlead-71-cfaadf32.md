# Techlead-1 — #71 invite-code leak, final review of `cfaadf32`

Reviewed: `031be4f5..cfaadf32` (Dev3, `approof/s3-ldap`). Pre-review of the same working tree was sent
to Dev3 through PMO; Techlead-2's design review is `techlead2-s11-leak-031be4f5.md`.
Verdict: **PASS.** FINDING-1 closed, both NITs closed, and the fix is broader than the spec asked for
in a way that is correct. One NIT of my own.

Diffstat: 6 files, +423/-3 — `redaction.js` (+38/-3), two test files, both invite routes, migration.

## FINDING-1 closed — verified, not accepted

The `\b` anchor is gone: `/apw-(?:inv|key|brx)-[A-Za-z0-9_-]{16,}/g`. All five glued shapes I measured
as leaking now block, with no false positive returning:

```
glued:  "x"+code  "_"+code  "id"+code  "9"+code  "token"+code   -> all blocked
kept:   apw-inv-short · apw-key-abc · filename-apw-inv-notacode
        apw-xyz-<20 chars> · apw-inv-<15 chars>                 -> all kept
```

**Dev3's mutant claim reproduces.** I recompiled the module in-process with `\b` restored and ran the
table's own logic: **43 failing cells** (one per allowlisted key, in the concatenated form only — the
bare and sentence forms still have a separator, which is exactly why the third form was needed). With
the pattern removed entirely: **129 cells** — 43 keys × 3 forms. Baseline: **0**. So the table is
non-vacuous and each mutant is killed by the row that should kill it.

The comment at `redaction.js:88-93` states the finding and the measurement rather than just the
conclusion, including why `_` leaked. That is the right level of detail for the next person who
reaches for an anchor.

## The scope widening to `apw-key-` and `apw-brx-` is correct

Not in the spec, and right to add: `ApiKey.makeSecret()` and `BrowserExtensionApiKey.makeSecret()`
produce the same shape from the same generator recipe and had no guard either. Verified both real
generators against the fixed module — bare, spaced and glued forms all block. The test uses the **real**
generators rather than lookalike strings, which is what makes it survive a format change.

Renaming the pattern `invite_code` → `credential` follows correctly, and the QA-3 test's assertion was
updated to `[redacted:credential]`.

## NIT-1 (mine, from the pre-review) — closed
The migration now carries an explicit **BLAST RADIUS** paragraph: every `pending` invite at apply time,
not only those whose code demonstrably reached a log, with the reason (they cannot be told apart after
the fact) and the direction of safety. It also adds what the fix does *not* undo — codes already
exported are out permanently; disabling removes their use, not their exposure. Better than what I asked
for.

## NIT-2 (mine) — closed, and corrected
I said `link` was described as "dormant" and was one copy-paste from live. Dev3 went further and found
it is **already live at two call sites** — `endpoints/workspaces.js` emitting `link_uploaded` and
`endpoints/api/document/index.js` emitting `api_link_uploaded` — so `link` cannot be dropped from the
allowlist without losing those records, which is now stated as the reason the value pattern is the only
available guard. My "one copy-paste away" was too generous; the corrected version is in the comment.

## The rest of the spec, re-verified at this SHA

- Third table form present (`a code CONCATENATED onto a word is redacted`), giving 43 keys × 3 = 129
  cells, plus the sibling-generator test asserting spaced **and** glued for both `apw-key-` and
  `apw-brx-`.
- `changes` still excluded from the table and given its own case — different function (`scrubChanges`),
  so folding it in would exercise the wrong path.
- `inviteCode` out of `ALLOWED_KEYS`, `inviteId` in, asserted directly.
- `/v1/admin/invite/new` emits `api_invite_created` with `inviteId` and no `userId`, guarded by
  `if (invite)`; the HTTP test asserts the row **count increments through the real route**.
- HTTP tests scan all 200 `event_logs` rows, not just the `invite_created` row, and guard the premise
  (`typeof code === "string"`, `length > 20`) before searching.
- Migration slot 110000, after 102000, touching only `invites`.

## NIT-1 (mine, new) — `apw-tat-` is the fourth prefix and is not covered

The tree issues **four** `apw-*-` credentials, not three. `TemporaryAuthToken.makeTempToken()`
(`models/temporaryAuthToken.js:16`) generates `apw-tat-` + 32 random bytes base64url — same recipe,
same shape. The pattern's alternation is `(?:inv|key|brx)`, so it is not matched. Measured:

```
tat in {name}:  LEAKS
tat in {link}:  LEAKS   ("https://…/sso/login?token=<tat>")
```

The risk is genuinely lower than the other three and I want to be accurate about that: the token
expires (the field says 1 hour), and `validate()` deletes it in a `finally` block under all
circumstances once retrieved, so it is single-use. An unredeemed token in a log is live only until it
expires — unlike an invite code, which never expires.

But the pattern's own comment says it covers "ALL THREE issued prefixes", and that is now the sentence
that will be read as complete when someone adds the next one. The alternation is one word longer:
`(?:inv|key|brx|tat)`, plus a row in the sibling test using the real `makeTempToken()`. Not a blocker —
the exposure window is bounded and no call site is known to pass a temp token to `emitAuditEvent`
today — but it is the same class the widening to `key`/`brx` was right to close, and leaving one
sibling out re-creates the gap the widening removed.

## What I did not do
Did not run the suite (§7.14). Every result above comes from executing the real `redaction.js`,
`Invite.makeCode()`, `ApiKey.makeSecret()`, `BrowserExtensionApiKey.makeSecret()` and
`TemporaryAuthToken.makeTempToken()` under node 22, including two recompiled mutants loaded
in-process. The `s3-ldap` worktree was read only.

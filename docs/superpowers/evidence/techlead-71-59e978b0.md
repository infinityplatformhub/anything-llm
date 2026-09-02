# Techlead-1 — #71, `59e978b0`

Reviewed: `cfaadf32..59e978b0` (Dev3, `approof/s3-ldap`), plus the uncommitted `DISPLAY_PREFIX_LENGTH`
work in the same tree. Earlier reviews: `techlead2-s11-leak-031be4f5.md` (design), my `cfaadf32`
review (superseded by this file).
Verdict: **PASS**, and the family pattern is the right call. One NIT.

Delta: 3 files, +146/-12 — pattern `(?:inv|key|brx)` → `[a-z]{3}`, sibling test gains
`TemporaryAuthToken.makeTempToken()`, ledger.

## The three confirmations asked

### 1. False-positive set — two of the old rows now redact, and that is acceptable

Measured on this SHA:

```
apw-inv-short                          kept
apw-key-abc                            kept
filename-apw-inv-notacode              kept
apw-inv-<15 chars>                     kept       (bound still holds)
apw-KEY-<20>                           kept       (case-sensitive)
apw-ke-<20> / apw-keyy-<20>            kept       ({3} is exact)
apw-xyz-<20 chars>                     REDACTED   ← changed
apw-abc-<16 chars>                     REDACTED   ← changed
```

Both changed rows are strings that do not exist anywhere in the tree — I checked: the only `apw-*-`
literals are `inv`, `key`, `brx`, `tat`, all four of them credential generators. So the widened
pattern costs nothing real today, and the trade the comment states is the right one: over-redacting a
log line is recoverable, publishing a live credential is not.

**Acceptable — and it is the better failure direction.** The three-prefix list already failed once
(`apw-tat-` missed and caught only in review). A list is a thing someone must remember to extend; the
family is covered on the day a generator is added. `[a-z]{3}` is tight enough that the shape is
distinctive: three lowercase letters between two hyphens, then 16+ base64url characters.

### 2. `keyPrefix` survives, and the coupling is now asserted rather than hoped for

`DISPLAY_PREFIX_LENGTH = 16` → `keyPrefix` is `apw-key-` (8) + 8 trailing = **one character short**
of the pattern's `{16,}` bound. Verified: `apw-key-Udg6vSJj` passes through untouched, with
`redactions: []`.

That margin is one character, and the uncommitted work is exactly right to pin it. I measured the
cliff:

| `DISPLAY_PREFIX_LENGTH` | trailing chars | outcome |
|---|---|---|
| 16 (today) | 8 | survives |
| 20 | 12 | survives |
| **24** | **16** | **REDACTED — audit rows lose their join key** |
| 28 | 20 | REDACTED |

`keyPrefix` exists so an operator can tie an event to an API key without holding the key. At 24 every
prefix in every audit row starts reading as a credential, silently, and no other test looks at it. The
new `QA-3 R4` test asserts `DISPLAY_PREFIX_LENGTH - "apw-key-".length < 16` — which fails at the
declaration site with a comment explaining why, rather than surfacing later as a puzzling audit bug.
Exporting the constant to make the coupling assertable rather than commented is the right instinct.

**That work is uncommitted.** It must be in the SHA that merges, or the coupling is undocumented and
unguarded again.

### 3. Mutants

Recompiled in-process, table logic run over 43 allowlisted keys × 3 forms = 129 cells:

| mutant | failing cells |
|---|---|
| baseline (invite, and tat) | **0** |
| `\b` anchor restored | **43** — the concatenated form only, which is why the third form exists |
| family → `(?:inv|key|brx)` list | **129** (measured with a `tat` secret) |
| pattern removed | **129** |

Each mutant is killed by the row that should kill it, and the regression PMO names — shrinking the
family back to a list — is caught by the sibling test with a real `makeTempToken()`.

All four generators verified bare / spaced / glued against the real functions: `inv`, `key`, `brx`,
`tat` — 12 of 12 blocked.

## NIT — the family matches a shape a non-credential string could plausibly take

`apw-dev-environment-config-file` **redacts** (`apw-dev-` + `environment-conf` = 16, and `-` is in the
character class). Nothing in the tree looks like that today, and I would not change the pattern for
it — the trade in the comment already covers this case correctly.

Worth one clause in the comment, though: the stated cost is "a non-credential string shaped
`apw-xyz-<16 chars>`", which reads as requiring 16 *alphanumeric* characters. Because `-` and `_` are
in the class, a hyphenated identifier reaches the bound sooner than that phrasing suggests. Precision
in the comment, not a behaviour change.

## Everything from the `cfaadf32` review still holds
FINDING-1 (`\b` removal) closed and re-verified here; both my earlier NITs closed — the migration's
BLAST RADIUS paragraph, and the `link` correction (Dev3 found it live at two call sites, not dormant
as I described it). Table structure, `changes` exclusion, `inviteCode` removal, `api_invite_created`
on the `/v1` route, migration slot 110000 — all unchanged by this delta.

## What I did not do
Did not run the suite (§7.14). Every table comes from executing the real `redaction.js` and all four
generators under node 22, including three recompiled mutants loaded in-process. Read-only in that
worktree — no file written.

# Recon — the numeric PII patterns: #99, #100, #101

One issue, not three. All three findings are the same list of four regexes in
`utils/events/redaction.js`, every fix edits the same `PATTERNS` array, and splitting them means
three rounds of "does this change the other two". They are separable as *findings* and not as
*work*.

Follows #95, which fixed the `\b` anchor on the same three numeric patterns.

## 0. All four reproduce, measured

```
createdAt 1788342584446 ok       →  createdAt [redacted:thai_national_id] ok    (#100)
x 12345678901234567 y            →  unchanged                                   (#101)
20260902100000_add_index         →  [redacted:credit_card]_add_index            (#101)
id １２３４５６７８９０１２３      →  unchanged                                   (#99)
```

## 1. Two different kinds of defect, and only one of them is a leak

**#101 and #99 are leaks.** A 17-digit run and a fullwidth-digit run are PII that reaches the audit
log intact. #101 is worse than it looks because it is *reachable by construction*: an attacker who
knows the patterns can pad an identifier to 17 digits and it is stored verbatim.

**#100 is noise.** A timestamp redacted as a national ID loses a diagnostic value; nothing escapes.

That asymmetry decides the whole design: **a change that reduces noise at the cost of failing open
on real PII is a bad trade even when it looks like an improvement.**

## 2. The checksum proposal, measured — and why it is not the fix

The obvious answer to #100 is "validate the Thai mod-11 checksum", and to the migration-id false
positive "validate Luhn". Both were measured before being proposed:

| claim | measured |
|---|---|
| mod-11 removes timestamp false positives | **No — 9.1%** of 200,000 real 13-digit ms timestamps pass it (18,184 of 200,000) |
| Luhn removes migration-id false positives | **No** — `20260902050000`, a real migration id in this tree, passes Luhn |

So a checksum buys roughly a 10× reduction in one kind of noise. What it costs is the part that
matters:

**A checksum makes the pattern FAIL OPEN on real PII that is mistyped.** A national ID with one
digit wrong is still a national ID a person typed about themselves — still PDPA data, still
something the operator must not publish — and it is exactly the shape that appears in free text
where someone typed it from memory. The current pattern redacts it. A checksummed pattern would
not.

**Ruling to confirm with PMO before implementation: do NOT add checksums.** Accept #100's noise.
The class marker `[redacted:thai_national_id]` on a timestamp is a cosmetic wrong label on a value
that was going to be removed by *something*; the alternative is a validator that publishes real
IDs because they contain a typo. If PMO wants #100 addressed anyway, the honest fix is narrower
context (see §4), not a checksum.

## 3. #101 — the ≥17-digit hole

`(?<!\d)\d{13}(?!\d)` requires exactly 13, `credit_card` tops out at 16. A 17-or-more-digit run
matches nothing.

The fix is a `long_digit_run` pattern for runs longer than any classified length. It is deliberately
a *catch-all with no semantic claim*: the marker says "a long run of digits was here", not what it
was, because the whole point is that we do not know.

Ordering matters and must be explicit: it goes **last**, so `thai_national_id`, `credit_card` and
`phone_th` claim their matches first and keep their specific labels. Placed first it would swallow
every card number under a vague marker and make the audit log less useful, not more.

The `credit_card` pattern's existing 13-16 range stays. The new pattern starts at 17.

## 4. #100, if PMO wants it addressed without a checksum

The honest lever is *context*, not arithmetic: a 13-digit run immediately preceded by a key that
names a time (`createdAt`, `timestamp`, `_at`, `ms`) is a timestamp. That is a narrower claim than
a checksum, it does not fail open on typo'd PII, and it is testable against real field names in
this tree.

It is also a bigger change than it looks — `scrubString` currently sees a string with no idea which
key it came from — and it is not required to close a leak. **Recommend deferring** unless PMO rules
otherwise, and saying so in the issue rather than silently doing nothing.

## 5. #99 — fullwidth digits, and the trap in the obvious fix

`\d` does not match `１２３`. NFKC normalisation maps them to ASCII.

**The trap: NFKC changes string LENGTH.** Measured: `ﬁ` → `fi` (1→2), `㍿` → `株式会社` (1→4),
`①②③` → `123` (3→3). So "normalise, scrub, map the offsets back to the original" is not sound —
the offsets do not correspond, and a mapping that silently drifts would redact the wrong span of a
user's text.

Two options, and the choice needs a ruling:

**(a) Store the normalised form.** `scrubString` returns NFKC(input) with patterns applied. Simple
and sound. Cost: audit values are normalised — a workspace named `ｆｕｌｌｗｉｄｔｈ` is recorded as
`fullwidth`. For an audit log that is arguably a feature (it is what a search would match) but it
IS a change to stored data beyond redaction, which is worth stating plainly.

**(b) Widen the character classes instead** — match fullwidth digits directly in each numeric
pattern (`[0-9０-９]`), leaving the string otherwise untouched. No normalisation, no length
change, no other script affected. Cost: four patterns get uglier, and other Unicode digit forms
(Arabic-Indic, Devanagari) stay unmatched unless added.

**Recommend (b)**, because it changes only what it must and the audit log keeps what the user
actually typed. (a) is defensible but it modifies values on a path whose contract is "redact PII,
otherwise store what happened".

## 6. Tests

Negative fixtures are the point here — three of the four findings are about matching too much or
too little, so a test that only asserts redaction proves nothing.

- real ms timestamps (`Date.now()` shaped) — assert the CURRENT behaviour, whatever PMO rules, so
  the decision is recorded rather than assumed
- real migration ids from this tree (`20260902100000`, `20260902101000`, `20260902050000` — the
  last one passes Luhn, which is why it is in the list)
- a Thai ID with a VALID checksum and one with an INVALID checksum — **both must be redacted**;
  this is the test that fails if someone adds a checksum later
- a card number with a valid Luhn and one with an invalid Luhn — both redacted, same reason
- 17, 20 and 32-digit runs → redacted, and labelled `long_digit_run`, not as a card
- a 16-digit card still labelled `credit_card`, not swallowed by the new pattern (ordering)
- fullwidth digits in all three numeric classes
- **negative control**: an ordinary word, a short number, a version string like `1.16.1`, and a
  UUID must all survive untouched
- the existing 148 assertions in `auditRedaction.test.js` still pass

## Scope

**In:** `PATTERNS` in `utils/events/redaction.js` — the `long_digit_run` addition and the fullwidth
handling — plus tests.

**Out:** checksums (§2, pending PMO ruling); key-context detection for #100 (§4, recommended
deferred); other Unicode digit families; anything outside `redaction.js`.

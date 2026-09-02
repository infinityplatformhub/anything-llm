# Ledger — #120 (fullwidth separators in `credit_card`)

plain tier. Two files: `server/utils/events/redaction.js`,
`server/__tests__/utils/events/auditRedaction.test.js`.

## Recon, measured on `c44b059d3`

Drove every candidate codepoint through `scrubValue` — same sixteen digits, varying ONLY the
character between the groups, in both digit widths:

    HIT   U+0020 space · U+002D hyphen · no separator at all (16 contiguous)
    miss  U+3000 U+00A0 U+FF0D U+FF0C U+2010–U+2015 U+2212 U+2009 U+202F
          U+00AD U+200B U+FEFF newline tab . / : ． ：

Mixed separators missed as soon as one boundary was non-ASCII: `1234 5678－9012　3456` → miss.
#118 widened the DIGITS and left the punctuation ASCII, so the miss was the ordinary case on
exactly the input #118 was widening for.

## Rulings (PMO confirmed each)

Ruling: IN = the visible separators a person or an IME actually produces between digit groups —
spaces (`U+0020` `U+00A0` `U+2009` `U+202F` `U+3000`) and the dash family (`U+002D` `U+2010`–`U+2015`
`U+2212` `U+FF0D`).

Ruling REVERSED — both commas are OUT. PMO ruled `U+002C` IN alongside `U+FF0C`, on the symmetry
argument that a class matching the fullwidth comma but not the ASCII one repeats the half-widening
that caused this bug. TL-2 then MEASURED what that admits, and the symmetry argument does not
survive it: a comma between numbers is how a LIST is written, so the class caught
`ids: 1001,1002,1003,1004`, `1000,2000,3000,4000`, chunk sizes, order ids and
`価格 1200，3400，5600，7800` — none of which the pattern touched before. That is the newline
argument exactly, and I should have applied it to commas myself when I wrote the newline ruling.
Both widths go out together, so the symmetry is kept while the false positives are not. — ถ้าผิด:
log ที่มี list ของตัวเลขจะ redact ตัวเองทุกบรรทัด

Ruling: the symmetry argument alone is not enough to admit a separator; every candidate has to be
measured against ordinary text, because this class has no checksum and nothing else stops a false
positive.

Ruling: newline and tab are OUT. `1234\n5678\n9012\n3456` down four log lines is not one card
number; a class matching any Unicode whitespace lets an ordinary four-column numeric log redact
itself, destroying the log without protecting anyone. — ถ้าผิด: log ปกติหายไปโดยไม่ได้ป้องกันใคร

Ruling: zero-width (`U+200B` `U+FEFF` `U+00AD`) is OUT. An evasion vector rather than a typing
artifact, and sixteen contiguous digits already match, so the loss is narrow. Where invisible
characters should be stripped is its own question — a separate issue, to be opened after this one.

Ruling: `phone_th` and `thai_national_id` are untouched. They have no separator today and giving
them one has its own false-positive profile.

Ruling: **the class is built from ESCAPE SEQUENCES, never literal characters.** Found while
mutating, not by reading: written with literals, `[ -　]` is a RANGE from U+0020 to U+3000 covering
`.`, `/`, `:` and every ASCII letter — `1234.5678.9012.3456` redacts as a card while the source
still looks like a list of sixteen separators. This is now both a comment and a test that asserts
on the compiled pattern. — ถ้าผิด: class กลายเป็น "อักขระอะไรก็ได้" เงียบ ๆ ในขณะที่โค้ดยังอ่านดูถูก

## No checksum

This class has no Luhn check, unchanged from #118 (measured then: Luhn passes `20260902050000`, a
real migration id, and a checksum makes the pattern fail OPEN on mistyped real PII). Every separator admitted
therefore widens what the class can falsely catch, with nothing behind it to filter the result —
which is what the comma reversal above cost, and why "unchanged in kind" would have been the wrong
claim. The over-redaction
control asserts that ordinary prose carrying an IN separator (`release 1.16.1–stable, built 2026`)
and a dash-separated date (`2026－09－02`) are untouched.

## Evidence

`npx jest __tests__/utils/events/auditRedaction.test.js` → **202 passed**.

RED before the change: **19 failed**, named — the new IN separators with ASCII digits, the three
fullwidth-digit IME cases, the mixed-separator case, and the comma cases (which the reversal above
turned into negative controls: they now assert the commas do NOT match, and go red if either is
added back). ASCII space,
ASCII hyphen and all eight negative controls were green BEFORE and after: they pin the boundary
rather than the fix.

### Mutations, each named at the test it takes red (§7.9f)

| mutation | tests that go red |
|---|---|
| widen exactly ONE separator (`U+3000` only) — the failure mode the issue names | 13 red: every other IN codepoint, the mixed case, all three fullwidth IME cases |
| add `\n` and `\t` to the class | `newline does not join four digit groups into a card`, `tab does not join…`, `newline is EXCLUDED as a decision, not an oversight` |
| put both commas BACK into the class (TL-2's finding) | `BOTH commas are OUT — proposed as IN, reversed on measurement`, `U+002C comma does not join four digit groups into a card`, `U+FF0C fullwidth comma does not join…` |
| write the class with LITERAL characters instead of escapes (the range hazard) | 6 red: `the separator class is a SET, never a range`, `ASCII full stop does not join four digit groups into a card`, `solidus does not join…`, `redacts 17 digits`, and both comma negatives — a range from U+0020 to U+FF0D swallows the commas too |

The last one is the mutation that found the hazard; the test that pins it was written because of it.

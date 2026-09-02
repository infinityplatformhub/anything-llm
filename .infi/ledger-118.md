# Ledger — #118 (numeric PII patterns; closes #99 and #101)

## Rulings

Ruling: ONE issue, not three. All three findings edit the same `PATTERNS` array in the same file;
split, each becomes a round of "does this change the other two". Separable as findings, not as work.
— ถ้าผิด: สามรอบของการตรวจว่ากระทบกันไหม แทนที่จะรอบเดียว

Ruling: **NO checksums**, against what the original recons pointed at. Measured before proposing —
Thai mod-11 passes **9.1%** of 200,000 real ms timestamps (18,184), and Luhn passes
`20260902050000`, a real migration id in this tree. So a checksum buys ~10× less noise and costs the
thing that matters: it makes the pattern FAIL OPEN on real PII that is mistyped, and a national id
with one digit wrong is still a national id someone typed about themselves. PMO confirmed. —
ถ้าผิด: publish เลขบัตรจริงที่พิมพ์ผิด เพื่อแลกกับ label ที่สวยขึ้นบน timestamp

Ruling: the asymmetry decides the design and is written into the issue. #101 and #99 are LEAKS (PII
reaching the log intact; #101 reachable by construction — pad an identifier past 16 digits). #100 is
NOISE (a wrong class marker on a value that gets removed anyway). A change that reduces noise at the
cost of failing open on real PII is a bad trade even when it reads as an improvement.

Ruling: #99 widens the character classes to `[0-9０-９]`; the string is NOT normalised. NFKC changes
string LENGTH — measured: `ﬁ` → `fi` (1→2), `㍿` → `株式会社` (1→4) — so "normalise, scrub, map the
offsets back" is unsound and a drifting mapping redacts the wrong span of someone's text. Storing
the normalised form instead would change stored values beyond redaction, on a path whose contract is
"redact PII, otherwise store what happened". — ถ้าผิด: redact ผิดช่วง หรือเปลี่ยนข้อมูลที่ผู้ใช้พิมพ์

Ruling: `phone_th`'s leading zero is a CLASS (`[0０]`), not a literal. Caught by measurement — the
first version matched fullwidth digits everywhere except the anchor character, so a fullwidth phone
number was missed entirely while every other fullwidth case worked. — ถ้าผิด: fix ที่ดูครบแต่พลาด
หนึ่งใน pattern

Ruling: #100 stays OPEN, deferred to key context (`createdAt`, `_at`) rather than arithmetic.
`scrubString` sees a string with no idea which key it came from, so that is a real change and it
closes no leak. Recorded in the issue AND pinned by tests that assert today's behaviour, so whoever
implements it sees exactly which assertions they are changing.

Residual declared: a 14-digit migration id still matches `credit_card`. Narrowing the 13-16 range
would stop matching real cards. Same class as #100, same answer.

## What I got wrong, corrected by mutation

Ruling: the `long_digit_run` comment first claimed its LAST position was "part of the fix". Mutation
B moved it to the front and **all 169 tests stayed green**. Measured why: the two patterns are
DISJOINT — the digit lookarounds stop `credit_card` matching inside a run of 17+ and stop
`long_digit_run` matching 16 or fewer. The comment now says the order is not load-bearing and names
what the disjointness actually depends on. An unfalsifiable claim in a comment is worse than no
comment: the next reader defends a property nothing holds. — ถ้าผิด: คอมเมนต์ที่อธิบายเหตุผลที่ไม่มีอยู่จริง

## TL-1 pre-read, applied (comments and ledger only, no behaviour change)

Ruling: my "ORDER IS NOT LOAD-BEARING" comment was too broad and TL-1 was right to catch it.
Measured: `credit_card` DOES match `1234567890123` — 4+4+4+1 with the separators absent. So
`thai_national_id` running first is the only reason a national id is labelled as one rather than as
a card, and THAT ordering is load-bearing. The comment now says which pattern's position does not
matter (`long_digit_run`'s) and which does. — ถ้าผิด: คนที่มาสลับลำดับทีหลังอ่านคอมเมนต์ผมแล้วเชื่อว่า
ลำดับไม่สำคัญ แล้วเลขบัตรประชาชนทุกใบถูก label เป็นเลขบัตรเครดิต

Residual declared, measured with exact codepoints: the DIGITS are handled, the SEPARATORS are not.
`credit_card`'s `[ -]?` is ASCII-only —

    １２３４ ５６７８ ９０１２ ３４５６   (ASCII space)  → redacted
    １２３４　５６７８　９０１２　３４５６   (U+3000)       → NOT redacted
    1234－5678－9012－3456              (U+FF0D)       → NOT redacted

Ruling (PMO): NOT closed in #118. Widening the separator class is a different change from widening
the digit class and needs its own fixture — one where the separator is the only variable. Own issue.
— ถ้าผิด: fix สองอย่างในเทสชุดเดียว แล้วไม่รู้ว่าอันไหนทำให้ผ่าน

## Evidence

`auditRedaction.test.js` **169 passed** (148 before + 21).

Fixture checksums verified rather than assumed: `1101700000001` passes Thai mod-11,
`1234567890123` fails it, `4111111111111112` fails Luhn.

### Mutations — each named at the test it takes red (§7.9f)

| mutation | test that goes red |
|---|---|
| remove `long_digit_run` | `redacts 17 digits`, `redacts 20 digits`, `redacts 32 digits`, `redacts 17 fullwidth digits` |
| revert the classes to ASCII `[0-9]` | `redacts a fullwidth national id`, `… phone number`, `… card number`, `redacts a number mixing fullwidth and ASCII digits`, `redacts 17 fullwidth digits` |
| narrow `thai_national_id` (stand-in for a checksum) | `redacts a Thai national id with an INVALID checksum` + 4 others |
| move `long_digit_run` first | **NONE — 169 green.** Recorded above; the comment was corrected rather than the test strengthened, because the property it claimed does not exist |

### Note on the authorization suites

`--findRelatedTests utils/events/redaction.js` reports 13-21 failing suites under
`__tests__/security/authorization/`, VARYING BETWEEN RUNS. Measured three ways: every named suite
passes alone (explainAccess 4/4, chatSearchSelfOnly 26/26, viewAsUser 4/4, grantManagement 9/9,
orgMemberAction 15/15, uiBypassStillRefused 11/11); the same directory run on UNMODIFIED main fails
50 tests; and on a freshly bootstrapped database it fails a different number again. They share one
database and collide in parallel — the #57 family, not this change. `__tests__/utils/events/` on the
fresh database is 169/169.

# Ledger — #131 (one invisible character defeated every pattern)

auth tier. Three files: `server/utils/events/redaction.js`,
`server/__tests__/utils/events/auditRedaction.test.js`,
`server/__tests__/utils/diagnostics/bundle.test.js`.

## Recon, measured on `da2cb0cd8`

Confirmed Dev2's table and added three codepoints they had not tried. TL-2 then measured 19 against
all six patterns and found no pattern survives any of them — which is the right way to read this:
**it is not a list of bad characters, it is a property of every pattern that matches adjacent
characters.** Any count is a sample, so no number appears in the class's documentation.

Every one made a value invisible to EVERY pattern, with the row recording `redactions: []`.

Empty `redactions` is the sharp edge: it is positive evidence of cleanliness that is false, where a
visibly mangled value would at least look wrong.

**Dev2's email fixture passed by luck**, and the RF list had to change because of it. Measured:

    "vic<ZWSP>tim@example.com"  ->  "vic<ZWSP>[redacted:email]"   partial, and it LOOKS handled
    "victim@exa<ZWSP>mple.com"  ->  unchanged                      full leak

RF-2 as filed ("`redactions` is non-empty") PASSES on the first case while `vic` is still in the
row. PMO accepted the correction: RF-2 asserts the VALUE is gone. Every fixture here asserts on the
value, never on the marker or the array.

## Rulings

Ruling: strip, then match, as ONE function. Stripping without re-running the patterns removes the
disguise and leaves the value — the worst of both outcomes. — ถ้าผิด: ลบเครื่องปลอมตัวออก แล้วเก็บ
ค่าจริงไว้เต็ม ๆ

Ruling: NOT NFKC, and TL-2 supplied a second reason worth recording. The first is the one this file
already gives: NFKC changes LENGTH (`ﬁ`→`fi`, `㍿`→`株式会社`), so scrub-then-map-offsets-back is
unsound. The second is that NFKC folds `１２３４` to `1234` and `－` to `-`, which would make the
fullwidth digit class (#118) and the separator class (#120) DEAD CODE — a normalisation step would
silently undo two merged issues. Stripping is different in kind: every codepoint in the union is
length-reducing by exactly one and nothing is substituted.

Ruling REVISED after TL-2 — the class is a UNION OF TWO PROPERTIES and carries no hand-list at all.
The first SHA shipped `\p{Cf}` + an explicit `U+034F`, which TL-2 showed was two codepoints short
(U+17B4/U+17B5, Khmer inherent vowels, also `Mn`). Rather than lengthen the list — #71 already
shipped the lesson that an enumeration misses its next member, `apw-tat-` escaping a three-prefix
alternation — I measured which PROPERTY names the class, and both halves turned out to be load
bearing:

    \p{Cf} alone                          misses U+034F, U+17B4, U+17B5 (all Mn, all defeat)
    \p{Default_Ignorable_Code_Point} alone misses 32 Cf codepoints that also defeat —
                                          U+0600-U+0605, U+06DD, U+070F, U+0890, U+0891,
                                          U+08E2, U+FFF9-U+FFFB, U+110BD, U+110CD,
                                          U+13430-U+1343F

So the class is their union, and every codepoint TL-2 named is covered by a property rather than by
being remembered. — ถ้าผิด: list ที่พลาดสมาชิกตัวถัดไปเสมอ

Ruling: NOT `\p{Mn}` at large. Measured: 1818 `Mn` codepoints defeat a pattern, but they include
every Thai and Vietnamese diacritic — stripping those turns `สวัสดีครับ` into `สวสดครบ`.
Default_Ignorable is precisely the property meaning "not intended to be seen", which is the class
actually at issue. Verified that Thai and NFD Vietnamese pass the union untouched. — ถ้าผิด: ทำลาย
ข้อความไทยและเวียดนามทุกแถวเพื่อปิดรูที่ปิดได้อยู่แล้ว

Ruling REVISED after QA-2 F1 — the strip is PER MATCH, not whole-string. The earlier rule rewrote
the entire value on any hit; QA-2 measured a field holding Thai text plus a national id losing all
four of its ICU word-boundary marks. TL-2 then named the case that actually forces it, and it is
not Thai: **U+FE0F VARIATION SELECTOR-16 is Default_Ignorable**, so a whole-string strip turns `❤️`
into `❤` and `1️⃣` into `1` — a field is silently RE-RENDERED because something else in it was PII.
Now only the spans the patterns claimed are rewritten; an invisible character inside a match still
goes with the value it was disguising. — ถ้าผิด: ฟิลด์ถูกเขียนใหม่ทั้งก้อนเพราะมีอย่างอื่นในนั้นเป็น PII

Ruling: the offset map is an ARRAY, never arithmetic, and it is indexed in CODE UNITS. `origin[i]`
records which index of the original produced `stripped[i]`. Sliding by a running count is wrong by
one per codepoint removed before that point (TL-2 measured it cutting a character short), and a map
built by counting CODEPOINTS while `exec`/`slice` count UNITS slides by one per astral character and
cuts into a surrogate pair — which yields a lone surrogate rather than an error, so it corrupts
silently. — ถ้าผิด: ตัดกลาง surrogate pair แบบไม่มี error ให้เห็น

Ruling: an overlap goes to whichever pattern comes first in `PATTERNS`, preserving the precedence
the sequential replace already had — `1234567890123` stays a `thai_national_id` rather than becoming
a `credit_card` (which reads 13 digits as 4+4+4+1). Asserted on the LABEL, not on the fact that
something was redacted.

Ruling: **U+2800 BRAILLE PATTERN BLANK is OUT**, and it does defeat the patterns. It is `So` —
printing, with advance width, blank only in a braille font — so it is not "not intended to be seen",
which is what the class means. Admitting it would make the rule "anything hard to see", which has no
property behind it and returns to the hand-list this issue just removed. Recorded as a residual, not
an oversight. — ถ้าผิด: class ไม่มีนิยาม กลายเป็น list ที่พลาดสมาชิกตัวถัดไปเสมอ

Ruling: keep the STRIPPED value when a pattern hits; return the ORIGINAL byte-identical when
nothing hits. A hit means the value was PII wearing a disguise, and keeping the disguise beside
`[redacted:…]` preserves the evasion attempt for no benefit. No hit means ordinary text —
`utils/TextSplitter/index.js:176` inserts U+200B at ICU word boundaries because Thai has no spaces
between words, so a strip that rewrote every value would corrupt our own output.

Ruling: the strip runs on the ORIGINAL, not on the already-scrubbed output. A marker substituted in
by the first pass would hide the rest of the value from the second.

Ruling: a value carrying invisible characters is NOT flagged when nothing matches. Dev2 proposed it;
declined, because `TextSplitter` produces exactly this shape legitimately, so the flag would fire on
our own output — and #94's lesson is that a signal firing on correct input gets ignored. — ถ้าผิด:
signal ที่ยิงใส่ output ของตัวเองจนไม่มีใครอ่าน

## `utils/diagnostics/index.js` — measured, and NOT changed

PMO asked for measurement rather than assumption. Through `scrubText` itself, before the fix:

    "note id 123456<ZWSP>7890123"             unchanged, no hits     <- the gap
    "code apw-inv-ABCDEFGH<ZWSP>IJKLMNOP"     unchanged, no hits     <- the gap
    "postgresql://ap<ZWSP>puser:s3cret@h/db"  already stripped
    'failed for user "ap<ZWSP>puser"'         already stripped

The bundle's own two regexes survive because they match on STRUCTURE (`://…@`, `for user "…"`),
not on the username's characters. The gap was the shared pattern scan, which `scrubText` reaches
through `scrubValue` — so the bundle inherits the fix and the file needs no edit.

That is a fact about today's call graph, not a contract. If someone later gives `scrubText` its own
scan, the bundle leaks again with every audit-side test still green, so RF-4 has its own tests on
the real `scrubText`, and the RF-5 mutation is checked against BOTH suites.

## Evidence

`npx jest __tests__/utils/events/auditRedaction.test.js __tests__/utils/diagnostics/bundle.test.js`
→ **354 passed** (audit 300, bundle 54). With the whole events and diagnostics trees plus
`routeGateSweep`: **387 passed**.

RED against the seal as main ships it: **96 failed** — 16 codepoints × 4 secret shapes, both email
halves per codepoint, the nested `changes: {code}` path #71 exists to close, and the bundle suite.
The six tests added for TL-2 are named individually so a regression says WHICH property broke:
`TL-2 (1): the leaked TAIL is gone, not merely relabelled`, `TL-2 (2): the shape that fools a
filter — hits non-empty, PII still there`, `TL-2 (4): several classes in ONE string are each cut in
the right place`, both `TL-2 (5)` depth tests, and `Thai and Vietnamese DIACRITICS are not
stripped, even beside PII`. All four "what must NOT change" controls were green BEFORE and after: they pin
behaviour rather than the fix.

### Mutations, each named at the test it takes red (§7.9f)

| mutation | result |
|---|---|
| strip but do not re-run the patterns (RF-5) | **74 red across BOTH suites** — the disguise goes, the value stays |
| `\p{Cf}` only, dropping the Default_Ignorable half | 17 red — the `U+034F`, `U+17B4` and `U+17B5` blocks |
| explicit list only, no category | 46 red — every codepoint outside the list |
| keep the stripped value even when nothing matched | 3 red: `Thai text carrying U+200B from TextSplitter is byte-identical`, `a value with an invisible character but no PII is untouched`, and the bundle's `legitimate text carrying U+200B still reaches the bundle intact` |
| `\p{Default_Ignorable_Code_Point}` only, dropping `\p{Cf}` | 15 red — the U+0600 and U+13430 blocks |
| add `\p{Mn}` at large to the class (over-strip) | `Thai and Vietnamese DIACRITICS are not stripped, even beside PII` |
| whole-string strip on a hit (the rule QA-2 rejected) | 5 red: `invisible characters OUTSIDE the match survive a redaction`, `a variation selector next to PII keeps its emoji intact`, `an invisible character immediately BEFORE and AFTER a match survives`, `a RUN of invisible characters on both sides survives`, `NON-BMP: a separator outside the BMP does not corrupt the span` |
| use the stripped offsets directly instead of the `origin` map | 5 red, incl. `TL-2 (4): several classes in ONE string are each cut in the right place` |
| build `origin` by counting CODEPOINTS instead of code units | `NON-BMP: a separator outside the BMP does not corrupt the span` |
| drop the overlap guard | 3 red, incl. `OVERLAP: the first pattern in the list claims the span, and the label says so` |

**The codepoint-counted map survived its first run**, and the fixture had to be strengthened rather
than the result accepted. An astral SEPARATOR does not distinguish the two maps — the only astral
characters present are the ones being deleted, so both answer alike. What separates them is astral
CONTENT that SURVIVES before the match: each one costs the map a unit and slides the cut left.
Measured on that mutant: `😀😀 id 12[redacted:…]ail`.

**The over-strip mutation SURVIVED the first time it was run**, and that is the finding worth
keeping: nothing in the suite objected to stripping every Thai and Vietnamese diacritic, because
every over-strip control used a value that did not match a pattern — and a value with no hit is
returned untouched whatever the class does, so those controls could not see it. The test that
catches it puts the diacritics BESIDE a real redaction, which is the only arrangement where the
class's width is observable.

**One NIT is deliberately NOT claimed as covered.** `INVISIBLE` is non-global because `.test` on a
`/g` regex advances `lastIndex` between calls. Flipping it to `/g` leaves all 354 green — measured,
not assumed: every string reaching the loop is tested against single characters, where `lastIndex`
resets on each failure and the alternating answers land the same way. It is a latent trap for the
next caller rather than a live defect, so the code is written correctly and the comment says no test
pins it. The `/g` twin the whole-string version needed was deleted rather than left unused. A test
was written for it and then REMOVED, because it passed on the mutant and would have been a false
claim of coverage.

Two of these first reported "DID NOT APPLY" and were re-run rather than counted — the source stores
`͏` as escape TEXT, so a replacement written with the literal character matches nothing. Per
§7.17, a mutation that does not change the file is not a survivor; every mutation above is asserted
to have applied before its result was read.

# Ledger — #131 (one invisible character defeated every pattern)

auth tier. Three files: `server/utils/events/redaction.js`,
`server/__tests__/utils/events/auditRedaction.test.js`,
`server/__tests__/utils/diagnostics/bundle.test.js`.

## Recon, measured on `da2cb0cd8`

Confirmed Dev2's table and added three codepoints they had not tried. Twelve in total, and every
one made a value invisible to EVERY pattern, with the row recording `redactions: []`:

    U+200B U+200C U+200D U+2060 U+FEFF U+00AD U+180E U+034F U+200E
    U+061C (Arabic letter mark)  U+2066 (LTR isolate)  U+FFF9 (interlinear anchor)

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

Ruling: NOT NFKC. This file already rejects normalisation one screen up because NFKC changes LENGTH
(`ﬁ`→`fi`, `㍿`→`株式会社`), so scrub-then-map-offsets-back is unsound. Stripping is different in
kind, and it was measured rather than argued: every one of the twelve is length-reducing by exactly
one, and nothing is substituted.

Ruling: `\p{Cf}` PLUS an explicit `U+034F`. Measured: 11 of the 12 are `Cf`, but U+034F COMBINING
GRAPHEME JOINER is `Mn` and the category alone walks past it. A bare category is not enough, a bare
list is not future-proof. — ถ้าผิด: เหลือรูไว้หนึ่งตัวที่เทสของตัวเองจับได้พอดี

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
→ **320 passed**.

RED before the change: **71 failed** — 61 in the audit suite (12 codepoints × 4 secret shapes, plus
both email halves per codepoint, plus the nested `changes: {code}` path #71 exists to close) and 10
in the bundle suite. All four "what must NOT change" controls were green BEFORE and after: they pin
behaviour rather than the fix.

### Mutations, each named at the test it takes red (§7.9f)

| mutation | result |
|---|---|
| strip but do not re-run the patterns (RF-5) | **74 red across BOTH suites** — the disguise goes, the value stays |
| `\p{Cf}` only, dropping `U+034F` | 7 red, all in the `U+034F combining grapheme joiner` block: `a national id/phone/card/credential carrying it is redacted, and the digits are GONE`, both email halves, and the bundle's own U+034F rows |
| explicit list only, no category | 46 red — every codepoint outside the list |
| keep the stripped value even when nothing matched | 3 red: `Thai text carrying U+200B from TextSplitter is byte-identical`, `a value with an invisible character but no PII is untouched`, and the bundle's `legitimate text carrying U+200B still reaches the bundle intact` |

Two of these first reported "DID NOT APPLY" and were re-run rather than counted — the source stores
`͏` as escape TEXT, so a replacement written with the literal character matches nothing. Per
§7.17, a mutation that does not change the file is not a survivor; every mutation above is asserted
to have applied before its result was read.

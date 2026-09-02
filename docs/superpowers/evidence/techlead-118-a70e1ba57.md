# Techlead-1 — #118 `a70e1ba57` (fullwidth digits + long digit runs)

3 files, +250/-3: `redaction.js` (+59/-3), `auditRedaction.test.js` (+121), ledger. Probes are
in-process `node -e` against the committed `redaction.js`; no suite run (§7.14).

**Verdict: PASS.** The boundary case PMO asked about is handled, and handled the way that
matters — not by the lookaround alone. One gap worth a residual line, one RF I would add.

## The lookaround boundary — the concern is real and the SHA does not have it

PMO's worry: `(?<!\d)` excludes only ASCII, so `１２３` + 13 ASCII digits would break into two
matches. **The code does not use `\d`.** All three anchors are built from the same class:

```js
const D           = "[0-9０-９]";
const NOT_D       = "(?<![0-9０-９])";
const NOT_D_AFTER = "(?![0-9０-９])";
```

Probed the exact case and its mirror:

| input | result | class |
|---|---|---|
| `１２３` + `1234567890123` (3 fw, 13 ascii) | `[redacted:credit_card]` | one match, whole run |
| `1234567890123` + `１２３` (13 ascii, 3 fw) | `[redacted:credit_card]` | one match, whole run |
| `１２３4567890123` (mixed, 13 total) | `[redacted:thai_national_id]` | ✓ |
| `1234567890１２３` (mixed, 13 total) | `[redacted:thai_national_id]` | ✓ |
| `０８１２３４５６７８` (fullwidth phone) | `[redacted:phone_th]` | ✓ |
| `0８1234567８` (mixed phone) | `[redacted:phone_th]` | ✓ |
| `note_１２３４５６７８９０１２３` | `note_[redacted:...]` | underscore boundary still works |

The 16-digit mixed run classifying as `credit_card` rather than splitting is exactly the
right answer: the lookarounds refuse to let `thai_national_id` claim the first 13 of a longer
run, so the value is redacted **whole** under a broader label rather than half-redacted under
a precise one. Half a card number left in the clear is the failure that would matter.

The `phone_th` anchor being `[0０]` rather than a literal `0` is the detail that would have
been missed by a mechanical `\d` → class substitution, and the comment says so.

## Dev5's ordering claim — verified independently, and their correction is right

Dev5 says order is not load-bearing because the lookarounds make the patterns disjoint, and
that the first version of the comment claimed otherwise. I re-derived it rather than trusting
the 169-green result: ran the four numeric patterns in four different orders over five
representative values.

```
value                 1023(shipped)      credit-first    reversed       phone-first
1234567890123         thai_national_id   credit_card     credit_card    credit_card
1234567890123456      credit_card        credit_card     credit_card    credit_card
0812345678            phone_th           phone_th        phone_th       phone_th
12345678901234567     long_digit_run     long_digit_run  long_digit_run long_digit_run
0123456789012         thai_national_id   credit_card     credit_card    credit_card
```

So the corrected comment is right about `long_digit_run` — moving it anywhere changes
nothing — but **order still matters between `thai_national_id` and `credit_card`**. A 13-digit
value is claimed by whichever of the two runs first, because `credit_card`'s `{1,4}` tail lets
it match 13 as `4+4+4+1`. The shipped order puts `thai_national_id` first, which is correct
and is what the original comment at `:60-61` says.

The comment as written is accurate — it scopes its claim to `long_digit_run` and to the
disjointness *that pattern* has. I raise it only because a reader skimming "the ORDER IS NOT
LOAD-BEARING" in capitals may carry it further than the paragraph intends. One clause
("...for this pattern; the national-id/card ordering above still is") would close it.

Everything else in the correction is the right shape: the comment was found wrong **by
mutation**, and the replacement names what the disjointness depends on rather than restating
the conclusion.

## The no-checksum decision

Measured claim accepted: Thai mod-11 passes 9.1% of ms timestamps and Luhn passes
`20260902050000`, a real migration id in this tree. So a checksum buys about an order of
magnitude less noise and costs **fail-open on mistyped real PII** — someone's ID with a
transposed digit stops being redacted. For a redaction layer that is the wrong direction, and
two tests pin it (`redacts a Thai national id with an INVALID checksum`, `redacts a card
number failing Luhn`), so adding one later fails loudly. Correct call, correctly fenced.

## Digit-run coverage, measured end to end

| length | class |
|---|---|
| 12 | none (unchanged, deliberate) |
| 13 | `thai_national_id` |
| 14–16 | `credit_card` |
| 17+ | `long_digit_run` |

No gap between 13 and 17 — that was #101's hole and it is closed. `12345678901234567` and its
fullwidth twin both land on `long_digit_run`. Adjacent runs still separate correctly:
`<16 digits> <13 digits>` yields two distinct labels.

## OBS-1 — fullwidth SEPARATORS are still uncovered, and the residual should say which half is covered

The digit classes are fullwidth-aware; the **separators** in `credit_card` are not:

```js
`${D}{4}[ -]?${D}{4}...`     // ASCII space and ASCII hyphen only
```

Measured:

| input | result |
|---|---|
| `１２３４ ５６７８ ９０１２ ３４５６` (fw digits, ASCII space) | **redacted** ✓ |
| `１２３４　５６７８　９０１２　３４５６` (ideographic space U+3000) | **not redacted** |
| `1234－5678－9012－3456` (fullwidth hyphen U+FF0D) | **not redacted** |
| `１２３４,５６７８,...` (comma) | not redacted (also true for ASCII commas — out of scope) |

The realistic case is the one that is covered: a CJK IME produces fullwidth digits while the
space bar still produces an ASCII space. But a card pasted from a document typeset with
ideographic spacing is not exotic, and the issue's own framing ("an ID typed on a Japanese or
Chinese IME") is exactly the population that would produce U+3000.

**Not a blocker** — the unseparated 16-digit form is caught either way, and this is a
one-line change (`[ 　-－]?`) whenever someone wants it. But the residual currently reads as
"fullwidth digits are handled", and the honest version is *fullwidth digits are handled;
fullwidth separators between them are not.* Same discipline the file already applies to the
other Unicode digit families, which **are** named as unmatched (Arabic-Indic and Devanagari —
I confirmed both pass through untouched, matching the comment).

## RF I would add

```
RF-x  card written with fullwidth digits AND an ideographic space U+3000
      mutation : (whichever separator class is added later)
      green why: the ASCII-space fixture already in the suite passes today with
                 no separator change at all, so it cannot witness this. The
                 separator is the only variable that must differ.
```
Only worth writing if PMO decides to cover separators. If the decision is to leave them, the
residual line above is the deliverable instead — and it should name U+3000 and U+FF0D
specifically, because "some separators" is the kind of residual nobody can act on later.

## Not raised

`leaves fullwidth TEXT alone` is the control that stops the digit classes being over-broad.
The `#100` deferral is pinned by tests rather than assumed, which is the right way to record
a deferral. `apw-*-` credentials in fullwidth letters are not matched, but that generator only
ever emits ASCII, so it is not reachable.

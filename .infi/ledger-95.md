# Ledger — #95 (PDPA `\b` anchor hotfix)

Ruling: split out of #94 rather than folded into it — PMO ruling, accepted. Because the file is
outside #94's lane and would trip the gate's forbidden-file check, because it leaks PII on main
today and should merge ahead of O5b, and because #94's reviewer should not have to adjudicate PII
regexes. — ถ้าผิด: เสียเวลาเปิด issue เพิ่มห้านาที

Ruling: digit lookarounds `(?<!\d)…(?!\d)` rather than removing the bound entirely — the bound is
load-bearing: without it a 16-digit card number has its first 13 digits claimed by
`thai_national_id` and the remaining 3 left in the clear. — ถ้าผิด: เลขบัตรหลุดบางส่วนแทนที่จะถูกลบ
ทั้งก้อน ซึ่งแย่กว่าเดิมเพราะดูเหมือนถูก redact แล้ว

Ruling: `email` is left alone — it has no `\b` and its character class already excludes nothing
that matters here. Touching it would be an unrequested change to a pattern with no defect. —
ถ้าผิด: เปลี่ยน pattern ที่ไม่ได้พัง แล้ว regression ที่ตามมาไม่มีใครโยงกลับมาที่ commit นี้

Ruling: four tests, one of which is a NEGATIVE CONTROL (`ordinary_workspace_name` must survive) —
without it, "delete the anchor" passes all three positive tests. A bound that matches everything is
not a bound. — ถ้าผิด: เทสเขียวบน fix ที่ over-redact ทุก audit row ที่มีตัวเลข

Ruling: tests go in `auditRedaction.test.js` beside the existing `\b` concatenation test for the
credential family, not in a new file — they are the same defect one class over, and the reader who
finds one should find the other. — ถ้าผิด: คนแก้ pattern รอบหน้าเห็นเทสแค่ครึ่งเดียว

## Evidence

RED (fix reverted, tests present): 3 failed / 1 passed — the three positives red, the negative
control green.
GREEN: `auditRedaction.test.js` 148 passed (144 existing + 4).
Related: `npx jest --findRelatedTests utils/events/redaction.js` → 1815 passed, 11 skipped.
`__tests__/jobs/providerDocIdCallSites.test.js` failed only inside that 139-suite parallel run and
passes 20/20 on its own on this branch and on unmodified main — a pre-existing flake under load,
not this change.

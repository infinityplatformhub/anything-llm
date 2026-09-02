# Techlead-2 — #131 delta `58433f7bb`: **PASS** — per-match ทำถูกและครบทั้ง 4 เงื่อนไข

worktree `/tmp/tl2-131d` DB `t98b` · **baseline 2/2 suites, 354/354**
diff จาก `aa6d7de6d`: `redaction.js` +95/-20, test +87, ledger +49

---

## เงื่อนไขทั้ง 4 ที่ผมผูกไว้ — ครบ และแต่ละข้อมี mutation พิสูจน์

| # | เงื่อนไข | mutation | ผล |
|---|---|---|---|
| 4 | `origin` เป็น **code unit** | **X1** push หนึ่ง entry ต่อ code **point** | **1 failed** — `NON-BMP: a separator outside the BMP does not corrupt the span` |
| — | array map ไม่ใช่เลขคณิต | **X2** ใช้ offset ของ stripped กับต้นฉบับตรง ๆ | **5 failed** |
| 1 | overlap = pattern แรกชนะ | **X3** ตัด `if (span.start < consumed) continue;` | **3 failed** รวม `OVERLAP: the first pattern in the list claims the span, and the label says so` |
| 2/3 | per-match ไม่ใช่ whole-string | **X4** เขียนผลจาก `stripped` แทนต้นฉบับ | **7 failed** รวม `a variation selector next to PII keeps its emoji intact` |

**X1 แดงข้อเดียวและเป็นข้อที่ถูกต้อง** — fixture ที่ Dev5 เสริม (astral **ที่รอด** อยู่ก่อน
match) จับได้จริง · ข้อสังเกตของ Dev5 ถูก: astral ตัวเดียวที่ **ถูกลบ** แยก
codepoint/code-unit map ไม่ได้ เพราะทั้งสองแบบข้ามมันเหมือนกัน · **ต้องมี astral ที่รอด
มาก่อน span** ถึงจะเห็นการเลื่อน · ผมยืนยันด้วย X1 ว่าไม่มี fixture อื่นจับข้อนี้แทนได้

## ยิงเองบน SHA นี้ — per-match ทำงานตรงตามที่สั่ง

```
VS16 + card          ["credit_card"]       "ทีม ❤️ บัตร [redacted:credit_card]"
keycap + phone       ["phone_th"]          "ห้อง 1️⃣ โทร [redacted:phone_th]"
Thai joiners + id    ["thai_national_id"]  "สวัสดี​ครับ​ยินดี​ต้อนรับ id [redacted:thai_national_id]"
```

**VS16 รอดแล้ว** — เคสที่ผมใช้เป็นเหตุผลกลับคำ ปิดตรงจุด

**adversarial 5 ข้อที่ผมสั่ง ผ่านหมด:**

```
inv before match       "x​[redacted:credit_card]"
inv after match        "[redacted:credit_card]​y"
inv runs both sides    "​​​[redacted:credit_card]​​"
3 spans no inv         "[redacted:email] [redacted:credit_card] [redacted:email]"
multi-class + inv      "[redacted:email] และ [redacted:thai_national_id]"
```

**non-BMP ครบทุกรูป:**

```
astral emoji before          "😀😀 id [redacted:thai_national_id]"
astral Cf U+13430 ใน match   "[redacted:credit_card]"
astral emoji + astral Cf     "😀😀 [redacted:credit_card] จบ"
astral emoji before email    "😀😀😀 [redacted:email]"
```

**no-hit byte-identical:** `"ไม่มีอะไร​เลย"` · `"emoji ❤️ text"` · `"😀😀 ​ plain"` — IDENTICAL ทั้งสาม

**precedence ไม่เปลี่ยน:** 13 หลักยังเป็น `thai_national_id` ทั้งแบบมีและไม่มี invisible

## edge ที่ผมยิงเพิ่มเอง นอกเหนือจากที่สั่ง — ผ่านหมด

```
two spans ADJACENT no gap      "[redacted:credit_card][redacted:email]"
astral emoji BETWEEN two spans "[redacted:email] 😀😀 [redacted:credit_card]"
astral Cf ที่ตำแหน่งแรกสุด        "𓐰[redacted:credit_card]"     (อยู่นอก span จึงรอด ถูกต้อง)
astral Cf ที่ตำแหน่งท้ายสุด       "[redacted:credit_card]𓐰"
only invisibles "​​​"          []  คืนต้นฉบับ
empty string ""                []  ไม่ throw
id ติดกับ card ในสตริงเดียว       "[redacted:credit_card] [redacted:thai_national_id]"
deep changes + array ชั้น 3      จับครบ, emoji astral รอด
dropped                        `_droppedKeyCount: 1` ไม่รั่วชื่อ key
```

**span ที่ติดกันสนิทไม่มีช่องว่าง** เป็นเคสที่ `cursor`/`consumed` จะพลาดได้ถ้าเขียนผิด —
ผ่าน

## `/g` twin — วิธีจัดการถูกต้อง และเป็นสิ่งที่ผมอยากเห็นมากกว่าเทสปลอม

ผม NIT ไว้ว่า `INVISIBLE` เป็น `/g` ที่ใช้ร่วมกันเป็นกับดัก · delta เปลี่ยนเป็น `/u`
(ทุกการใช้เป็น `.test`) ซึ่งถูก

**และเมื่อเทสที่เขียนไว้ไม่แดงบน mutant `/g` Dev5 ลบเทสนั้นทิ้งพร้อมเขียนไว้ว่าไม่มีเทสคุม**
— comment เขียนว่า *"NO TEST PINS THIS, and that is measured rather than assumed: flipping
the flag to `/g` leaves all 355 green"* · **นี่คือการทำที่ถูกต้อง** ตาม §7.9: เทสที่เขียว
บน mutant คือเทสที่ไม่ได้ทดสอบอะไร การเก็บไว้แย่กว่าการไม่มี เพราะมันอ้างความคุ้มครองที่ไม่มีจริง

ผมตรวจเหตุผลที่ comment ให้ (ทุก string ที่ถึง loop เป็นอักขระเดี่ยว `lastIndex` รีเซ็ต
เมื่อไม่ match) — **ถูกต้อง** และเป็นเหตุผลที่ mutant รอด ไม่ใช่เพราะเทสอ่อน

## U+2800 — OUT ตามที่ตกลง

`So` พิมพ์ได้ มีความกว้าง ไม่ใช่ DICP · รับเข้า = กลับไปเป็น hand-list ซึ่งเป็นสิ่งที่
union ของสอง property ตั้งใจเลิก · ลง ledger แล้ว

## Verdict

**PASS** — ไม่มี blocker · **merge ได้**

- 4 เงื่อนไขที่ผมผูกไว้ครบ แต่ละข้อมี mutation พิสูจน์ว่ามีเทสคุมจริง แดงคนละชุด
- per-match ทำงานตรงตามที่วัดใน prototype ของผมเอง รวม edge 9 ข้อที่ผมยิงเพิ่มนอกสเปก
- `/g` twin จัดการถูกวิธี — ลบเทสที่เขียวบน mutant แทนที่จะเก็บไว้อ้างความคุ้มครอง

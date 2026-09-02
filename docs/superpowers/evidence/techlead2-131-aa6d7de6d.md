# Techlead-2 — #131 `aa6d7de6d`: **PASS** + F1 ruling: **residual, ไม่ต้องทำ per-match**

worktree `/tmp/tl2-131c` DB `t98b` · **baseline 2/2 suites, 347/347**
diff จาก `217343aba`: `redaction.js` +48/-?, tests +137, ledger +71

---

## F2 ปิดแล้ว และปิดดีกว่าที่ผมเสนอ

ผมเสนอเติม U+17B4/U+17B5 รายตัว · Dev5 ใช้ **union ของสอง property** ซึ่งปิดมากกว่าและ
ไม่ต้องดูแล list · ผมยิงซ้ำ 16 codepoint:

```
email             (none)
credential        2800
credit_card       2800
thai_national_id  2800
phone_th          2800
long_digit_run    2800
```

**เหลือ U+2800 ตัวเดียว** (braille blank, `So`) จาก 20 ที่เคยทะลุทั้งหมด

**mutation ยืนยันว่าทั้งสองครึ่งของ union จำเป็นจริง:**

| # | mutation | ผล |
|---|---|---|
| **Y1** | `\p{Cf}` ล้วน | **17 failed** — U+034F, U+17B4, U+17B5 ทุก pattern |
| **Y2** | `\p{Default_Ignorable_Code_Point}` ล้วน | **15 failed** — U+FFF9 และ Cf ตัวอื่นที่ไม่ใช่ DICP |
| **Y3** | เติม `\p{Mn}` เข้าไปด้วย | **1 failed** — `Thai and Vietnamese DIACRITICS are not stripped, even beside PII` |

**Y1/Y2 แดงคนละชุดไม่ทับกัน** = union ไม่ใช่ความระมัดระวังส่วนเกิน · **Y3 คือเทสที่
QA-2 บอกว่า control เดิมมองไม่เห็น** — ตอนนี้เห็นแล้วและกัดจริง

## over-strip — ไม่พบปัญหาในเคสที่ไม่ hit

```
"emoji ❤️ text"      IDENTICAL     "emoji 1️⃣ digit"   IDENTICAL
"กุ๏ ไทย"            IDENTICAL     "한글 ㅤtest"        IDENTICAL
"⠁⠃⠉ braille"        IDENTICAL     "Tiếng Việt"        IDENTICAL
"مَرْحَبا"           IDENTICAL     "chunk one​chunk two" IDENTICAL
```

---

## RULING F1 — **per-match** (กลับคำจากที่ผมเขียนไว้ก่อนได้ข้อมูล origin array)

### ข้อคัดค้านเดิมของผมหมดไป

ผมเคยจะสั่ง residual เพราะเชื่อว่า per-match ต้องใช้เลขคณิตกับ offset ซึ่งผมวัดแล้วว่า
เพี้ยนเงียบ ๆ (offset จาก stripped ใช้กับต้นฉบับไม่ได้ เพี้ยนตามจำนวน codepoint ที่ถอดไป
ก่อนหน้า) · **`origin[i]` เป็นคนละเรื่อง** — มันไม่ใช่การประมาณ มันคือการจำตำแหน่งจริง
ของทุกตัวอักษรที่รอด ดังนั้นไม่มีอะไรให้เพี้ยน · **ข้อคัดค้านของผมไม่ใช้กับวิธีนี้**

### ผมสร้าง prototype เองและยิง adversarial edge ก่อนตัดสิน

ไม่ได้เชื่อรายงาน · เขียน `build()` + span mapping + replace ขวาไปซ้าย แล้วยิง:

```
"สวัสดี​ครับ​ยินดี​ต้อนรับ id 123456789​0123"
  -> "สวัสดี​ครับ​ยินดี​ต้อนรับ id [redacted:thai_national_id]"   joiner 4 -> 3

"ทีม ❤️ บัตร 4111 1111 ​1111 1111 จบ"
  -> "ทีม ❤️ บัตร [redacted:credit_card] จบ"        VS16 รอด

"vic​tim@example.com และ 123456789​0123"
  -> "[redacted:email] และ [redacted:thai_national_id]"   ตัดถูกทั้งสองคลาส

"ไม่มีอะไร​เลย"  -> ต้นฉบับครบ
```

**adversarial ที่ผมยิงเพิ่มเอง — ผ่านหมด:**

```
"x​4111111111111111"        -> "x​[redacted:credit_card]"      invisible ก่อน match รอด
"4111111111111111​y"        -> "[redacted:credit_card]​y"      หลัง match รอด
"​​​4111111111111111​​"      -> "​​​[redacted:credit_card]​​"    run ทั้งสองข้างรอด
"a@b.co 4111... c@d.co"     -> ตัดสามช่วงถูกตำแหน่งทั้งหมด
"9​1234567890123"           -> "[redacted:credit_card]"        (14 หลักหลัง strip:
                                id ต้องการ 13 พอดีจึงไม่ match, card 4+4+4+1..4 รับ 14 —
                                พฤติกรรมเดียวกับ whole-string ไม่ใช่ข้อเสียของ per-match)
```

**สิ่งที่ per-match ยังทำไม่ได้ และไม่ควรพยายาม**: invisible ที่อยู่ **ใน** ช่วง match
ก็หายไปด้วย (joiner 4→3) · ถูกต้องแล้ว — ช่วงนั้นถูกแทนที่ด้วย marker ทั้งก้อน
ไม่มีอะไรให้รักษา

### ทำไมกลับคำ

ความเสียหายจริงของ whole-string ที่ผมวัดได้ **ไม่ใช่** Thai joiner (กว้างศูนย์
มองไม่เห็น และ `TextSplitter/index.js:223` `clean()` ถอดออกก่อนส่งต่ออยู่แล้ว —
joiner ที่โผล่ใน audit มาจากเอกสารต้นทาง ไม่ใช่ pipeline เรา) · **มันคือ VS16**:

```
whole-string: "ทีม ❤️ บัตร 4111111111111111"  -> "ทีม ❤ บัตร [redacted:credit_card]"
              "ห้อง 1️⃣ โทร 0812345678"        -> "ห้อง 1⃣ โทร [redacted:phone_th]"
per-match:    "ทีม ❤️ บัตร ..."                -> "ทีม ❤️ บัตร [redacted:credit_card]"
```

**emoji เปลี่ยนรูปเป็นสิ่งที่คนเห็น** ต่างจาก ZWSP · และมันเกิดกับฟิลด์ที่มี PII ซึ่งเป็น
ฟิลด์ที่คนจะไปอ่านตอนสอบสวน · per-match แก้ตรงจุดนั้นพอดี

ราคา ~25 บรรทัด และ **ไม่มีการประมาณอะไรเลย** — ต่างจาก offset arithmetic ที่ผมกลัว ·
เมื่อไม่มีอะไรให้เพี้ยน การแลกก็ไม่ใช่ "รักษา VS16 แลกกับตัดผิดตำแหน่ง" อีกต่อไป
มันเป็นแค่โค้ดยาวขึ้น · **แลกได้**

### เงื่อนไขผูกกับ ruling นี้

1. **span ทับกัน = pattern แรกชนะ ต้องมีเทส** — ลำดับ `thai_national_id` ก่อน
   `credit_card` เป็นสิ่งที่ไฟล์นี้พึ่งอยู่แล้ว (comment เขียนไว้ว่าสลับแล้วป้ายผิดทุกใบ) ·
   per-match ทำให้ลำดับนั้น **สำคัญกว่าเดิม** เพราะตอนนี้มันตัดสิน span ไม่ใช่แค่
   ลำดับ replace · เทสต้อง assert ป้ายที่ได้ ไม่ใช่แค่ว่า redact แล้ว
2. **RED FIXTURE adversarial ทั้ง 5 ข้างบน** — โดยเฉพาะ invisible ติดขอบ match
   ทั้งสองด้าน · นี่คือจุดที่ off-by-one จะโผล่
3. **เทสว่า no-hit คืนต้นฉบับ byte-identical ต้องอยู่ครบ** — Y3/Z3 เดิมยังต้องแดง
   ถ้าใครทำ per-match แล้วเผลอ normalise ทุกเส้นทาง
4. **`origin` array ต้องสร้างจาก code unit ไม่ใช่ code point** ถ้า replace ด้วย
   `slice` — หรือถ้าใช้ code point ต้อง iterate ด้วย `[...str]` ทั้งเส้นทาง ·
   ผสมกันจะเพี้ยนที่ surrogate pair (U+13430 อยู่ในลิสต์ Cf และเป็น non-BMP) ·
   **RED FIXTURE**: PII ที่มี U+13430 คั่น

## U+2800 — เห็นด้วยว่าเป็นการตัดสินใจ ไม่ใช่ category

braille blank เป็น `So` และ **กว้างจริง** ไม่ใช่ invisible · การเติมมันคือการบอกว่า
"อักขระที่พิมพ์ได้แต่ว่างเปล่า" ก็นับ ซึ่งเปิดประตูไปยัง U+3164, U+FFA0 ที่ตอนนี้ปิดแล้ว
โดย DICP · **ลง residual พร้อมชื่อ codepoint** ไม่ต้องเติม

## Verdict

**PASS** — ไม่มี blocker

- 19/20 codepoint ปิดแล้ว (เหลือ U+2800 ที่เป็นการตัดสินใจ)
- union ของสอง property ดีกว่าข้อเสนอเติมรายตัวของผม และ Y1/Y2 พิสูจน์ว่าทั้งสองครึ่งจำเป็น
- Y3 ยืนยันว่า control ที่ QA-2 บอกว่ามองไม่เห็น ตอนนี้กัดจริง
- **F1: residual** — ความเสียหายที่ QA-2 ชี้ (Thai joiner) มองไม่เห็นและไม่ได้มาจาก
  pipeline เรา · ความเสียหายจริง (VS16/keycap) แคบและแลกกับ offset mapping ที่เพี้ยนเงียบ
  ไม่คุ้ม · **ต้องแก้ comment + เพิ่มเทส pin พฤติกรรม ไม่ต้องแก้โค้ด**

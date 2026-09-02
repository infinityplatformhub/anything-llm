# Techlead-2 — #131 `217343aba`: **PASS** + 1 residual ที่ต้องบันทึก (U+17B4/U+17B5)

worktree `/tmp/tl2-131b` donor `/tmp/qa2-84b` DB `t98b`
4 ไฟล์: `redaction.js` +61/-8, `auditRedaction.test.js` +116, `bundle.test.js` +60, ledger +95
**baseline 2/2 suites, 320/320**

---

## รูที่ผม pre-read ปิดแล้ว — วัดเอง ไม่ได้เชื่อคำอธิบาย

ยิงทุก pattern × 20 codepoint บน SHA นี้:

```
pattern           codepoints ที่ยังทะลุ
email             (none)
credential        17B4 17B5
credit_card       17B4 17B5
thai_national_id  17B4 17B5
phone_th          17B4 17B5
long_digit_run    17B4 17B5
```

**18 จาก 20 ปิดหมด** · เทียบกับ pre-read ที่ทะลุครบ 19/19 ทุก pattern

## `redactions` เป็นหลักฐานจริงแล้ว และค่าหายจริง

```
email             ["email"]                         "[redacted:email]"
credential        ["credential"]                    "[redacted:credential]"
credit_card       ["credit_card"]                   "[redacted:credit_card]"
thai_national_id  ["thai_national_id"]              "[redacted:thai_national_id]"
phone_th          ["phone_th"]                      "[redacted:phone_th]"
long_digit_run    ["credit_card","long_digit_run"]  "[redacted:long_digit_run]"
```

**กับดักที่ผมเตือนไว้ปิดแล้ว** — `email` เคยเก็บ `"vic​[redacted:email]"` (รั่ว `vic`
พร้อมป้ายว่า redact แล้ว) ตอนนี้เป็น `"[redacted:email]"` ล้วน ·
`long_digit_run` เคยได้ป้ายผิดเป็น `credit_card` แล้วทิ้งหาง `67890` ตอนนี้ป้ายถูก
และไม่มีหาง

**O5b bundle** — เคสที่ผมบอกว่าหลอกเครื่องมือกรองได้เนียนกว่า `[]`:

```
["credential","credit_card","email"]
"[redacted:email] [redacted:credential] [redacted:credit_card]"
```

เดิม: `["email"]` พร้อม credential และเลขบัตรครบในแถว · ตอนนี้จับครบสามคลาส

## over-strip — ตรวจตามที่ขอ ไม่พบปัญหา

```
"chunk one​chunk two"          [] IDENTICAL
"ไทย​คำ"                        [] IDENTICAL
"กุ๏abc"                        IDENTICAL   (Thai Mn ธรรมดา)
"مَرْحَبا"                      IDENTICAL   (Arabic Mn ธรรมดา)
"អាែ test"                     IDENTICAL   (Khmer ปกติ)
"สันติ 4111111111111111"        -> "สันติ [redacted:credit_card]"  ข้อความไทยไม่ถูกแตะ
```

**`\p{Cf}` ไม่กิน Mn ที่ชอบธรรม** — U+034F ถูกเติมเป็นรายตัว ไม่ใช่เปิดทั้ง `\p{Mn}`
ซึ่งจะกินสระ/วรรณยุกต์ไทยและ harakat อาหรับทั้งหมด · **การเลือกนี้ถูกและเป็นเหตุผลที่
ruling "property + list" ดีกว่า "property กว้าง ๆ"**

## offset mapping — ไม่มีเลย และนั่นถูกต้อง

`scrubString` scan บน stripped แล้ว **return stripped ทั้งก้อน** ไม่ได้เอา offset
กลับไปตัดต้นฉบับ · ตรงกับที่ผมวัดใน pre-read ว่า mapping จะเพี้ยนตามจำนวน codepoint
ที่ถอดไปก่อนหน้า · **ปัญหาถูกออกแบบให้ไม่มี ไม่ใช่ถูกแก้**

deep nesting และ `changes` ผ่านด้วย (ยิงเอง):

```
{changes:{name:"vic​tim@…"}, workspaceName:[[["4111 1111 ​1111 1111"]]]}
-> ["credit_card","email"]  {"changes":{"name":"[redacted:email]"},
                             "workspaceName":[[["[redacted:credit_card]"]]]}
```

strip อยู่ใน `scrubString` จึงเดินถึงทุกความลึกและทุกเส้นทาง · **`dropped` ไม่เปลี่ยน**
— key ที่มี ZWSP ยังถูกนับอย่างเดียว (`_droppedKeyCount: 1`) ไม่รั่วชื่อ

## mutation 4 ตัว จับได้ทุกตัว แดงคนละชุด

| # | mutation | ผล |
|---|---|---|
| **Z1** | ตัด `͏` ออกจาก class เหลือ `\p{Cf}` ล้วน | **7 failed** — U+034F ทั้ง 5 pattern + bundle 2 |
| **Z3** | คืน stripped เสมอ (ไม่เช็ค `matched`) | **3 failed** — `Thai text carrying U+200B from TextSplitter is byte-identical`, `a value with an invisible character but no PII is untouched`, `legitimate text carrying U+200B still reaches the bundle intact` |
| **Z4** | strip จาก `direct.out` แทนต้นฉบับ | **12 failed** — `an email carrying it is redacted in BOTH halves` ทุก codepoint |
| **Z5** | ตัดเส้นทาง strip ทิ้งทั้งหมด | **71 failed** |

**Z1 คือหลักฐานว่า list เสริมจำเป็นจริง** ไม่ใช่ความระมัดระวังส่วนเกิน — `\p{Cf}` ล้วน
เดินผ่าน U+034F และมีเทสต่อ codepoint จับไว้
**Z3 คือหลักฐานว่าเงื่อนไข "เก็บ stripped เฉพาะ hit" load-bearing** — TextSplitter
protection ไม่ใช่คำอธิบายลอย มีเทสสามตัวถือ
**Z4 ตรงกับ comment ในโค้ด** (*"a marker already substituted in would hide the rest"*) —
คำอธิบายนั้นถูกและมีเทส 12 ตัวพิสูจน์

---

## RESIDUAL ที่ต้องบันทึก — **U+17B4 / U+17B5 ยังทะลุ 5 pattern**

```
17B4  Mn:true  Cf:false   card+17B4 -> [] "4111 1111 ឴1111 1111"
17B5  Mn:true  Cf:false   cred+17B5 -> [] "apw-inv-ABCDEFGHIJ឵KLMNOP12"
```

**นี่คือรูปเดียวกับ U+034F เป๊ะ** — `Mn` ที่ `\p{Cf}` ไม่ครอบ และ **มองไม่เห็นเมื่อแสดงผล**
· Unicode ระบุ U+17B4/U+17B5 (Khmer inherent vowels AQ/AA) ว่า **deprecated** —
ไม่ควรปรากฏในข้อความเขมรที่ถูกต้อง จึงเป็น evasion vector ไม่ใช่ตัวอักษรที่ใช้จริง
· ผมยืนยันว่าข้อความเขมรปกติ (`អាែ`) ไม่ถูกแตะ ดังนั้นการเติมสองตัวนี้ **ไม่สร้าง
over-strip**

**ไม่ block** เพราะ: หนึ่งบรรทัดในเทสต่อ codepoint ที่มีอยู่แล้วปิดได้ · และ 18/20 ปิดแล้ว
ซึ่งเป็นการลดพื้นที่โจมตีอย่างมีนัยสำคัญ · **แต่ต้องเลือกอย่างใดอย่างหนึ่ง**:
(ก) เติม U+17B4 U+17B5 เข้า class (สองอักขระ + สองเทส) หรือ
(ข) เขียน residual ให้ตรงว่า `Mn` ที่ยังทะลุมีอะไรบ้าง

**ผมเอน (ก)** — ราคาเท่ากับที่จ่ายไปแล้วสำหรับ U+034F และเหตุผลเหมือนกันทุกข้อ ·
สิ่งที่รับไม่ได้คือ JSDoc ที่เขียนว่า *"11 of the 12 leaking codepoints are Cf, but U+034F
… is Mn"* ซึ่งอ่านได้ว่า U+034F เป็น `Mn` ตัวเดียวที่มีปัญหา — **ผมวัดแล้วว่าไม่จริง**

## ข้อสังเกตอื่น ไม่ block

- **`INVISIBLE` เป็น `/g` ที่ใช้ร่วมกัน** — มี `lastIndex = 0` ก่อน `.test()` แล้ว ซึ่งถูก ·
  `.replace()` รีเซ็ต `lastIndex` เองจึงไม่มีปัญหา · แต่ถ้าใครเพิ่ม `.test()` ที่สอง
  โดยลืมรีเซ็ต จะได้ผลสลับกันทุกครั้งที่เรียก · ถ้าไม่ต้องการ `/g` ตรงนี้เลย
  (`.test` ไม่ต้องการ, `.replace` ต้องการ) แยกเป็นสองค่าคงที่จะไม่มีกับดักนี้
- **scan สองรอบเมื่อมี invisible** — ต้นทุน CPU สองเท่าเฉพาะ string ที่มี Cf ·
  ยอมรับได้และ comment อธิบายไว้แล้ว

## Verdict

**PASS** — ไม่มี blocker · 7 ข้อที่ผมขอใน pre-read มีครบ (assert ค่าหายจริง, O5b bundle,
no-hit ต้อง byte-identical, หลายคลาสในหนึ่ง string, ZWSP ลึกใน `changes`/array, `dropped`
ไม่เปลี่ยน) · ขาดข้อ 7 เพียงบางส่วน: เอกสารยังพูดถึง "12 codepoints" และไม่ได้ระบุว่า
`Mn` ตัวอื่นยังทะลุ — ขอให้แก้พร้อมกับ residual U+17B4/U+17B5

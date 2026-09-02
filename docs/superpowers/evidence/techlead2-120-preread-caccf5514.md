# Techlead-2 — #120 pre-read `caccf5514` (tier `plain`)

worktree `/tmp/tl2-120` (detached) donor `/tmp/qa2-84b` DB `t98b`
**baseline 1/1 suite, 203/203 passed** (จาก 184) · 2 ไฟล์: `redaction.js` +66/-1, `auditRedaction.test.js` +123

**สรุป: PASS พร้อม 1 finding ที่ต้องตัดสิน — ASCII comma เป็น false positive ใหม่ที่เทสไม่มี control**

---

## 1. finding ของ Dev5 (literal vs escape) ถูก และเทสไม่ tautology — วัดแล้ว

M1: เปลี่ยน `SEP` ให้ประกอบจากตัวอักษรจริงแทน escape (`String.fromCharCode`)

```
Tests: 4 failed, 199 passed
  ✕ ASCII full stop does not join four digit groups into a card
  ✕ solidus does not join four digit groups into a card
  ✕ the separator class is a SET, never a range
  ✕ redacts 17 digits
```

**เทส `is a SET, never a range` ไม่ใช่ tautology** — มันไม่ได้ assert ว่า source มี `\u`
(ซึ่งจะจริงเสมอเพราะโค้ดเขียน `\u`) แต่ assert **สองอย่างที่แยกจากกัน**: จำนวน class ที่
ประกอบด้วย escape ล้วน `=== 3` และ source **ไม่มี** `-` ที่ไม่ถูก escape ใน class ·
mutant ทำให้ทั้งสองพัง และ**เทสเชิงพฤติกรรมสองตัว (`.` `/`) พังไปด้วยอย่างอิสระ** —
นี่คือส่วนที่สำคัญ: ถ้าเทส structural ตัวเดียวพังจะเรียกว่า pin เฉย ๆ ได้ แต่ negative
เชิงพฤติกรรมพังพร้อมกันแปลว่ามันจับของจริง

`redacts 17 digits` พังด้วยเป็นผลข้างเคียง — class ที่กลายเป็น "อะไรก็ได้" ทำให้ match
ยาวขึ้นจนกลืนขอบ · เป็นสัญญาณเสริมว่า range mutant กระทบกว้างจริง

## 2. negative axis ที่ผมขอไว้ — ครบ และแต่ละตัวมีน้ำหนัก

`： ＝ ＿ ．` + ASCII `.` `/` + newline + tab ครบตามที่ขอ · ทั้งหมดอยู่ในกลุ่ม
`must NOT redact` ที่ยิงผ่าน `scrubbed()` จริง ไม่ใช่ assert บน regex อย่างเดียว

**zero-width (U+200B/FEFF/AD) ถูกตัดออกโดยตั้งใจและมีเหตุผลเขียนไว้** — ผมยืนยันเอง:

```
clean  zero-width evasion :: "1234​5678​9012​3456"
```

**ยังหลุดจริง** และเป็น evasion vector ที่ตั้งใจได้ · Dev5 บอกว่าแยก issue — **เห็นด้วย**:
zero-width ไม่ใช่ separator ที่คนพิมพ์ มันคือ input normalization ซึ่งต้องแก้ก่อน pattern
ไม่ใช่ในตัว class · แต่ **ต้องมี issue จริง** ไม่ใช่แค่ comment

## 3. mutation — จับได้ทุกตัว แดงคนละชุด

| # | mutation | ผล |
|---|---|---|
| **M1** | `SEP` ประกอบจากตัวอักษรจริง (range) | **4 failed** — `.`, `/`, structural, 17-digit |
| **M2** | ตัด `　` | **3 failed** — `U+3000 ASCII digits`, `U+3000 FULLWIDTH — realistic IME`, `separators MIXED` |
| **M3** | ตัด `,` | **2 failed** — `U+002C comma`, `ASCII comma matches, symmetrically` |
| **M4** | `SEP` บังคับ (ตัด `?`) | **8 failed** — รวม `sixteen CONTIGUOUS digits still redact`, `no raw PDPA value … reaches event_logs` |

M2 พิสูจน์ว่าเทส MIXED ไม่ซ้ำซ้อนกับเทสรายตัว — มันแดงจากการถอด codepoint เดียว
ซึ่งเทสรายตัวของ codepoint นั้นก็แดงอยู่แล้ว แต่ MIXED จับ**การรวมกัน**ที่ per-codepoint
fix จะผ่าน · M4 แดงถึงเทส end-to-end `event_logs` แปลว่าโซ่ยังต่อถึงปลายทางจริง

## 4. FINDING — ASCII comma เป็น false positive ใหม่ และ control ไม่ครอบ

เทียบ pattern เดิม (`c44b059d3`) กับใหม่บนอินพุตเดียวกัน:

```
old-clean  NEW-REDACT  CSV 4 numeric cols      :: "1000,2000,3000,4000"
old-clean  NEW-REDACT  CSV with thousands      :: "cost,1234,5678,9012,3456"
old-clean  NEW-REDACT  comma list of ids       :: "ids: 1001,1002,1003,1004"
old-clean  NEW-REDACT  price list fullwidth ，  :: "価格 1200，3400，5600，7800"
REDACT     chunk sizes 1024,2048,4096,8192
REDACT     order 2024,1001,2002,3003 shipped
```

ผลจริงบน audit row: `"ids: 1001,1002,1003,1004"` → `"ids: [redacted:credit_card]"`

**นี่คือ over-redaction ที่ #120 สร้างใหม่** และ over-redaction control ที่มีอยู่
(`release 1.16.1–stable, built 2026`) **ไม่ครอบ** เพราะใช้ prose + en dash ไม่ใช่
ตัวเลขคั่นด้วย comma · comment ในเทสเขียนว่า *"false-positive profile is unchanged
by #120 in kind"* — **ข้อนี้ไม่จริง** สำหรับ comma: เดิมมันจะไม่มีวัน redact CSV,
ตอนนี้ redact

เหตุผลที่ JSDoc ให้ (*"a class where the fullwidth comma matches and the ASCII one does
not is the same half-widened asymmetry"*) **ฟังขึ้นในเชิงรูปทรง แต่ไม่สมมาตรในเชิงความถี่**:
`，` ระหว่างกลุ่มเลข 4 หลักหายาก · `,` ระหว่างกลุ่มเลข 4 หลักคือ CSV / id list /
chunk size ซึ่งเป็นสิ่งที่ audit log มีเต็มไปหมด · การเลือกที่ถูกไม่ได้ตัดสินด้วย
"สมมาตรของ Unicode" แต่ด้วย "อะไรอยู่ใน log จริง"

**สองทางที่รับได้ ให้ Dev5/PMO เลือก:**
1. **ตัด `,` และ `，` ออกทั้งคู่** — คงสมมาตร และไม่สร้าง FP ใหม่ · เสียเคส
   บัตรที่คั่นด้วย comma ซึ่งไม่ใช่รูปแบบที่ใครพิมพ์บัตรจริง
2. **เก็บ comma ไว้ แต่เพิ่ม negative control ที่ pin ความเสียหาย** — เทสที่ยืนยันว่า
   `"ids: 1001,1002,1003,1004"` redact และ**ยอมรับ**ไว้เป็นลายลักษณ์อักษร พร้อมแก้ comment
   `"unchanged in kind"` ให้ตรงกับที่วัดได้

**ผมเอน (1)** — redaction ที่กินของไม่ควรกินทำให้ audit log เสียหายโดยไม่ได้ป้องกันใคร
ซึ่งเป็นเหตุผลเดียวกับที่ Dev5 ใช้ตัด newline ออกเอง · แต่ทั้งสองทางป้องกันได้
**สิ่งที่รับไม่ได้คือสถานะปัจจุบัน: FP ใหม่ที่ไม่มีเทสพูดถึง และ comment ที่บอกว่าไม่มี**

## 5. ข้อสังเกตอื่น ไม่ block

- `1 234 567 890 123` (thin-space thousands) **clean** — เพราะกลุ่มไม่ใช่ 4 หลัก · ดี
- `ports 8080 8081 9000 9001` **REDACT** แต่ **เดิมก็ REDACT** (space อยู่ใน class เดิม) —
  ไม่ใช่ regression ของ #120
- `SEP` ใช้ `?` ตัวเดียวกันทั้ง 3 ตำแหน่ง แปลว่าคั่นแบบผสมผ่าน ซึ่งเทส MIXED ยืนยันแล้ว
- ไม่มี Luhn ตั้งแต่ #118 มี ledger รองรับ · #120 ไม่ได้ทำให้แย่ลงในแง่นี้ (ยกเว้น comma ข้างบน)

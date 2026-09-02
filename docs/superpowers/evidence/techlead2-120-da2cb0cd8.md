# Techlead-2 — #120 `da2cb0cd8`: **PASS** (finding comma ปิดแล้ว)

worktree `/tmp/tl2-120b` donor `/tmp/qa2-84b` DB `t98b`
diff จาก `caccf5514`: `redaction.js` +9/-7, test +23/-13, ledger +86
**baseline 202/202** (จาก 203 — ลดลง 1 เพราะเทส `ASCII comma matches` ถูกแทนด้วยเทสเดียวที่ยิง 4 อินพุต)

---

## finding ปิดแล้ว — วัดเอง ไม่ได้เชื่อคำอธิบาย

```
== comma FP หายไปแล้ว ==
clean   "ids: 1001,1002,1003,1004"
clean   "1000,2000,3000,4000"
clean   "chunk 4096,8192,1024,2048"
clean   "価格 1200，3400，5600，7800"
```

ทั้งสี่คือชุดที่ผมวัดว่า **NEW-REDACT** บน `caccf5514` · ตอนนี้ clean หมด

## สิ่งที่ #120 ต้องทำ ยังทำได้ครบ

```
REDACT  "1234 5678 9012 3456"          REDACT  "1234-5678-9012-3456"
REDACT  "1234　5678　9012　3456"        REDACT  "１２３４－５６７８－９０１２－３４５６"
REDACT  "1234 5678－9012　3456"  (mixed) REDACT  "4111111111111111"
```

## FP delta เทียบ pattern เดิม — **ศูนย์ FP ใหม่**

รัน pattern เดิม (`c44b059d3`) กับใหม่บนอินพุตเดียวกัน 9 ชุด:

```
old-c new-c   "release 1.16.1–stable, built 2026"
old-c new-c   "2026－09－02"
OLD-R NEW-R   "ports 8080 8081 9000 9001"     <- เดิมก็ REDACT ไม่ใช่ regression
old-c new-c   "1 234 567 890 123"
old-c new-c   "1234\n5678\n9012\n3456"
old-c new-c   "1234\t5678\t9012\t3456"
old-c new-c   "a：1234：5678：9012：3456"
old-c new-c   "1234.5678.9012.3456"
old-c new-c   "1234/5678/9012/3456"
```

**ไม่มีบรรทัดไหนเป็น `old-c NEW-R`** — #120 ไม่สร้าง false positive ใหม่แม้แต่ตัวเดียว
นี่คือสิ่งที่ `caccf5514` ทำไม่ได้

## mutation — เติม comma กลับ

| # | mutation | ผล |
|---|---|---|
| **C1** | เติม `,` กลับเข้า class | **2 failed** — `BOTH commas are OUT`, `U+002C comma does not join four digit groups` |
| **C2** | เติม `，` กลับ | **2 failed** — `BOTH commas are OUT`, `U+FF0C fullwidth comma does not join…` |

**แดงคนละคู่** — เทส `BOTH commas are OUT` จับทั้งสองความกว้าง (ยิง 4 อินพุตรวม
`価格 1200，…`) และ negative table จับรายตัว · การกลับ ruling ถูก pin ไว้ทั้งสองชั้น

## สามบรรทัดที่ขอให้อ่านซ้ำ — ตรวจครบ

1. **comma ออกจาก class** — `,` และ `，` หายจาก `SEPARATORS` ทั้งคู่ ยืนยันด้วย diff
2. **เทสกลับด้าน** — ย้ายจาก `must redact` ไป `must NOT redact` table **และ** เพิ่มเทส
   เฉพาะที่ยิง 4 อินพุตจริงพร้อมเหตุผล · ไม่ใช่แค่ลบเทสเก่าทิ้ง
3. **comment `"unchanged in kind"` แก้แล้ว** — เขียนใหม่ว่า *"EVERY separator admitted
   here widens what it can falsely catch. That is why both commas were reversed out
   after measurement rather than kept on the symmetry argument"* · **ตรงกับที่วัดได้
   และบันทึกเหตุผลของการกลับ ruling ไว้ในที่ที่คนอ่านโค้ดจะเจอ**

## JSDoc บันทึกการกลับ ruling ไว้ในกลุ่ม OUT

comma มีย่อหน้าของตัวเองในกลุ่ม OUT พร้อมข้อความ *"proposed as IN and REVERSED after
measurement"* และลิสต์อินพุตจริงที่ทำให้กลับ · สมมาตรยังรักษาไว้ (ออกทั้งสองความกว้าง)
ซึ่งตอบข้อกังวลเดิมโดยไม่ต้องแลกกับ FP

## Verdict

**PASS** — ไม่มี blocker · finding เดียวที่ผมยกไว้ปิดแล้วและปิดถูกวิธี (ตัดทั้งคู่
ไม่ใช่เก็บไว้แล้วเขียน control) · FP delta = ศูนย์ · mutation จับทั้งสองความกว้างแยกกัน

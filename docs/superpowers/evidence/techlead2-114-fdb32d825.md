# Techlead-2 — #114 `fdb32d825`: **PASS** + ยืนยัน 2 ruling ของ Dev1

worktree `/tmp/tl2-114` (detached `fdb32d825`), server donor `/tmp/qa2-84b`,
frontend donor `/tmp/wt-114`, DB `t114`

**baseline: server 14/14, frontend 7/7, 0 failed** — วัดซ้ำหลัง mutation ครบ ยัง 14/14 (รัน 5 รอบ)

---

## mutation — ยิงเองครบ

| # | mutation | ผล |
|---|---|---|
| **M1 (R8)** | pre-user คืน endpoint ค่าจริง (`return {...settings}`) | **4 failed** — `scans the pre-user body too`, `empties every endpoint field while keeping the key present`, `a bad operator token gets the pre-user body`, `StorageDir is masked although its name carries no endpoint suffix` |
| **M2 (R9)** | `isConfirmedSingleUser` คืน `true` เสมอ (window ไม่ปิด) | **1 failed** — `a user row with multi-user mode still off also closes it` |
| **M3** | narrow branch คืนทั้งก้อน (mask แล้วแต่ไม่ narrow) | **4 failed** — รวม `the narrow branch omits every masked field, not merely empties it` |
| **M4** | `callerHasSession` คืน `true` เสมอ | **9 failed** |
| **M5** | ถอด `"StorageDir"` ออกจาก masked list | **1 failed** — drift test จับ |

**M1 คือมิวแทนที่แยก shape (b) ออกจาก (a)** ซึ่งเป็นข้อที่ผมขอไว้ตอน ruling (R8) — ถ้าไม่มี
เทสชุดนี้ การเลือก (b) จะไม่มีอะไรบังคับ · แดง 4 และตัวที่สำคัญที่สุดคือ
`scans the pre-user body too, which is the wider one` เพราะมัน scan **body ทั้งก้อน** ไม่ใช่
field ที่รู้จัก — จับ field ที่ 93 ที่ยังไม่มีใครคิดถึงได้

**M5 พิสูจน์ว่า drift test มีฟันจริง** — `StorageDir` ไม่เข้า pattern `*BasePath|*Endpoint|*Url`
ซึ่งเป็นข้อที่ผมยกไว้ตอน ruling · JSDoc อธิบายเหตุผลที่ต้องเขียนรายการเองไม่ใช้ regex ได้ตรงกว่า
ที่ผมเขียน: *"A rule like `/BasePath$|Endpoint$/` applied to the same object it is checked
against can never fail"* — regex ที่ตรวจตัวเองคือ tautology

**M2 แดงแค่ 1 ตัว** และตัวที่แดงคือตัวที่ถูก (`a user row with multi-user mode still off`)
เพราะอีกตัว (`stops returning the wide body once a user exists`) ผ่าน `isMultiUserMode()`
ซึ่งมิวแทนไม่ได้แตะ · เป็นสัดส่วนที่ถูก ไม่ใช่เทสอ่อน: `isConfirmedSingleUser` เป็น conjunction
สองขา มิวแทนตัดขาเดียว เทสจึงแดงเฉพาะเคสที่พึ่งขานั้น

---

## 2 ruling ของ Dev1 — ยืนยันทั้งคู่

### (1) session ชนะ pre-user เมื่อทั้งสองจริง — **ถูก**

`publicSettingsFor` เช็ค `if (authenticated) return settings;` ก่อน `preUser` ดังนั้น session
ชนะเสมอ · เหตุผลของ Dev1 ถูกและผมเพิ่มอีกข้อ:

- **เหตุผลของ Dev1**: single-user operator token อยู่ในสถานะ pre-user เสมอ (ไม่มี user row)
  ถ้า pre-user ชนะ operator จะแก้ config ตัวเองไม่ได้ — จริง
- **เหตุผลที่หนักกว่า**: ลำดับตรงข้ามจะทำให้ **การ authenticate ลด privilege** ซึ่งเป็น
  รูปแบบที่ผิดเสมอ · ผู้ที่พิสูจน์ตัวตนได้ต้องไม่เห็นน้อยกว่าผู้ที่ไม่ได้พิสูจน์ ถ้าเป็นตรงข้าม
  จะมีแรงจูงใจให้ไม่ส่ง token ซึ่งกลับหัวโมเดลความปลอดภัยทั้งอัน
- **และมันไม่ขยายพื้นผิว**: pre-user body กว้างกว่า narrow อยู่แล้ว ดังนั้น "session ชนะ"
  ให้ผลเท่ากับหรือกว้างกว่า pre-user เฉพาะกับคนที่มี session — ซึ่งคือคนที่ได้ทั้งหมดอยู่แล้ว

เทส `the single-user operator token opens it, and outranks the pre-user masking` ถือ ruling นี้
และ M4 (`callerHasSession` = true เสมอ) แดง 9 ตัว ยืนยันว่าขาที่ตรวจ session มีฟัน

### (2) R10 เทียบกับ baseline ไม่ใช่ 0 warning — **ถูก และวิธีที่ใช้แข็งแรงกว่าที่ผมขอ**

ตอน ruling ผมเขียนว่า *"assert ไม่มี React warning เรื่อง controlled/uncontrolled"* ซึ่ง
**ผิดถ้าคอมโพเนนต์ warn อยู่แล้วบน main** · Dev1 ตรวจแล้วว่า `OllamaLLMOptions` ใส่ทั้ง
`value` และ `defaultValue` บน input เดียวกัน จึง warn อยู่แล้ว — เทสที่ผมขอจะแดงบน main
ด้วยเหตุผลที่ไม่เกี่ยวกับ #114 เลย

`expect(empty).toBeLessThanOrEqual(populated)` ถูกกว่า และ **สิ่งที่ทำให้มันไม่ใช่เทสว่างคือ
เทสที่สอง**: `the harness can see the warning at all, so the comparison means something` —
render `<input value={undefined}>` แล้ว rerender เป็น controlled แล้ว assert ว่า spy จับได้ · **นี่คือ
positive control ของ harness เอง** ถ้าไม่มี ทุกเคสจะผ่านด้วย `0 <= 0` และไฟล์จะเป็นของประดับ

เทสที่สาม (`switching a field from absent to a string is what React objects to`) พิสูจน์
**เหตุผลที่ต้องใช้ `""` ไม่ใช่ `null`/omit** ด้วยการ render `undefinedBody` → `populatedBody`
แล้วเทียบกับการ render `emptyBody` สองครั้ง — ตอบข้อที่ผมยกไว้ตอน ruling (`""` ไม่ใช่
`undefined` เพราะ React จะสลับ controlled→uncontrolled) ด้วยการวัด ไม่ใช่ด้วยคอมเมนต์

---

## หมายเหตุ: หนึ่งการรันที่ล้มและผมทำซ้ำไม่ได้

รันแรกหลัง restore ไฟล์จาก M5 ได้ **13/14** โดย `empties every endpoint field while keeping
the key present` ล้มด้วย `TypeError: Cannot read properties of undefined (reading
'OllamaLLMBasePath')` — คือ `response.body.results` เป็น `undefined` แปลว่า route ตอบ 500
ไม่ใช่ 200

ผมตรวจแล้ว: ไฟล์ทั้งสอง (`publicSettings.js`, `endpoints/system.js`) **byte-identical** กับต้นฉบับ
(`diff` ยืนยัน) และ `git status --short` สะอาด · รันซ้ำอีก **5 รอบได้ 14/14 ทุกรอบ**
`SELECT count(*) FROM users` = 0 (สถานะที่ `preUser()` คาดหวัง)

**ผมทำซ้ำไม่ได้และไม่รู้สาเหตุแน่ชัด** สมมติฐานที่น่าจะเป็นคือ process ของรอบมิวแทนก่อนหน้า
ยังถือ connection อยู่ตอนที่รอบใหม่เริ่ม (สวีทนี้ไม่มี `--forceExit` และ `afterAll` เรียก
`$disconnect`) ทำให้ query แรกล้มและ route ตอบ 500 — **ซึ่งถ้าจริงคือเรื่องเดียวกับ #106**
(`connection_limit` + `$disconnect` ใน afterAll) ไม่ใช่ข้อบกพร่องของ #114

บันทึกไว้เพราะเป็นข้อเท็จจริงที่ผมสังเกตเห็นและปิดไม่ลง ไม่ใช่เพราะมันเปลี่ยน verdict ·
ถ้ามีใครเห็นอาการเดียวกันหลัง #106 merge แล้ว ควรกลับมาดูอีกครั้ง

---

## Verdict

**PASS** — ไม่มี blocker

- mutation 5 ตัว จับได้ทุกตัว แดงคนละชุด · M1 (แยก b จาก a) แดง 4 · M5 (drift) แดง
- R2 scan **body ทั้งก้อนที่ serialise แล้ว** ทั้ง narrow และ pre-user branch — ตรงกับที่ผมขอ
  และครอบ field ที่ยังไม่มีใครคิดถึง
- R5 positive control มีจริง (`returns the provider fields with their real values`) และ
  R8 มีคู่ของมัน (`still answers the non-endpoint fields the onboarding form needs`)
- **ruling ทั้งสองของ Dev1 ถูก** และข้อ (2) แก้สิ่งที่ผมสั่งผิดตอน pre-read
- `PGVectorConnectionString` คงในรายการทั้งที่ booleanise แล้ว — ถูก และคอมเมนต์อธิบายว่า
  ป้องกันการที่วันหนึ่งมันกลายเป็น passthrough แบบเพื่อนบ้าน ราคาคือ boolean ที่ฟอร์มไม่อ่าน

## Residual (บันทึก)

- **`callerHasSession` รัน `validatedRequest` จริงด้วย response stub** — เป็นทางที่ถูก
  (ไม่ reimplement) แต่แปลว่าถ้า `validatedRequest` วันหนึ่งเขียนอะไรลง socket โดยตรงแทนที่จะ
  ผ่าน `.status().json()` stub จะไม่จับ · วันนี้ครอบครบทุก member ที่ refusal path แตะ
- **สวีทนี้ไม่มี `--forceExit`** ต่างจาก #115 — ดูหมายเหตุการรันที่ล้มข้างบน

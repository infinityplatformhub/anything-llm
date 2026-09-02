# ledger #104 — persistCredential return dropped

Ruling: brief ระบุ defect ที่ไปถึงไม่ได้ — `/system/enable-multi-user` เรียก `updateENV({JWTSecret}, true)` และ `JWTSecret` มี `checks: [requiresForceMode]` ตัวเดียว hooks ว่างหมด `force=true` ผ่านเสมอ ยิงค่าประหลาดครบชุด (`null`/`{}`/string 100k) = `error=false` ทุกเคส RED ตาม contract เดิมจะต้อง mock `updateENV` = self-satisfying → ยกขึ้น PMO ก่อนเขียน ถ้าผิด: จะ merge เทสที่ยืนยัน `if` ที่ตัวเองเพิ่งเขียน
Ruling (PMO+TL-1): แก้ที่ `updateENV.js:1687` ไม่ใช่แค่ route — ครอบ `secret:true` ทั้ง 92 key และเป็นจุดเดียวที่ RED พิสูจน์ได้ด้วยของจริง (stub store ให้ล้ม) ถ้าผิด: 91 key ที่เหลือยังกลืน error ต่อไป
Ruling (PMO+TL-1): สะสมเข้า `error` แล้วไปต่อ ไม่ `break` — persist ล้มเกิด**หลัง**เขียนค่าแล้ว ต่างจาก checks/preUpdate ที่ล้มก่อน key ที่เหลือยังไม่ถูกปฏิเสธ การหยุดจะทำให้มันไม่ถูก apply อย่างเงียบ ๆ ถ้าผิด: บอดี้หลายคีย์จะเสียคีย์ที่ยังไม่ถึงคิวโดยไม่มีใครรู้
Ruling (PMO): ถอด key ที่ persist ล้มออกจาก `newValues` — `newValues` คือสิ่งที่ UI แสดงว่า "เปลี่ยนแล้ว" ถ้าคงไว้ operator ต้องอ่าน `error` เพื่อรู้ว่าคีย์ไหนโกหก ถ้าผิด: UI รายงานว่าเปลี่ยนสำเร็จทั้งที่ credential หาย
Ruling: ปล่อย `process.env[envKey]` ไว้ตามเดิมแม้ persist ล้ม — process นี้ใช้ค่านั้นอยู่ก่อนจะเรียก store แล้ว การ unset จะทำให้ instance ที่รันอยู่พังเพิ่มจากการเสีย credential ตอน restart ถ้าผิด: provider ที่ยังทำงานได้จะหยุดทันทีโดยไม่จำเป็น
Ruling (PMO): `update-password` ไม่ rollback ใน issue นี้ — `success:false` + ชื่อ key เท่านั้น rollback ของสอง secret ที่หมุนพร้อมกันต้องอ่านค่าเดิมกลับมาแล้วเขียนใหม่ภายใต้เงื่อนไขที่เพิ่งล้ม = transaction ไม่ใช่การเช็ค return แยกเป็น **#116** พร้อม `ponytail:` marker ในเทส ถ้าผิด: operator เห็น success:false แล้วลองใหม่ ซึ่งยอมรับได้ (พฤติกรรมเดิมคือ 200 ซึ่งไม่ยอมรับ)
Ruling: แก้คอมเมนต์ `persistCredential` ที่ #80 เขียนว่า "existing callers ignore it and keep their behaviour exactly — which is deliberate" — ตอนนี้ไม่ใช่แล้ว คอมเมนต์ที่โกหกแย่กว่าไม่มีคอมเมนต์ ถ้าผิด: คนอ่านครั้งหน้าจะเชื่อว่าการกลืนยังเป็นเจตนา

## หลักฐานว่า defect มีจริง (รันเอง ไม่ได้อ่านโค้ด)

stub `CredentialStore.set` ให้คืน `{error}`:
```
updateENV says   : {"newValues":{"JWTSecret":"**********"},"error":false}
live env         : new-rotated-secret-value-here
persisted        : null
```

โซ่ผลลัพธ์ end-to-end (temp .env จริง + `dumpENV` จริง + `ensure-secrets.main()` จริง):
```
A updateENV error   : false          ← route เห็นว่าสำเร็จ
B JWT_SECRET in .env: false          ← dumpENV ข้าม secret:true (ตั้งใจ, P0-4D)
C next boot minted  : 3f67f8d2...    ← ensure-secrets สร้างตัวใหม่
D equals rotated    : false          ← ทุก session หลัง rotate ตายตอน restart
```

## Mutations

| mutation | ผล |
|---|---|
| ถอดการเช็ค return ใน updateENV (M1/RF-1) | 5 failed / 9 |
| ถอด `throw` ที่ enable-multi-user (M2/RF-2) | 1 failed — `refuses the multi-user flip…` |
| `break` แทน accumulate (M3/RF-3) | 1 failed — `RF-3: a later key is still applied…` |
| คง key ที่ล้มไว้ใน `newValues` (M4) | 1 failed — `RF-3` |

M2/M3/M4 แดงคนละข้อกัน = เทสวัดคนละอย่าง ไม่ใช่ด่านหยาบตัวเดียว

## Caller ที่เปลี่ยนพฤติกรรมโดยตั้งใจ

| caller | คีย์ secret:true ที่ไปถึงได้ | เปลี่ยนเป็น |
|---|---|---|
| `POST /system/update-env` | ทั้ง 92 (body อิสระ) | 500 เมื่อ persist ล้ม |
| `POST /v1/system/update-env` | ทั้ง 92 (body อิสระ) | 500 เมื่อ persist ล้ม |
| `POST /system/update-password` | AuthToken, JWTSecret | `success:false` + ชื่อ key (ไม่ rollback → #116) |
| `POST /system/enable-multi-user` | JWTSecret | 500 + rollback เดิมทำงาน (user rows หาย, multi_user_mode=false) |

## กับดักที่เจอเอง

RF-1 (`update-password`) กับ RF-2 (`enable-multi-user`) เขียน `JWT_SECRET` ทั้งคู่ —
RF-2 ลบแถวก่อนแล้ว assert ว่า `get` คืน null ก่อนเริ่ม ไม่งั้นอาจอ่านแถวของ RF-1 แล้วผ่านด้วยหลักฐานผิด

route ทั้งสามอยู่คนละโหมด: `update-env` ต้อง multi-user + admin JWT ส่วน `update-password`
กับ `enable-multi-user` เป็น single-user route และปฏิเสธถ้าไม่ใช่ แต่ละเทสจึงประกาศโหมดที่ตัวเองต้องการ
ไม่ใช่ `beforeEach` ก้อนเดียว — fixture ที่ทำงานได้ในลำดับเดียวหน้าตาเหมือนโค้ดพัง

## หมายเหตุ

`--findRelatedTests` แบบขนานล้ม 21 suite ด้วย `PrismaClientInitializationError`
(max_connections 100, มี 55 ใช้อยู่แล้วจาก worktree อื่น) — ไม่ใช่ผลของ diff นี้
รันแต่ละ suite ที่เกี่ยวข้องแยกทีละตัว: credentialClear 27/27, settingsWriteFailure 11/11,
secretLeakScan 7/7, updateEnvUnknownKeys 13/13, mailerSettingsRoutes 12/12 เขียวหมด

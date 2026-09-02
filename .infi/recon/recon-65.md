# Recon #65 — `SystemSettings.updateSettings` ignored returns + silent key drop

## โค้ดปัจจุบันทำอะไร

`models/systemSettings.js:690` `updateSettings(updates)` — public wrapper:
1. คัด key ที่อยู่ใน `supportedFields` เก็บไว้ **ลบ key ที่เหลือทิ้งเงียบ ๆ**
2. ส่งต่อ `_updateSettings(updates)` ซึ่ง `:749` catch เองแล้ว `return {success:false, error}` — ไม่ throw

ผลคือค่าที่คืนมาเป็นทางเดียวที่รู้ว่าเขียนสำเร็จหรือไม่ และ `try/catch` รอบ ๆ ไม่เคยจับอะไร

## defect 1 — caller ไม่อ่านค่าที่คืน (5 จุด ไม่ใช่ 4)

call site ทั้งหมด 7 จุด อ่านค่าคืน 2 จุด:

| ไฟล์:บรรทัด | อ่านค่าคืน? | ผลเมื่อเขียนพัง |
|---|---|---|
| `endpoints/admin.js:606` | **ไม่** | 200 `{success:true}` ทั้งที่ไม่ได้เขียน |
| `endpoints/api/admin/index.js:782` | **ไม่** | 200 `{success:true}` — `/v1` surface |
| `utils/agents/aibitat/plugins/gmail/lib.js:250` | **ไม่** | `updateConfig` คืน `{success:true}` เสมอ |
| `utils/agents/aibitat/plugins/google-calendar/lib.js:46` | **ไม่** | เหมือนกัน |
| `utils/agents/aibitat/plugins/outlook/lib.js:566` | **ไม่** | เหมือนกัน |
| `endpoints/communityHub.js:37` | ใช่ (`result.error`) | throw → 500 |
| `endpoints/system.js:1011` | ใช่ (`!success`) | throw → 500 |

Techlead FINDING-1 นับ 4 — **ขาดไป 1** (สามตัวเป็น agent plugin ไม่ใช่ endpoint จึงถูกมองข้ามได้ง่าย)
รูปแบบเดียวกับ #59 เป๊ะ (`_updateSettings` ผ่าน private path) แต่ #59 กวาดเฉพาะ `_updateSettings`

## defect 2 — key ที่ไม่รองรับถูกลบเงียบ แล้วยังตอบ success

`updateSettings` ลบ key นอก `supportedFields` โดยไม่บอกใคร ถ้าลบหมดทุก key
`_updateSettings({})` เข้า loop ศูนย์รอบ → `Promise.all([])` → `{success:true}`
`admin.js` / `api/admin/index.js` ส่ง `reqBody(request)` ดิบเข้ามา แปลว่า
**client พิมพ์ชื่อ setting ผิด → ได้ 200 "บันทึกแล้ว" โดยไม่มีอะไรถูกบันทึก**
นี่คือ tri-state ตัวเดิม: "สำเร็จ" กับ "ไม่มีอะไรให้ทำเพราะทิ้งหมด" คืนค่าเดียวกัน

## defect 3 (เล็ก) — `system.js:1013` อ่าน `error.message`

`_updateSettings` คืน `error` เป็น **string** (`error.message` ของมันเอง) ไม่ใช่ Error
`error.message` จึงเป็น `undefined` เสมอ ตกไป fallback string — ข้อความจริงหายทุกครั้ง

## จุดที่จะเปลี่ยน

- caller 5 จุด: อ่าน `{success, error}` แล้ว fail ให้ดัง (endpoint → 500 พร้อม error, plugin → คืน `{success:false, error}` จริง)
- `updateSettings`: คืน key ที่ถูกทิ้งด้วย (เช่น `{success, error, ignoredFields}`) และปฏิเสธเมื่อทิ้งหมดทั้งที่ผู้เรียกส่ง key มา
- `system.js:1013`: ใช้ `error` ตรง ๆ

## evidence contract (ร่าง)

RED ต้องแดงก่อน: mock `_updateSettings` → `{success:false}` แล้วยิง HTTP จริง
ทั้ง `/admin/system-preferences` และ `/v1/admin/system-preferences` ต้องได้ 500 ไม่ใช่ 200
บวก positive control (write สำเร็จ → 200) กัน route ที่ปฏิเสธทุกคนผ่านเทส
และเคส "ส่ง key ที่ไม่รองรับล้วน" ต้องไม่ได้ 200 success

## ruling ของ PMO (2026-09-02)

1. **defect 2 แยกใบ** — เปลี่ยน contract ของ `/v1` (200 → 400 สำหรับ key ไม่รู้จัก) ต้องมี
   residual + breaking-change note ต่างหาก เปิด issue ใหม่หลัง start #65 โดยอ้าง recon ฉบับนี้
2. **agent plugin 3 ตัวรวมใน #65** (บั๊กเดียวกัน 5 site) และ **defect 3 แก้ใน #65 ด้วย**

ขอบเขต #65 จึงเป็นข้อเดียว: **"อ่านค่าที่ `updateSettings` คืนให้ถูก"** ที่ทั้ง 5 site
บวก sweep test แบบ source-scan (anti-vacuous แบบ #48) ที่จะแดงเองเมื่อมี call site ใหม่
เกิดขึ้นแล้วไม่อ่านค่าคืน — ไม่ใช่แค่ยืนยัน 5 จุดที่รู้อยู่แล้ววันนี้

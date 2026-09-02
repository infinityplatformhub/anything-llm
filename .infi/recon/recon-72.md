# Recon #72 — `updateSettings` discards unknown keys and answers success

ทุกข้อในเอกสารนี้ **รันจริงบน `approof_p72`** ไม่ใช่อ่านโค้ดแล้วสรุป

## baseline ที่พิสูจน์เองแล้ว

```
updateSettings({not_a_real_key:"x"})            -> {success:true, error:null}  เขียน 0 แถว
updateSettings({not_a_real_key:"x", support_email:"mixed@probe.test"})
   -> {success:true, error:null}  และ support_email ถูกเขียนจริง (partial apply)
   input object BEFORE {"not_a_real_key":"x","support_email":"..."}
   input object AFTER  {"support_email":"..."}          <-- ผู้เรียกโดน mutate
```

สองอาการ: (ก) unknown key หายเงียบแล้วตอบ success (ข) `delete updates[key]` แก้อ็อบเจกต์ของผู้เรียก

## surface ที่กระทบ (5) — ตรวจ path จริงแล้ว

| route | ไฟล์ | วันนี้ตอบอะไรเมื่อ model ล้มเหลว |
|---|---|---|
| `POST /admin/system-preferences` | `endpoints/admin.js:606` | หลัง #70: 500 จาก `{success,error}` |
| `POST /v1/admin/preferences` | `endpoints/api/admin/index.js:736` | หลัง #70: 500 (อยู่ใน swagger จริง — `grep` เจอ 1 จุด) |
| `POST /community-hub/settings` | `endpoints/communityHub.js:37` | `if (result.error) throw` → **500** |
| `POST /system/default-system-prompt` | `endpoints/system.js:1011` | `if (!success) throw` → **500** |
| agent plugin `updateConfig` ×3 | `gmail:250` `gcal:46` `outlook:566` | ส่ง key ที่รองรับเสมอ — **ไม่โดน 400** |

400 ออกจาก model เองไม่ได้ — สาม route แปลงความล้มเหลวเป็น 500 หมด **#72 ต้องแตะ route** ไม่ใช่แค่ model
plugin สามตัวไม่ต้องแก้ใน #72 (คีย์ที่ส่งอยู่ใน `supportedFields` ทั้งสาม) งานของมันคือ #70 ซึ่งจบแล้ว

## ผู้ใช้จริงของ endpoint — ตรวจแล้วว่าไม่มีใครพัง

frontend เรียกผ่าน `Admin.updateSystemPreferences` (`frontend/src/models/admin.js:179`) จาก 10 จุด
รวบคีย์ที่ frontend ส่งจริงทั้งหมดแล้วเทียบกับ `supportedFields`:

```
unsupported keys the FRONTEND already sends: (none)
```

**ไม่มี call site ใน frontend ที่จะเริ่มได้ 400** — breaking change กระทบเฉพาะ integration ภายนอกบน `/v1`

## หลุมที่ต้องระวัง: มี key list สองชุด ไม่ตรงกัน

`publicFields` (26) ใช้ตอนอ่าน · `supportedFields` (28) ใช้ตอนเขียน

```
READABLE แต่เขียนไม่ได้ : max_embed_chunk_size, imported_agent_skills, feature_flags
WRITABLE แต่อ่านไม่ได้  : logo_filename, telemetry_id, default_system_prompt,
                          experimental_live_file_sync, hub_api_key
```

สามตัวแรกอันตราย: `endpoints/admin.js:448-454` มี route `/admin/system-preferences-for` ที่ **อ่าน** สามคีย์นี้อยู่จริง ถ้าใครส่งกลับมาเขียนผ่าน `/admin/system-preferences` วันนี้มันหายเงียบ พรุ่งนี้จะได้ 400 — นั่นคือพฤติกรรมที่ถูก แต่ต้องเขียนลง breaking note ให้ชัดว่า "อ่านได้ ≠ เขียนได้" เพราะ round-trip แบบ read-modify-write คือรูปแบบที่คนเขียน client จะทำโดยสัญชาตญาณ

## จุดที่จะเปลี่ยน

1. `updateSettings` (`systemSettings.js:690-701`) — เก็บชื่อ unknown key **ก่อน** filter, **ห้าม mutate input** (copy ไม่ใช่ delete), คืน unknown keys ออกมา
2. all-or-nothing: มี unknown key แม้ตัวเดียว = ไม่เขียนอะไรเลย
3. route: ทั้ง 5 surface แปลง "unknown key" เป็น **400 พร้อมรายชื่อ key** แยกจาก "write ล้มเหลว" ที่ยังเป็น 500 — คนละสาเหตุ คนละรหัส
4. swagger note บน `/v1/admin/preferences`

## evidence contract (ร่าง)

RED ต้องแดงจริงก่อน:
- `POST /admin/system-preferences` และ `POST /v1/admin/preferences` ด้วย body ที่มี unknown key ล้วน → ต้องได้ 400 + รายชื่อ key (วันนี้ได้ 200 `{success:true}`)
- **mixed body** (unknown + valid) → 400 และ **valid key ต้องไม่ถูกเขียน** — ข้อนี้คือหัวใจของ all-or-nothing และวันนี้มันเขียน (พิสูจน์แล้วข้างบน)
- **positive control**: body ที่ key ถูกต้องล้วน → ยังได้ 200 และเขียนจริง มิฉะนั้น route ที่ปฏิเสธทุกคนจะผ่านเทส
- **no-mutation**: ส่งอ็อบเจกต์เข้าไปแล้วอ็อบเจกต์เดิมของผู้เรียกต้องไม่เปลี่ยน (วันนี้เปลี่ยน)

## ruling ของ PMO (2026-09-02, หลัง QA-3 probe)

Ruling: **`updateSettings` คืน `{success:false, error, code:"unknown_keys", unknownKeys:[…]}`** — typed ด้วย `code` ไม่ใช่ให้ route ไป parse ข้อความ error ถ้าผิดจะเสียตรงที่ route ต้องเดาสาเหตุจาก string ซึ่งแตกทันทีที่ข้อความเปลี่ยน

Ruling: **ทุก surface แยกด้วย `code` ไม่ใช่ `result.error`** — `code === "unknown_keys"` → **400** พร้อม `unknownKeys` ในบอดี้; อย่างอื่น (write ล้มเหลวจริง) → **500** เหมือนเดิม `communityHub.js:37` และ `default-system-prompt` ปัจจุบันเช็ค `result.error` / `!success` ทางเดียวแล้วโยน 500 ทั้งคู่ — ต้องแยกด้วย `code` ทั้งสองจุด

Ruling: **mixed body (unknown + valid) = 400 และไม่เขียนอะไรเลย** — นี่คือ RED หลัก เพราะวันนี้มันเขียน valid key ลงจริง (พิสูจน์แล้วข้างบน) เคส unknown ล้วนเป็นเคสง่ายที่เทสอ่อน ๆ ก็ผ่าน

Ruling: **breaking note ต้องมี "อ่านได้ ≠ เขียนได้"** พร้อมชื่อสามคีย์ `max_embed_chunk_size`, `imported_agent_skills`, `feature_flags`

Ruling: **ห้าม mutate input** เก็บชื่อ unknown key ก่อน filter แล้ว copy ไม่ใช่ `delete`

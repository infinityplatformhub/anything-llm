# QA-2 — #84 `8bcc62ce` — PASS

Probe 14/14 · mutation 4/4 · ไม่รัน full suite (§7.14) · เขียนโดย PMO จากข้อความ QA-2

## การเปลี่ยนแปลง
`endpoints/system.js:731` `settings.write` → `system.write` บรรทัดเดียว + เทส 208 บรรทัด · `/v1` + `scopes.js` ไม่แตะ (ถือ system.write อยู่แล้ว)

## RED ก่อน: บน main แดง 4/เขียว 10 (200 แทน 403) · บน SHA เขียว 14
## เคส
- premise guard 4: manager ถือ settings.write ไม่ถือ system.write (engine จริง), admin ถือ, derived sample จริง (MAPPED > 100)
- manager refused 4: secret 403 ค่าไม่เปลี่ยน · non-secret 403 · สุ่ม 3 จาก mapping · junk 403
- admin control 3: non-secret เปลี่ยนจริง · secret persist ใน CredentialStore · `****` ข้าม
- `/v1` 3: scope system.write · creator ไม่มี grant → 403 · มี grant org-scoped → 200

## Mutation 4/4: gate ย้อน settings.write (4) · ถอด requirePermission (4) · ถอด placeholder filter (1) · `/v1` scope drift (2)
## ตัวเลข: 214 keys / 92 `secret===true` (module load) — regex ชื่อพลาด `PGVectorConnectionString`
## residual: unknown-key silent drop → #91 · FINDING-1 (TL-1): DELETE /system/credential/:envKey ยัง settings.write → commit ถัดไปใน #84

# QA-2 — #72 `b4e1de7d` — PASS

Probe 32/32 · mutation 13/14 caught (1 equivalent) · ไม่รัน full suite (§7.14) · เขียนโดย PMO จากข้อความ QA-2 (session read-only)

## RED ยืนยันบน baseline ก่อน
probe เขียนบน `b3ccb510` แดง 13 / เขียว 6 ก่อน fix — แดงทุกตัวด้วยเหตุผลที่ตั้งใจ (`result.code === undefined`, HTTP 200 แทน 400)

## ผลตามเกณฑ์
- model contract: unknown key → `{success:false, code:"unknown_keys", unknownKeys, unknownKeyCount}` · mixed body เขียน 0 แถว (snapshot ตารางก่อน/หลัง, ค่าเดิมต่างจากค่าที่จะเขียน) · ไม่ mutate input
- cap: `unknownKeys` ≤ 50, ตัดที่ 64 + `…`, `unknownKeyCount` = จำนวนจริง · คีย์ยาว 64 พอดีต้องไม่ถูกตัด (จับ M6 `>=64`) · ใช้ `[...key].length` เพราะ `…` เป็น U+2026
- hostile shapes: `__proto__`/`constructor`/`prototype` → ไม่ pollute · `<script>` รอดเป็นข้อมูล
- 3 surface ที่ 400 เกิดได้ ยิง HTTP จริง: `/admin/system-preferences`, `/community-hub/settings` (assert `not.toBe(500)`), `/api/v1/admin/preferences` (org-scoped `system.write`) พร้อม positive control
- 2 surface ที่ 400 เกิดไม่ได้: `/system/default-system-prompt`, plugin ×3 → branch presence ตาม ruling
- write ล้มเหลวจริง → 500 ไม่ใช่ 400
- manager pre-filter → 200 ไม่เขียน (ไม่เป็น oracle)
- swagger note บน path `/v1/admin/preferences` ครบ `max_embed_chunk_size`, `imported_agent_skills`, `feature_flags`

## `protected_keys` (นอก spec, Dev1 เพิ่ม)
- `multi_user_mode` / `onboarding_complete` → `protected_keys` เขียน 0 แถว
- `hub_api_key` protected+supported → ยังเขียนได้ (Community Hub connect/disconnect ต้องไม่พัง) — จับ M9
- protected ชนะ unknown, deterministic
- `multi_user_mode` ปิดผ่าน HTTP ไม่ได้ → 400, DB ยัง `true`

## Mutation 14: caught 13, equivalent 1
caught: unknown ทิ้งเงียบ · ไม่มี cap · ไม่ตัดคีย์ยาว · off-by-one · count ถูก cap · ถอด protected guard · protected ไม่เช็ค overlap · route ×3 เมิน `code` → 500 · ส่ง object ต่อไม่ copy · `delete` แบบเก่า
M2 equivalent: filter แทน refuse ใน `safeUpdates` loop — success path คีย์ทุกตัว supported อยู่แล้ว (early return ก่อน copy, ตรวจแล้ว)

บทเรียน M2/M3: mutation หลัง early return ไม่ถูกเทสต์ที่ส่ง unknown key แตะ — เพิ่มเคส success path: (ก) valid body ไม่ mutate input (ข) object เข้า `_updateSettings` เป็น copy คนละตัว, null-prototype, คีย์ครบ → M3/M3b ถูกจับ

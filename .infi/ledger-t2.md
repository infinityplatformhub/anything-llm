# T-2 (#20) ruling ledger

- `Ruling:` READ_ACTIONS เป็น explicit set ใน engine ไม่ derive จาก permissions.category — เพราะ impersonation blanket ต้องตัดสินก่อน lookup และ deterministic; คำใหม่ประเภท read ต้องเติม set นี้ (มี test matrix ครอบทุก action ของ super_admin แต่ไม่ครอบ read-set — T-7 ที่เพิ่มคำควรเติม) — ถ้าผิด: action ใหม่ที่ลืมเติม = impersonated admin เขียนได้
- `Ruling:` orgId ใน Actor เป็น number 1 (fix จาก P0-6 เดิมที่ core-jobs actor ใช้ orgId:"default" string) — service principals ย้ายมาเป็น SERVICE_PRINCIPALS registry ใน actorResolver (grep DoD Actor literal = 0 นอกไฟล์นั้น)
- `Ruling:` suspended user → resolver คืน null (ไม่ใช่ Actor พร้อม flag) — เพราะ "ไม่มี actor = deny" เป็น contract เดียว สอง default = รูรั่ว
- `Ruling:` apiKeyContext ของ PR-3 แปลง Actor ที่ resolver เพียงจุดเดียว — id เป็น `api-key:<keyId>` (namespace กันชนกับ user id), scopes เก็บใน attributes ให้ engine ใช้ทีหลัง (S-9 enforce ที่ repository/engine ตอน scope เกิน grant)
- `Ruling:` engine ไม่อ่าut scopes จาก apiKeyContext ใน T-2 — scope-vs-grant enforcement เกิดเมื่อ route เรียก assertAuthorized ผ่าน requireScope wiring (T-4b) — จดส่งต่อ
- `Ruling:` authorizeMany key = `type:id ?? ws:<workspaceId>` — resource ไม่มี id (เช่น workspace โดย ref) ต้องแยกกันได้ — ถ้าผิด: map ทับกัน decision หาย

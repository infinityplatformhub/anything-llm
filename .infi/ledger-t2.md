# T-2 (#20) ruling ledger

- `Ruling:` READ_ACTIONS เป็น explicit set ใน engine ไม่ derive จาก permissions.category — เพราะ impersonation blanket ต้องตัดสินก่อน lookup และ deterministic; คำใหม่ประเภท read ต้องเติม set นี้ (มี test matrix ครอบทุก action ของ super_admin แต่ไม่ครอบ read-set — T-7 ที่เพิ่มคำควรเติม) — ถ้าผิด: action ใหม่ที่ลืมเติม = impersonated admin เขียนได้
- `Ruling:` orgId ใน Actor เป็น number 1 (fix จาก P0-6 เดิมที่ core-jobs actor ใช้ orgId:"default" string) — service principals ย้ายมาเป็น SERVICE_PRINCIPALS registry ใน actorResolver (grep DoD Actor literal = 0 นอกไฟล์นั้น)
- `Ruling:` suspended user → resolver คืน null (ไม่ใช่ Actor พร้อม flag) — เพราะ "ไม่มี actor = deny" เป็น contract เดียว สอง default = รูรั่ว
- `Ruling:` apiKeyContext ของ PR-3 แปลง Actor ที่ resolver เพียงจุดเดียว — id เป็น `api-key:<keyId>` (namespace กันชนกับ user id), scopes เก็บใน attributes ให้ engine ใช้ทีหลัง (S-9 enforce ที่ repository/engine ตอน scope เกิน grant)
- `Ruling:` engine ไม่อ่าut scopes จาก apiKeyContext ใน T-2 — scope-vs-grant enforcement เกิดเมื่อ route เรียก assertAuthorized ผ่าน requireScope wiring (T-4b) — จดส่งต่อ
- `Ruling:` authorizeMany key = `type:id ?? ws:<workspaceId>` — resource ไม่มี id (เช่น workspace โดย ref) ต้องแยกกันได้ — ถ้าผิด: map ทับกัน decision หาย
- `Ruling:` `document.export` **ไม่อยู่ใน** READ_ACTIONS — export คือ data exfiltration ไม่ใช่ read (seam 02: impersonated ห้าม export/bulk) — impersonated admin export ไม่ได้แม้ถือ super_admin — QA-1/QA-2/security ตรงกัน (F-20b) — ถ้าผิด: view-as-user ที่ต้อง export ต้องออกจาก impersonation ก่อน (ยอมรับ)
- `Ruling:` escalation guard exempt เฉพาะ principal ที่ระบุชื่อ (`single-user`, `core-jobs`) ไม่ใช่ `type==="service"` ทั้งชนิด — scoped API key ก็เป็น service actor การยกเว้นทั้งชนิดคือรู S-9 (ช่อง B) — RED-proven
- `Ruling:` `heldPermissionIds(actor, targetWorkspaceId)` นับเฉพาะ grant ที่ครอบ scope ปลายทาง (org-wide target ต้องถือ org-wide; ws target รับ org-wide หรือ ws เดียวกัน) — กัน workspace-A admin ออก grant org-wide (ช่อง A) — RED-proven
- `Ruling:` `grantRole` ปฏิเสธ `actor: null` — seed/migration ต้องส่ง `SERVICE_PRINCIPALS.singleUser/coreJobs` ชัดเจน ไม่มี default free pass
- `Ruling:` **แก้ ruling เดิม** — `authorizeMany` คืน Map keyed by **index** ไม่ใช่ `type:id ?? ws:<id>` — resource ซ้ำ/ไม่มี id ทำให้ decision หายเงียบ (F-20c)
- `Carry → T-3:` groupIds expansion (`group_members`) ยังไม่มีใน engine — documentFilter เป็นที่ขยาย principal เป็น group/workspace
- `Carry → T-7:` `revokeGrant` ตั้งใจไม่มี escalation guard (ถอนสิทธิ์ไม่ยกระดับ) — T-7 delegated admin ต้องทบทวน · e2e `impersonatedBy` ผ่าน route จริง + `document.bulk_export` ต้องอยู่ใน deny set
- `Marker:` `orgId = 1` hardcoded ใน engine/repository/resolver — เพดานตาม R2 (singleton org) เปิด multi-org ต้องไล่พร้อมกัน

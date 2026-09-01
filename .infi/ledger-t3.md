# T-3 (#22) ruling ledger

- `Ruling:` `buildDocumentFilter` อ่านทุกอย่างใน `$transaction` เดียว และอ่าน `policy_versions` head **ก่อน** rows — เพื่อให้ `policyVersion` อธิบาย rows ที่อยู่ในฟิลเตอร์จริง ถ้าอ่านทีหลังจะได้ version ใหม่กว่าข้อมูล = cache คิดว่าสดทั้งที่เก่า
- `Ruling:` visibility เป็น hard override อ่านก่อน ACL เสมอ — hidden doc เข้า `deniedDocumentIds` ก่อนอ่าน ACL แถวใด ๆ ไม่มี grant ใดยกเลิกได้ — RED-proven (ถอด visibility query → เทส hard override แดง)
- `Ruling:` `allowedDocumentIds` เกิน cap 500 → **degrade เป็น matchNone** ไม่ truncate — list สั้นลงคือการเปลี่ยนขอบเขตสิทธิ์เงียบ ๆ · user actor ส่ง allowedDocumentIds = `AuthorizationContractError`
- `Ruling:` `policy.changed` publish **ใน transaction เดียวกับ** `policy_versions` insert ผ่าน outbox (`publishOperationalEvent(fact, tx)`) — crash ระหว่าง commit กับ publish ทำให้ cache ค้าง stale ตลอดไปโดยไม่มี event มาแก้
- `Ruling:` FilterCache staleness = "มี version ใหม่กว่า" ไม่ใช่ TTL — TTL 30s เป็นเพดานหน่วยความจำเท่านั้น · bus ล่ม → `disable()` แล้ว rebuild ทุกครั้ง ไม่เสิร์ฟ stale
- `Ruling:` runtime `document_acl` writes ต้องผ่าน `grantDocumentAcl`/`revokeDocumentAcl` เท่านั้น (T-1 backfill เขียนตรงได้เพราะเป็น migration) — ทุก gateway บังคับ `requireActor` ไม่มี default free pass
- `Ruling:` **F-20d** (QA-2 round 2) resolver เช็ค lifecycle ครบทั้ง `revokedAt` และ `expiresAt` ไม่ใช่ครึ่งเดียว — defense-in-depth ต่อจาก PR-3 middleware — เทส expired 60 วินาที → null
- `Fix:` `bumpVersion` เดิมใช้ `Number(actor.id) || null` = `NaN` สำหรับ service actor (`single-user`) — เปลี่ยนเป็น `actorIdOf()` คืน null เมื่อไม่ใช่ user · เพิ่ม `workspace:<id>` เข้า scopeKeys ของ grant/revoke ให้ cache invalidate ตรงขอบเขต
- `Carry → T-5:` filter ต้องถูกส่งเข้า `queryAuthorized` ทุก call site (9 `performSimilaritySearch` + 6 `fillSourceWindow` + pinned path) — T-3 ให้แค่ฟังก์ชัน ไม่ได้ wire
- `Carry → T-4:` cap batch `authorizeMany` 500 ที่ endpoint (QA-2) · `chat.read_others` ใน READ_ACTIONS ต้องทบทวนตอนแยก content_moderator (T-7, privilege borrowing)
- `Ruling:` **B-2** (architect) `actorResolver` derive `workspaceIds` จาก `workspace_users` เอง ไม่เชื่อ `locals.userWorkspaceIds` — เพราะไม่มีใครใน repo เขียน field นั้นเลย ถ้าเชื่อตามเดิม user Actor ทุกตัวได้ scope ว่าง → documentFilter matchNone ทุก path จริง (เทสชุดแรกไม่จับเพราะใช้ fixture Actor ล้วน) · คง `locals.userWorkspaceIds` เป็น override ให้ T-4a ที่โหลด membership อยู่แล้ว · `resolveActor(request, response, {db})` รับ db injectable · membership อ่านไม่ได้ = คืน [] (fail restrictive) · PMO ยืนยัน #22 เป็นเจ้าของไฟล์นี้ T-4a ไม่แตะ
- `Ruling:` เพิ่มเทส end-to-end ที่ resolve Actor ผ่าน `actorResolver` จาก user row + membership จริง แล้ว documentFilter ต้องคืนผลไม่ว่าง — กัน fixture Actor ปิดบังรูแบบ B-2 อีก
- `Fix:` `afterAll` DROP DATABASE ของ engine/documentFilter/t1-authz-migration ใช้ default 5s ทั้งที่ beforeAll ตั้ง 300s → flake — ตั้ง 60s ทั้งสามไฟล์

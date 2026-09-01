# T-4b (#29) ruling ledger

## W-5 — ActorIdentityStore → actorResolver

Ruling: `resolveActorRef` ย้ายมาอยู่ใน `actorResolver` แล้วลบ `utils/jobs/ActorIdentityStore.js` — grep gate สะอาด (เหลือแค่ comment อธิบายประวัติ) · ใช้ `workspaceIdsForUser` ตัวเดียวกับ HTTP path จึงตรงกันโดยโครงสร้าง ไม่ใช่โดยบังเอิญ
Ruling: Actor จาก job อ่าน user row เพื่อ**พิสูจน์ว่ายังมีสิทธิ์ทำงาน** ไม่ใช่เพื่อคัดลอกคอลัมน์ — `select: {id, suspended}` เท่านั้น · เทส assert เป็น **allowlist ของ key** ไม่ใช่ denylist ตามที่ QA-1 ขอ เพราะ denylist จะผ่านวันที่ users มีคอลัมน์ที่ 12 (เดิม `...user` spread ทั้งแถว รวม `password`, `seen_recovery_codes`, `web_push_subscription_config`)
Ruling: (Fix) **CoreJobWorker.claim spread `job.actor` ทับ actor ที่ resolve สด** — job row ที่เขียนไว้ก่อน revoke (หรือโดย enqueue path ที่ถูกเจาะ) เลือก `workspaceIds`/`orgId`/`impersonatedBy` ของตัวเองตอนรัน · แก้เป็น resolved ชนะเสมอ: row บอกแค่ว่า "รันในนามใคร" ส่วนสิทธิ์ resolve ใหม่ทุก claim — RED-proven
Ruling: (QA-1) `orgId` **derive ไม่อ่านจาก row** ทั้ง user และ service branch — orgId ตัดสินว่าอ่าน policy row ของ org ไหน ถ้า row เลือก tenant เองได้คือ cross-tenant read รอเกิด
Ruling: user ที่ suspended/ถูกลบ → `null` ไม่ fallback เป็น service principal — fallback คือการยกระดับสิทธิ์งานค้างของ user ที่ถูกระงับเป็นสิทธิ์ระบบเงียบ ๆ

## orgWide — filter shape

Ruling: (PMO, จาก QA-1) `"*"` ใน `workspaceIds` ขัด seam 07 — array นั้นถูก push เข้า provider query จริง driver จะไปหา namespace ชื่อ `"*"` · เปลี่ยนเป็นฟิลด์ `orgWide: boolean` แยก และ `hasScope` **ต้องนับ `orgWide`** ไม่งั้น B1 กลับมาในรูปใหม่ (single-user อ่านอะไรไม่ได้เลย) — RED-proven ก่อนแก้
Ruling: org-wide grant ของ **user** resolve เป็น membership ของ user นั้น ไม่ใช่ทั้ง org — grant แปลว่า "ทุก workspace ที่คุณอยู่" ไม่ใช่ "ทุก workspace" · เฉพาะ service/embed ที่ไม่มี membership row เลยจึงอ่านเป็น whole-org
Ruling: (Note) ` seam 07 typedef อัปเดตแล้ว (`orgWide:boolean` + หมายเหตุว่า driver ข้าม workspace narrowing แต่ยังใช้ predicate อื่นครบ)

## B-1 — api-key grants = grants(createdBy) ∩ scopes(key)

Ruling: (PMO) B-1 อยู่ที่ `actorResolver` ไม่ใช่ `validApiKey.js` — resolver เป็นที่เดียวที่สร้าง Actor อยู่แล้ว · Dev2 ทำซ้ำใน `engine.js` ระหว่างทาง PMO ตัดสินให้ของ resolver ชนะ Dev2 ถอดออก
Ruling: Actor เก็บ `api-key:<id>` เป็น audit provenance และพก `grantPrincipal` (creator) เป็นตัวที่ engine + documentFilter อ่าน grant · grant row ที่ตั้งชื่อ `api-key:<id>` ตรง ๆ ถูกเมิน — มีเทสล็อก กัน migration slip กลายเป็นช่องถือ policy แบบไม่มี audit
Ruling: (Fix) (RED เจอเอง ไม่อยู่ใน recon) org-wide branch เดิมเช็ค `actor.type` — key เป็น `service` เสมอ ดังนั้น **key ที่ทำงานแทน user จะอ่านเอกสารทั้ง org ทั้งที่ user เจ้าของอ่านไม่ได้** · เปลี่ยนไปเช็ค `grantPrincipal.type`
Ruling: (Fix) (RED เจอเอง) workspace-bound key สืบทอด reach เต็มของ creator — `narrowToKeyBinding` intersect กับ `api_keys.workspaceId` ซึ่ง**แคบลงอย่างเดียว** ไม่มีทางกว้างขึ้น แม้ binding ถูก forge
Ruling: (QA-1 blocker) binding ต้อง gate ที่ **engine** ด้วย ไม่ใช่แค่ documentFilter — bound key (ws X) เรียก `authorize` บน ws Y ผ่านได้ · ย้ายไป `authorize()` blanket ก่อน policy lookup เหมือน impersonation · เพิ่มเคสที่ QA-1 ไม่ได้ระบุ: resource ที่ `workspaceId == null` bound key ก็ถูกปฏิเสธ — attribute ไม่ได้ ≠ อยู่ใน scope
Ruling: (PMO อนุมัติ) `createdBy = null` ใน **single-user mode** → fallback เป็น `SERVICE_PRINCIPALS.singleUser` · multi-user → deny (`no_grant_principal`) · `isMultiUserMode` อ่านไม่ได้ → deny · เหตุผล: `endpoints/system.js:1073` สร้าง key ด้วย `ApiKey.create(null, name)` และปฏิเสธทำงานใน multi-user mode แปลว่า single-user deployment **ทุก key ที่เคยออกมี createdBy null ทั้งหมด** — deny ตามสเปกตรง ๆ = /v1 ตายทั้ง surface ตอน upgrade สำหรับ deployment ที่วินิจฉัยเองได้ยากที่สุด
Ruling: (Fix) (RED เจอเอง) **cross-credential grant confusion** — `validBrowserExtensionApiKey` เขียน `apiKeyContext` เหมือนกัน แต่ `keyId` มาจากตาราง `browser_extension_api_keys` คนละ id sequence กับ `api_keys` → extension key id N ได้ grant ของ creator ของ API key id N ซึ่งเป็นคนละคน · แท็ก `keyKind: "browser-extension"` แล้ว resolver ข้าม branch ไปใช้ `locals.user` ที่ extension resolve มาแล้ว · แท็กแทน infer เพื่อไม่ให้ context shape ใหม่หลุดเข้า branch ผิดเงียบ ๆ

## W-8 — grant check บน /v1

Ruling: (PMO ruling (b)) grant check ต่อท้าย scope check ใน `validApiKey` เดียวกัน **ไม่ใช่ router middleware** — Express รัน `router.use()` ตามลำดับ register และทุก /v1 route register หลัง mount ดังนั้น middleware แยกจะรันได้แต่ **ก่อน** `apiKeyContext` เกิด = ต้อง resolve key ซ้ำ และ grant denial จะหลุดออกนอก `auth.key_used`
Ruling: scope รันก่อนเสมอ — request ที่ scope ตกแล้วต้องไม่ทำให้ policy store ทำงาน (มีเทสยืนยันว่า engine ไม่ถูกเรียก)
Ruling: (Techlead) **event เดียว** `auth.key_used` เพิ่มฟิลด์ `denyReason: "scope"|"grant"|null` ไม่ใช่ emit event ที่สอง — ไม่งั้น audit เดิมจะบอกว่า key ใช้สำเร็จขณะที่ caller เห็น 403 · response body เหมือนกันทั้งสองครึ่ง ไม่บอก client ว่าครึ่งไหน reject
Ruling: wildcard action = skip grant check + จดไว้ที่นี่ (burn-down ของ Dev1 ผ่าน `EXPECTED_WILDCARD_ROUTES` ซึ่ง T-4b ไม่แตะ) · actor resolve ไม่ได้ / engine พัง = deny — "ไม่มีอะไรคัดค้าน" ไม่เท่ากับ "มีอะไรอนุมัติ"

## W-9 — G8 unscoped resolves

Ruling: รูจริงคือ **unbound key** — `binding` ของ PR-4a คุมเฉพาะ key ที่ผูก workspace; key ที่ไม่ผูกผ่าน binding ฟรีแล้ว grant check ถามแบบ org-wide ส่วน route ไป resolve workspace ไหนก็ได้ → creator มี grant บน ws A ก็เข้า ws B ได้ (22 จุด `Workspace.get`/`WorkspaceThread.get`)
Ruling: แก้ที่ middleware จุดเดียว ไม่แตะ 22 call site — จุดที่ 23 ในอนาคตถูกคุมโดยโครงสร้าง
Ruling: (Fix) resolve workspace **ครั้งเดียว** แชร์สองครึ่ง — ตอนแรกเขียนเป็น 2 lookup แล้ว `mockResolvedValueOnce` ถูกกินโดยครึ่งแรก bound-key test แดง · สองรอบยังเป็นสองโอกาสให้สองครึ่งไม่ตรงกันด้วย
Ruling: (PMO อนุมัติ) **carve-out**: route ที่ไม่ประกาศ workspace ไม่ใช้ key binding ที่ ingress เพราะ handler narrow เอง · รายชื่อสำหรับ QA ยิงเฉพาะเจาะจง: `GET /v1/workspaces`, `POST /v1/workspace/new`, `POST /v1/document/upload`, `/upload/:folderName`, `/upload-link`, `/raw-text`, `GET /v1/documents`, `/documents/folder/:folderName`, `/document/:docName`, `/document/accepted-file-types`, `/document/metadata-schema`, `/document/create-folder`, `/document/remove-folder`, `/document/move-files`, `/document/generated-files/:filename`, `DELETE /v1/system/remove-documents` · ตัวคุ้มกันคือ `boundKeyWorkspaceScope.test.js` (bound key ยัง list ได้แค่ workspace ตัวเอง, สร้าง workspace ใหม่ไม่ได้, purge system-wide ไม่ได้) · route ที่ระบุ workspace ยังผ่าน engine gate ของ QA-1 ครบ

## W-10 — embed session binding (S-24 / G12)

Ruling: PR-0d เช็ค uuid format + enabled + origin แต่ไม่เคยเช็คว่า session เป็นของ embed ตัวนั้น → embed A อ่าน/ลบ history ของ embed B ได้โดยใส่ session id ของ B ใต้ embedId ของ A **จาก origin ที่อนุญาตและ embed เปิดอยู่** คือสภาพที่ gate ของ PR-0d ผ่านหมดพอดี — ข้าม tenant boundary ไม่ใช่แค่ visitor boundary
Ruling: ownership query รัน**ท้ายสุด**ของ gate ทั้งหมด — เป็น gate เดียวที่แตะ DB จึงต้องให้ origin ผิด/uuid ผิดถูกปฏิเสธก่อนโดยไม่ query
Ruling: session ของ embed อื่น กับ session ที่ไม่มีอยู่จริง ตอบ 404 เหมือนกัน — แยกคำตอบคือการยืนยันว่ามี embed อื่นเป็นเจ้าของ id นั้น
Ruling: (Note) ` **ไม่ได้ปิดรูทั้งหมด** — แคบลงเหลือ "ต้องรู้ session id ที่ออกโดย embed นี้" ส่วน unguessable token (signed cookie / HMAC ตอน session start) เป็น issue แยกตาม PMO ruling · เขียนไว้ที่ call site ด้วย เพื่อไม่ให้คนอ่านเข้าใจว่าปิดครบแล้ว

## W-11 — jobs/channels named principal

Ruling: null actor ไม่ใช่ default ที่ปลอดภัย — engine deny ซึ่งถูก แต่ job จะพังเงียบแทนที่จะพังดัง · `jobActor()` บังคับให้ทุก site **เลือก** principal
Ruling: `extract-memories` รันเป็น user ต้นทาง ไม่ใช่ service — รันเป็น service จะสรุป chat ที่ user เจ้าของอ่านไม่ได้แล้ว · ข้าม group ถ้า user suspended/ลบ/ออกจาก workspace
Ruling: `streamResponse` (telegram) **บังคับ** `actor` ไม่มี default — caller ใหม่จะเข้าถึง retrieval โดยไม่มี identity ไม่ได้ · T-5 จะแปลง actor ตัวนี้เป็น documentFilter ที่ `:226`
Ruling: (Carry → T-7 (schema, ไม่ใช่ wiring)) ` `approved_users` (`utils/telegramBot/index.js:369`) เก็บ chatId + telegram username + workspace slug แต่**ไม่มี AnythingLLM user id** — จึง resolve user ต้นทางไม่ได้ ทุก Telegram chat ที่ verified แล้วใช้ identity เดียวกันและ document scope เดียวกัน · การผูก approved_users เข้ากับ user row จริงเป็นการแก้ schema อยู่นอก scope T-4b

## W-12 — canonicalize call sites

Ruling: (C-1, PMO) T-4b **ไม่** flip `ENABLE_DOC_VECTORS_CANONICALIZE` — 7 ใน 11 legacy call site คือ non-Lance provider ที่ T-6 ถือ และอยู่นอก Phase 0 gate · แก้ comment ใน `docVectorsCanonicalize.js` ที่ยังเขียนว่า T-5 เป็นคนเปิด · มีเทสยืนยันว่า job ยัง refuse
Ruling: call site ของ T-4b match **ทั้งสอง id** ไม่ใช่สลับจาก legacy เป็น canonical — job รันเป็น batch ระหว่างรันเอกสารหนึ่งเป็น canonical อีกอันยังเป็น legacy · both-ids ถูกทั้งก่อน ระหว่าง และหลัง
Ruling: (Fix) `DocumentVectors.deleteForWorkspace` มีบั๊กเดียวกัน (recon ระบุแค่ `models/vectors.js:14,47` เป็นของ T-5) — แก้ที่นี่เพราะเป็นเคสที่ guard comment ของ job ระบุชื่อไว้ตรง ๆ
Ruling: เทส W-12 อ่าน source ไม่ mock prisma — failure mode คือ WHERE ที่ match 0 แถว ซึ่ง mocked client จะรายงานสำเร็จทั้งสองทาง คือทางที่บั๊กนี้จะหลุดขึ้น production พอดี

## test infrastructure

Ruling: (Fix) **9 failures ที่ผมรายงานว่าเป็น pre-existing ของ main นั้นผิด** — DB `approofworkspace_t4b` ของผมไม่เคยรัน `migrate deploy` (ไม่มีตาราง `api_keys` ด้วยซ้ำ) · PMO push back ถูก · บทเรียน: อย่า carry failure เป็น pre-existing โดยไม่ verify กับ baseline ที่สะอาดจริง
Ruling: (§7.1a) แปลง 5 suite จาก `db push` → `migrate deploy` แล้วลบ allowlist ให้ gate อ่าน clean · `db push` สร้าง schema แต่ไม่รัน migration file เลย ดังนั้น vocabulary/roles/grants ของ T-1 หายไปหมด — `engine.evaluate()` ตอบ `unknown_action` ทุก action และ suite พวกนั้น**จะผ่านแม้ลบ engine ทิ้ง** · แทนที่ `prisma/seed.js` mirror ที่ผมใส่ไว้ก่อนหน้า (migrate deploy คือของจริง ไม่ใช่การประมาณ)
Ruling: (PMO request) `__testHelpers__/grantStore.js` เป็น permissive store สำหรับ suite ที่ทดสอบ **scope** เท่านั้น + มีเทสบังคับว่า suite ชื่อ `t4b*` ห้ามเรียก `grantingPrismaMock()` — grant suite ที่ไปใช้ helper permissive จะผ่านไม่ว่า engine ทำอะไร · ย้ายออกจาก `__tests__/` เพราะ jest เก็บทุก `.js` ที่นั่นเป็น suite แล้ว fail ว่า "must contain at least one test"

## carries

Ruling: (Carry → T-5) ` filter ต้องส่งเข้า `queryAuthorized` ทุก call site · subscriber `authorization-cache` ต้องลงพร้อม cache wiring (DoD ไม่ใช่ตามหลัง) · `streamResponse` มี `actor` พร้อมใช้แล้วที่ telegram `:226`
Ruling: (Carry → T-6) ` flip `ENABLE_DOC_VECTORS_CANONICALIZE` หลังย้าย 7 provider · เมื่อ flip แล้ว call site ของ T-4b ไม่ต้องแก้อีก (match ทั้งสอง id อยู่แล้ว)
Ruling: (Carry → T-7) ` telegram `approved_users` ไม่มี user id (ดู W-11) · embed session id ที่เดาไม่ได้ (ดู W-10) · `chat.read_others` ใน READ_ACTIONS ตอนแยก `content_moderator`

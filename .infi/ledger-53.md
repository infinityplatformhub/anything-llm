# #53 ledger — `org.member`

Ruling: `workspaces.js:798` คง `chat.send` (PMO ruling A) — resolver `chatByIdParam`
คืน `workspaceId` ไม่ใช่ null ถ้าเปลี่ยนเป็น `org.member` = ละเมิด rule 1 ในคอมมิตที่
สร้าง rule นั้นเอง และเป็น mutation บน chat ตัวเอง ไม่ใช่ membership proxy
recon §4 นับผิด (ผมเขียนเอง นับ 7 route แล้วเหมาโดยไม่ดู resolver รายตัว)
ถ้าผิด: impersonated session แก้ chat ได้ ซึ่ง DoD 2 ห้ามไว้

Ruling: scope check วางหัว `evaluate()` หลัง `findUnique` ก่อนอ่าน grants (PMO ruling A)
ไม่ใช่ "ก่อน R5" ตามตัวอักษร — R5 กับ key-binding อยู่ใน `authorize()` และเป็น blanket
ที่ไม่แตะ DB โดยเจตนา (comment engine.js:68,75) scope อ่านได้จาก permissions row เท่านั้น
ถ้าเช็คก่อน R5 ต้องยิง DB ใน authorize() = ทำลาย property ที่ว่า actor ที่ถูกปฏิเสธแล้ว
สั่งให้ policy store ทำงานไม่ได้ ถ้าผิด: impersonated actor ใช้ scope mismatch เป็น
ช่องให้ engine query DB ได้

Ruling: scope mismatch → `AuthorizationContractError` ไม่ใช่ deny เงียบ
route ถามคำถามที่ action ตอบไม่ได้ = bug ที่ wiring ไม่ใช่คำตัดสินเรื่อง actor
deny เงียบจะทำให้ gate ที่ต่อผิดอ่านเหมือนการปฏิเสธปกติแล้วรอด review
ถ้าผิด: 500 แทน 403 ในการใช้งานที่ถูกต้อง — แต่ sweep test เป็นชั้นที่จับก่อน ship

Ruling: `org.member` เข้า READ_ACTIONS ได้เพราะ authority-free จริง — ทุก route ที่ถาม
มันยัง filter membership ใน handler เอง ไม่ใช่เพราะ "เป็น read"
ถ้าผิด: impersonated session เห็นสิ่งที่ไม่ควรเห็น แต่ handler ยังกรองอยู่

Ruling: seed ให้ 4 org roles เท่านั้น ไม่ให้ workspace roles (owner/editor/viewer)
เพราะ role พวกนั้น grant per workspace ซึ่ง action ที่ถามได้แค่ org scope จะเข้าไม่ถึง
โดยโครงสร้าง ถ้าผิด: ไม่มีผล (unreachable) แต่ทำให้คนอ่านเข้าใจผิดว่าถามผ่านมันได้

Ruling: sweep test ใช้ **behavioural check ไม่ใช่ identity** — `resolveResource !== orgResource`
ใช้ไม่ได้เพราะ suite อื่นใน run เดียวกันเรียก `jest.resetModules()` ทำให้
`resourceResolvers` เป็นคนละ module instance route ที่ wire ถูกจะถูกฟ้องผิด
เปลี่ยนเป็น resolve จริงแล้วเช็ค `workspaceId != null`
**เจอตอน full suite เท่านั้น รันไฟล์เดียวเขียว** ถ้าผิด: sweep แดงสุ่มตามลำดับ suite

Ruling: path ใน sweep เอาจาก mounted router ไม่ใช่จาก recon — recon เขียน
`POST /workspace/:slug/chat` ซึ่ง**ไม่มีอยู่จริง** gate ทั้งสองใน chat.js เป็น
stream-chat (workspace + thread) และ `:798` mount จริงเป็น
`PUT /workspace/workspace-chats/:id` ถ้าผิด: assert route ที่ไม่มีอยู่ = เทสที่ผ่าน
เพราะไม่มีอะไรให้ตรวจ

Ruling: `engine.test.js` matrix แก้ให้ถาม action ตาม scope ที่มันประกาศ ไม่ใช่ยิง
ทุก action ใส่ workspace resource — เดิมมันยิงทุกอย่างที่ `wsResource()` ซึ่งตอนนี้
org-scoped action จะ throw การปล่อยไว้เท่ากับ assert ว่า engine เพิกเฉยต่อ scope column
เพิ่ม `expect(permissions.some(p => p.scope === "org")).toBe(true)` กันเทสกลายเป็น vacuous
ถ้าผิด: matrix ไม่ได้ตรวจ super_admin ครบทุก action อีกต่อไป

Ruling: count guard 2 ตัวอัปเดต ไม่ปิด — `vocabulary-diff` 62→63 + เพิ่ม `org.member`
ใน approved list ทั้งคู่แดงเพราะทำงานถูกต้อง

## RED / mutant
- mutant ตาม PMO: ย้าย scope check ไปหลังอ่าน grants → **เทสหลัก "asked about a
  workspace → throws" ยังเขียว** ตัวที่ตายคือ "the throw does not depend on the actor
  holding the action" (stranger ไม่มี grant) เพราะ member ถือ org-wide grant อยู่แล้ว
  จึงเดินผ่าน `no_grants` ไปถึง scope check ได้
  **ถ้ามีแค่เทสหลักตัวเดียว mutant จะรอด** — เทส stranger คือตัวที่ทำให้ ruling A
  ตรวจสอบได้จริง
- DoD 3 (org-wide member grant + zero workspace_users → denied `workspace.read`) เขียว
  พร้อม fixture assertion ว่า grant เป็น org-wide จริงและ membership = 0

## GREEN
`Tests: 1597 passed, 1597 total` / `Test Suites: 151 passed, 151 total` fresh DB
+ `check-local: all checks passed`

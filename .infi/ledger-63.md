# #63 ledger — chat.read never granted to workspace roles

Branch: `approof/63-chat-read-grant` · Worktree: `.claude/worktrees/g63`
Owner: Dev 5 · Base: `origin/approof/main` @ `ee2dec83`
Merge target: `ffb8b1f2` (tests-only on `9e600e81`)

## Origin

พบระหว่างทำ recon/implementation ของ V9 (#61) ไม่ใช่งานที่ตั้งใจไปหา — เทส V9 ทุกตัว
ได้ 404 ทั้งที่ actor เป็นสมาชิก workspace จริง ตามรอยไปเจอว่า gate ไม่เคยผ่านสำหรับใครเลย
นอกจาก super_admin

Ruling: หยุด V9 แล้วรายงาน blocker แทนการเปลี่ยนเทส V9 ให้ใช้ super_admin — PMO ruling
เปิดเป็น issue แยก. เหตุผล: เปลี่ยน fixture เป็น super_admin จะทำให้ V9 เขียวโดยที่ฟีเจอร์
ยังเรียกไม่ได้จริงสำหรับผู้ใช้ทุกคน (§7.9 กลับด้าน — เขียวด้วยเหตุผลผิด)
ถ้าผิด: V9 ship route ที่ผู้ใช้จริงได้ 404 และบั๊กเดิมของ 4 route ยังไม่มีใครเห็น

## The defect

`chat.read` ถูก seed เป็น permission ที่ migration `20260902020000:238` แต่ไม่มี
`INSERT INTO role_permissions` บรรทัดไหนแจกให้ role ใดเลย — super_admin ได้เพราะ
CROSS JOIN ที่ :295 เอาทุก permission ไม่ใช่เพราะมีคนตั้งใจแจก

Route ที่ gate ด้วย `chat.read` 4 จุด:
- `GET /workspace/:slug/chats` (`endpoints/workspaces.js:427`)
- `GET /workspace/:slug/thread/:threadSlug/chats` (`endpoints/workspaceThreads.js:145`)
- `GET /v1/workspace/:slug/chats` + `GET /v1/workspace/:slug/thread/:threadSlug/chats`
  (`utils/apiKeySecurity/scopes.js:29,40`)

`no_permission_in_roles` อยู่ใน `NON_DISCLOSING` ⇒ conceal เป็น **404**: ผู้ใช้ธรรมดา
ที่ขอประวัติแชท **ของตัวเอง** ถูกบอกว่าไม่มีอยู่จริง

Ruling: ไม่มีเทสไหนจับได้เพราะ `routeWiring.test.js` ใช้ fixture `role: "manager"`
ซึ่งได้ org grant — gate ผ่านด้วยเหตุผลที่ใช้กับผู้ใช้จริงไม่ได้ และไม่มีเทสไหน
assert 200 บน route เหล่านั้นเลย
ถ้าผิด: บั๊กประเภทนี้ (permission ที่ seed แล้วไม่แจก) จะรอดด่านต่อไปได้อีก

## Ruling (ก) → (ก′): the org-member half was a leak

Ruling: (ก) เดิม — grant `chat.read` ให้ workspace owner/editor/viewer **+ org member**
ผมทำตามแล้วเทสจับได้ทันที: `an org member who is not in the workspace is still refused`
เปลี่ยนจาก 404 เป็น **200 พร้อม history ของคนอื่น**
เหตุ: org-scope grant มี `workspace_id = NULL` และ engine อ่าน NULL-workspace grant ว่า
**ทุก workspace** — รูปเดียวกับ T-1 regression ที่ `routeWiring.test.js:280` ตรึงไว้
สำหรับ `workspace.read` และ T-4a ถอดออกจาก role นี้ไปแล้วด้วยเหตุผลเดียวกัน
(comment บน `member` ใน `prisma/seeds/permissions.js` เขียนไว้ครบ)

Ruling: (ก′) — grant ให้ **workspace owner/editor/viewer เท่านั้น** ไม่ให้ org member
PMO แก้ ruling หลังผมรายงานพร้อม probe. พิสูจน์แล้วว่าถอดครึ่งหลังออกได้ฟรี: ผู้ใช้จริง
ได้ `chat.read` ผ่าน workspace membership grant อยู่แล้ว ⇒ DoD ("member เห็นประวัติ
ตัวเอง 200") ยังผ่านครบ 
ถ้าผิด: instance ที่ติดตั้งใหม่ทุกเครื่องเปิดให้ทุกคนอ่านประวัติแชทของทุก workspace
— แย่กว่าบั๊กเดิม เพราะเดิมแค่ใช้ไม่ได้ อันนี้รั่ว

Ruling: `viewer` รวมอยู่ด้วยโดยตั้งใจ — viewer ถือ `chat.send` อยู่แล้ว การไม่ให้
`chat.read` = role ที่เขียนแชทได้แต่อ่านอันที่ตัวเองเพิ่งเขียนไม่ได้
ถ้าผิด: viewer ใช้งานไม่ได้จริงและจะถูกรายงานเป็นบั๊กใหม่รอบหน้า

Ruling: `content_moderator` **ไม่**ได้ `chat.read` ที่ org scope — Techlead-1 ชี้ว่า
มันถือ `chat.read_others` แต่ engine ไม่มี implication `read_others → read` จึงได้ 404
บนประวัติตัวเองเหมือนกัน. แก้โดยให้ผ่าน workspace membership เหมือนทุกคน ไม่ใช่ให้ที่
org scope ซึ่งจะรั่วแบบเดียวกับ (ก)
ถ้าผิด: ปิดช่องหนึ่งด้วยการเปิดช่องเดียวกันที่ role อื่น

Ruling: `chat.read_others` ไม่ถูกแตะเลย — คงอยู่ที่ super_admin + content_moderator
มีเทส exact-match ตรึงไว้ว่าไม่มี role ไหนได้เพิ่ม
ถ้าผิด: migration ที่ตั้งใจแก้ "อ่านของตัวเอง" แจก "อ่านของคนอื่น" ไปเงียบ ๆ

## Implementation

Migration slot **101000** `20260902101000_chat_read_role_grants`:
- `INSERT … SELECT … ON CONFLICT DO NOTHING` (idempotent) ให้ 3 workspace role
- `INSERT INTO policy_versions ('grant','org:1')` — bump เพื่อให้ process ที่ถือ
  filter อยู่ rebuild แทนที่จะ serve decision ก่อน grant จนกว่า TTL หมด
  (`FilterCache.get` อ่าน `currentPolicyVersion` ทุกครั้ง)

Ruling: `prisma/seeds/permissions.js` ต้อง sync ด้วย ไม่ใช่แค่ migration — seed คือสิ่งที่
ติดตั้งใหม่ใช้ ถ้าแก้แต่ migration เครื่องใหม่จะยังเจอบั๊กเดิม. เพิ่ม `chat.read` ใน
owner/editor/viewer + ขยาย comment ของ org `member` อธิบายว่าทำไมไม่ใส่ที่นั่น
(อ้าง comment T-4a ที่มีอยู่ในไฟล์แล้ว)
ถ้าผิด: migration แก้ instance เก่า seed ยังพังกับ instance ใหม่ = บั๊กเดิมกลับมาครึ่งหนึ่ง

## Tests

`__tests__/security/authorization/chatReadGrant.test.js` — 11 tests (real PG,
`migrate deploy` + `seed.js`, real route stack)
`__tests__/api/chatReadV1Grant.test.js` — 4 tests (real app ผ่าน supertest)

RED (ถอด migration + seed) — แดง 6 ถูกเหตุผลทั้งหมด:
```
FAILED editor allowed chat.read              FAILED member 200 /chats
FAILED every seeded workspace role holds     FAILED member 200 thread chats
FAILED chat.read does not open other thread  FAILED chat.read returns only own chats
PASSED (guard ×5): read_others ไม่กระจาย · editor denied read_others ·
       content_moderator outsider 404 · super_admin · org-member outsider 404
```
RED ของ `/v1` suite: member key 200 ทั้งสอง route กลายเป็น 403; outsider 403 เขียว
ทั้งก่อนและหลัง = สิ่งที่ยืนยันว่า fix ไม่ได้ทำให้ route กว้างขึ้น

Ruling: เทส `every seeded workspace role holds chat.read` ใช้ `toEqual` แบบ exact
ไม่ใช่ `arrayContaining` — ประเด็นของเทสคือ org member ต้อง**ไม่**อยู่ในลิสต์
containment assertion จะเขียวต่อไปแม้ grant กลับมา
ถ้าผิด: การถอย ruling กลับไป (ก) จะไม่มีอะไรจับ

Ruling: (QA-2 เตือน + Techlead-1 NIT) 404 บน thread route มี **2 สาเหตุ** —
`chat.read` gate และ `validWorkspaceAndThreadSlug` ที่กรอง thread ด้วย `user_id`
เทส 200 ใช้ thread ที่ actor เป็นเจ้าของ ⇒ สาเหตุเดียวที่ 404 ได้คือ gate
และเพิ่มเทส `chat.read does not open another user's thread` (guard ว่า actor ผ่าน gate
จริงก่อน แล้ว assert 404) ⇒ พิสูจน์ว่าสองสาเหตุแยกกันจริง ไม่ใช่ตัวหนึ่งบัง
ถ้าผิด: เทสเขียวโดยที่ gate ไม่เคยถูกทดสอบ (§7.9)

Ruling: (Techlead-1 NIT-1) เทส org-outsider เพิ่ม premise guard — assert
`principal_role_grants` มี **1 แถวเป๊ะ**, `workspace_id` NULL, role = org `member`
ถ้าผิด: 404 ของผู้ใช้ที่ไม่มี grant อะไรเลยก็เขียว = พิสูจน์คนละเรื่อง

Ruling: (Techlead-1 NIT-2) `/v1` ทั้งสอง route ใช้ key **สองใบ scope เท่ากันเป๊ะ**
(`["chat.read"]`) ต่างกันแค่ creator เป็นสมาชิก ws หรือไม่ ⇒ ผลต่างมาจาก grant half
ของ `validApiKey` เท่านั้น. outsider creator ได้ org `member` grant จริง ⇒ 403 แปลว่า
"ไม่มี chat.read ใน ws นี้" ไม่ใช่ "ไม่มีสิทธิ์อะไรเลย". guard `history.length > 0`
บนทั้งสอง 200 ⇒ 200 เปล่า ๆ ไม่ผ่าน

Ruling: §7.3a — describe title ขึ้นต้น `#` เปลี่ยนเป็น "issue 63:" 2 จุด
(`chatReadGrant.test.js:209`, `:297`) + sweep ทั้ง diff ยืนยันไม่เหลือ
ถ้าผิด: commented-code gate อ่าน `#` บนบรรทัดที่ลงท้าย `{` เป็นคอมเมนต์

## Retraction — apiKeys.postgres 5 failed

Ruling: ผมรายงานผิดว่า `apiKeys.postgres.test.js` แดง 5 ตัวอยู่แล้วบน main —
**ไม่จริง ถอนแล้ว** สาเหตุคือ DB `approofworkspace_dev5` ของผมมี `_prisma_migrations`
20 แถวจาก 22 และไม่ได้ seed ซ้ำหลัง migrate. baseline worktree ที่ผมรันเทียบก็ชี้ DB
เดียวกัน จึงแดงเหมือนกัน — ยืนยันแค่ว่า DB เสียสองที่ ไม่ได้ยืนยันว่าบั๊กอยู่บน main
สร้าง `approofworkspace_dev5b` ใหม่ → `migrate deploy` → `seed.js` → 6/6 เขียว
ถ้าผิด: เปิด issue ไล่บั๊กที่ไม่มีอยู่จริง และปล่อยบั๊กจริงที่อาจซ่อนอยู่หลัง noise นี้
[→ §7.1c: baseline ต้องใช้ DB ใหม่เสมอ ไม่ใช่ DB เดียวกับ tree ที่กำลังสงสัย]

## GREEN

`Test Suites: 152 passed, 152 total` / `Tests: 1596 passed, 1596 total`
(fresh DB `approofworkspace_dev5b`, node@22, `API_KEY_PEPPER` 39 bytes)

## Handoff

V9 (#61) `77cdb938` rebase ทับหลัง merge — ชนแค่ `schema.prisma` และคนละบล็อก
(main เพิ่ม SAML models ~416, V9 แก้ `workspace_chats` ~205); slot 100000 ยังว่าง
QA-1 NIT (migrate-only test) ไปอยู่ใน V9 commit ตาม PMO
`/v1/workspace/:slug/chats` คืน chat ของทุก user (ไม่ใช่ของ caller) = issue #64 ใหม่
— นอกขอบเขต #63 ซึ่งแก้เฉพาะ gate ไม่ใช่ row filter

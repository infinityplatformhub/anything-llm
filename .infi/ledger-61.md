# #61 ledger — V9 chat history search

Branch: `approof/v9-chat-search` · Worktree: `.claude/worktrees/v9`
Owner: Dev 5 · Base: `origin/approof/main` @ `44bd9f53` (after #63 merged)
Migration slot **100000**

## Recon

Ruling: trigram (`pg_trgm`) ไม่ใช่ `tsvector` — เป็นการตัดสินเรื่องภาษา ไม่ใช่ performance
Postgres แบ่งคำด้วย whitespace ก่อนเข้า dictionary แต่**ภาษาไทยไม่เว้นวรรคระหว่างคำ** และ
core ไม่มี Thai segmenter ⇒ `to_tsvector('simple','ค้นหาประวัติแชท')` ได้ lexeme เดียว
ทั้งประโยค ค้น `ประวัติ` ไม่เจอ. ตรวจ `pg_available_extensions` แล้ว: มี `pg_trgm 1.6`,
`unaccent 1.1`, `vector 0.8.6` — **ไม่มี pgroonga**
ที่ยอมจ่าย: ไม่มี ranking/stemming/phrase proximity เรียงตาม recency ไม่ใช่ match quality
ถ้าผิด: index ที่ไม่เคยตรงกับ query ภาษาไทยเลย — แย่กว่าไม่มี index เพราะ**ดูเหมือน**มี search

Ruling: (Q1 PMO) per-workspace `GET /workspace/:slug/chats/search?q=` = V9 ทั้งหมด
cross-workspace ไป V10 — ไม่มี resource resolver ระดับ org สำหรับ chat และต้องวน
authorizeMany ต่อ workspace (cap 500)
ถ้าผิด: scope บานจาก 1 cw เป็นงานที่ต้องมี leak test ของ V10 มาก่อน

## Storage — response_text

Ruling: (Q2 PMO) plain column `response_text` **ไม่ใช่ generated column**
`response` เก็บ JSON ทั้งก้อน (`{text, sources[], attachments[]}`) — index raw จะ match
ชื่อไฟล์/path ใน sources ที่ผู้ใช้ไม่เคยเห็น = false positive **และ** metadata disclosure
generated column จะ evaluate cast ทุกแถวตอน migrate แล้วล้มทั้ง migration ที่แถวเสียแถวแรก
— แถวเสียมีจริง (`convertToChatHistory` ข้ามแถวที่ `data.text` ไม่ใช่ string อยู่แล้ว)
backfill จึงใช้ guard `pg_input_is_valid(response,'jsonb')` (PG16+, target PG17) ⇒ แถว JSON
พังได้ NULL ไม่ระเบิด. แถวที่ render ไม่ได้อยู่แล้วไม่จำเป็นต้องค้นเจอ
ถ้าผิด: migration ที่รันบนข้อมูลจริงไม่ได้ = ไม่ใช่ migration

Ruling: model เขียน `response_text` จาก object **ก่อน** `safeJSONStringify` ไม่ใช่ parse กลับ
จาก string ที่เพิ่ง stringify — ป้องกัน projection ที่ไม่ตรงกับ `response` เมื่อ stringify ต้อง
degrade. `typeof response?.text === "string"` เท่านั้น ไม่งั้น NULL (ไม่ coerce เป็น
`"[object Object]"`)
ถ้าผิด: ค้นเจอข้อความที่ไม่มีอยู่ในแชทจริง

## ACL — สองชั้น

Ruling: ชั้นประตูใช้ `requirePermission("chat.read", workspaceBySlug)` **เหมือน route เดิม
ทุกตัวอักษร** — route ตั้งชื่อ action + resolver แล้วไม่ตัดสินเอง (T-4a contract) ได้ฟรี:
403/404 concealment, `keyWorkspaceBinding` (engine.js:76), impersonation read-only
(`chat.read` อยู่ใน `READ_ACTIONS` แล้ว engine.js:27)
ถ้าผิด: route ใหม่ที่ตัดสินเองคือจุดที่ contract เริ่มแตก

Ruling: (Q3 PMO) ชั้นแถว `user_id` เป็น **required parameter ไม่ใช่ option** —
`searchForUser` คืน `[]` เมื่อไม่มี userId ไม่ใช่คืนทั้งหมด. รูปนี้เลือกมาเพื่อเลี่ยงบั๊กที่มีอยู่
จริงข้าง ๆ: `forWorkspaceByUser` กับ `forWorkspace` ต่างกันแค่ predicate นี้ และ route เลือก
ด้วย boolean ⇒ unfiltered read อยู่ห่างแค่ branch เดียวเสมอ. ใน `searchForUser` ไม่มี
unfiltered branch ให้ไปถึง
ถ้าผิด: ผู้ใช้อ่านประวัติแชทของกันและกัน

Ruling: `chat.read_others` **ไม่มีผล**ใน V9 — backlog เขียนว่า "ในแชทตัวเอง" cross-user
search เป็น V10 ที่มี leak test ของตัวเอง มีเทสตรึงว่า actor ที่ถือ permission นี้ยังเห็นแค่ของตัวเอง
ถ้าผิด: V9 กลายเป็น V10 ครึ่งใบที่ไม่มีเทสรองรับ

Ruling: `api_session_id: null` + `include: true` บังคับติดมาเสมอ ตามที่ route เดิมทำ
ถ้าผิด: chat จาก dev-API โผล่ใน frontend

## Input handling

Ruling: `q` trim แล้วบังคับ 2–200 ตัวอักษร ไม่งั้น 400 — floor ไม่ใช่ UX preference:
needle 1 ตัวไม่มี trigram ให้ lookup ⇒ GIN ใช้ไม่ได้ ⇒ full scan ของทุก chat ที่ user เป็นเจ้าของ
ถ้าผิด: DoD <1s พังด้วย query ที่สั้นที่สุด

Ruling: escape `\`, `%`, `_` ก่อนส่งเข้า `contains` (backslash ก่อน ไม่งั้น re-escape ตัวที่เพิ่ง
เติม) — คนค้น "100%" หมายถึง string ไม่ใช่ "ทุกอย่าง". Postgres default LIKE escape เป็น
backslash อยู่แล้ว จึงไม่ต้อง ESCAPE clause (และ Prisma `contains` ไม่มีที่ให้ใส่)
ถ้าผิด: `_` หรือ `%` เดี่ยว ๆ คืนทั้งประวัติ

Ruling: cursor ที่ไม่ใช่ positive integer = **400 ไม่ใช่เริ่มหน้าแรกเงียบ ๆ** — การเริ่มใหม่จะคืน
หน้าซ้ำแล้วดูเหมือน cursor ทำงาน
ถ้าผิด: client วนอ่านหน้าเดิมไม่รู้จบ

Ruling: (Q4 PMO) thread slug มาจาก 1 query `IN (...)` แยก ไม่ใช่ join — `thread_id` ไม่มี
relation โดยตั้งใจ (schema comment: เพิ่มแล้วต้อง whole-table migration)
ถ้าผิด: migration ที่ schema เตือนไว้ว่าอย่าทำ

## Migration 100000 — the pg_trgm schema defect

Ruling: `CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public` + qualify operator class
เป็น `public.gin_trgm_ops` — **บั๊กจริง เจอตอน gate ไม่ใช่ตอนออกแบบ**
`CREATE EXTENSION` ที่ไม่ระบุ SCHEMA ลงใน schema แรกของ search_path ซึ่งสำหรับ Prisma
connection ที่มี `?schema=<name>` คือ schema ต่อ-connection นั้น. เทสหลายชุดในเรโปต่อแบบนี้
(`samlRoutesHttp`, `keyScopeCeiling`, `purge.postgres` ฯลฯ ตั้ง `searchParams.set("schema",…)`)
⇒ extension ไปอยู่ใน schema เช่น `bound_docs_44810`, `gin_trgm_ops` resolve จาก `public` ไม่ได้,
`CREATE INDEX` บรรทัดถัดไปล้มด้วย **42704** ⇒ migration ล้มทั้งไฟล์ ⇒ DB ค้าง failed-migration
ที่บล็อก migration ถัดไปทั้งหมด (อาการปลายทาง: `public.api_keys does not exist` 34 tests แดง)
`IF NOT EXISTS` ไม่ช่วยเพราะ **schema-blind** — เจอ extension ใน schema ไหนก็ถือว่ามีแล้ว
**นี่จะเกิดบน deployment จริงที่ connection ตั้ง schema ไม่ใช่ปัญหาเฉพาะเครื่อง**
ถ้าผิด: instance ที่ใช้ schema อื่นนอก public migrate ไม่ผ่านและค้างสถานะที่ต้องกู้ด้วยมือ
[→ §7.13 ทุก `CREATE EXTENSION` ต้องระบุ SCHEMA + qualify operator class — PMO ใส่แล้ว]

Ruling: (Q6 PMO) `CREATE EXTENSION` ตรง ๆ ได้ — precedent ยืนยันด้วยการอ่านโค้ดจริง
`utils/vectorDbProviders/pgvector/index.js:49` รัน `CREATE EXTENSION IF NOT EXISTS vector;`
กับ database ของ operator และ `pgvector/SETUP.md:20,124` เขียนเป็นขั้นตอนติดตั้ง
ถ้าผิด: ไม่มีสิทธิ์ = ต้องกลับไป ILIKE ไม่มี index = DoD <1s พัง [→ residual O2 installer]

Ruling: เพิ่ม index `(user_id, workspaceId, id DESC)` ทั้งที่ไม่ใช่ของ V9 —
`workspace_chats` ไม่มี index อะไรเลยนอกจาก PK ตั้งแต่ initial schema ขณะที่ read เดิมทั้งสอง
filter ด้วยคู่นี้มาตลอด นี่เป็น migration แรกที่มองตาราง access pattern ของตารางนี้
ถ้าผิด: ไม่มี — ตัดออกได้ถ้า reviewer เห็นว่าควรแยก issue

## Tests

`__tests__/security/authorization/chatSearchSelfOnly.test.js` — 16 tests
`__tests__/prisma/chatReadGrantMigration.test.js` — 5 tests (QA-1 NIT จาก #63)

Ruling: **RED ยืนยันแล้วถูกเหตุผล** — ถอด `user_id` predicate ออกจาก `searchForUser`
แดง 3 ตัว และข้อความ fail ชี้แถวที่รั่วตรง ๆ ไม่ใช่ crash/500:
```
Received array: [{"chatId":2,"prompt":"bob asked about the quarterly-forecast too"...},
                 {"chatId":1,"prompt":"what is the quarterly-forecast?","response":"alice answer"...}]
```
Bob ค้นแล้วได้ chat ของ Alice กลับมาเป็นตัว ๆ (§7.9)

Ruling: fixture ทุกตัวต้องผ่าน `syncLegacyRoleGrant` — เดิม CAROL ถูกสร้างด้วย
`prisma.users.create` ล้วนซึ่งไม่มี grant ⇒ เทส "admin ที่ถือ chat.read_others ยังเห็นแค่ของตัวเอง"
assert เรื่อง permission ที่ actor **ไม่ได้ถืออยู่จริง** = เขียวด้วยเหตุผลผิด (เจอตอน rebase, guard
`decision.allowed === true` ในเทสเป็นตัวจับ)
ถ้าผิด: เทสที่ยืนยัน scope ของ V9 ไม่ได้ยืนยันอะไรเลย

Ruling: (QA-1 NIT #63) `chatReadGrantMigration.test.js` รัน **`migrate deploy` อย่างเดียว
ไม่รัน seed** — instance ที่ upgrade ไม่เคย re-seed ดังนั้น migration ต้องพก grant มาเอง
เทสอื่นทั้งหมดรัน seed ด้วย ทำให้ seed อาจกลบสิ่งที่ migration ควรทำ. RED: ถอด 101000 ⇒
แดง 3/5. ใช้ snapshot ที่เก็บใน `beforeAll` ไม่ใช่อ่าน live state เพราะเทส idempotency
รัน INSERT ซ้ำซึ่งจะซ่อมสถานะที่เทสอื่นกำลังตรวจ ⇒ เขียวเพราะลำดับเทส
ถ้าผิด: เทสที่ผ่านเพราะ seed ไม่ใช่เพราะ migration

Ruling: **ตัดเทส policy_versions ออก** เขียนคอมเมนต์อธิบายแทน — assertion ระดับนี้แยก bump
ของ 101000 จาก `('grant','org:1')` หลายแถวที่ T-1 backfill เขียนไว้ไม่ได้ ทั้งแบบ "มีแถวแบบนี้อยู่"
และ "แถวล่าสุดหน้าตาแบบนี้" **เขียวทั้งที่มีและไม่มี migration** ⇒ แย่กว่าไม่มีเทส เพราะรายงานว่า
ตรวจแล้วทั้งที่ตรวจไม่ได้ PMO ruling: ไม่แก้ migration 101000 ที่ merge แล้ว
ถ้าผิด: bump หายไปโดยไม่มีใครรู้ (แต่ก็ไม่มีใครรู้อยู่ดีถ้าเก็บเทสปลอมไว้)
[→ residual: policy_versions rows ไม่แยก origin — backlog]

Ruling: (Q5 PMO) DoD "<1s ที่หมื่นข้อความ" ไม่ทำเป็น assertion — wall-clock ใน CI คือ
flake generator (โค้ดเดิมผ่านบนเครื่องว่างและแดงตอนรันคู่ขนาน) แยกเป็น: assert `EXPLAIN`
ใช้ index scan (deterministic) + เวลาจริงเป็น evidence
ถ้าผิด: เทสที่แดงสลับเขียวโดยไม่มีใครแก้อะไร

## Rebase + environment

Ruling: worktree `node_modules` ต้องเติมหลัง rebase — #43 เพิ่ม `xml-crypto`,
`@xmldom/xmldom`, `xpath` เข้า package.json หลังผม hardlink มา ⇒ 21 suite ตายตั้งแต่ import
(`SamlIdentityProvider` → `endpoints/identity.js` → `index.js` ⇒ ทุก suite ที่ require `index.js`
ล้มหมด) ไม่ใช่แค่ suite ของ SAML. เช็คด้วยการ diff package.json กับ node_modules ทั้งชุด
ไม่ใช่ไล่ทีละ error
ถ้าผิด: gate แดงด้วยเหตุผลที่ไม่เกี่ยวกับ diff เลย [ซ้ำกับบทเรียนใน ledger-50 §7.6b]

Ruling: rebase ทับ `44bd9f53` ไม่มี conflict — ชนแค่ `schema.prisma` และคนละบล็อก
(main เพิ่ม SAML models ~416, V9 แก้ `workspace_chats` ~205) slot 100000 ยังว่าง
ตรวจด้วย `merge-tree` ก่อน rebase ไม่ใช่ลองแล้วดู

## Round 2 — Techlead-1 F1 + QA-3 F1–F5

Ruling: `responseTextOf` / `withResponseTextFrom` ครอบ **ทั้ง 4 write path** ที่เขียน
`response` — `new`, `_update`, `upsert` (agent chat-history), `bulkCreate` (import)
เดิม derive แค่ `new` ⇒ (F1) แก้แชทแล้วยังค้นเจอด้วยข้อความที่ลบไปแล้ว และ route คืน
`response_text` เก่าออก API · (F2) agent overwrite ผ่าน upsert ทิ้ง projection เก่า ·
(F3) แชทที่ import มาค้นไม่เจอเลย. วางที่ model ไม่ใช่ที่ call site เพราะกฎที่อยู่ใน caller
คือกฎที่ caller คนถัดไปไม่รู้
ถ้าผิด: ผู้ใช้ลบข้อความแล้วยังค้นเจอ = ลบไม่จริงในมุมของ search

Ruling: เพิ่มเทสที่ **อ่าน source ของ model** ว่าไม่มี prisma write ไหนตั้ง `response`
โดยไม่แตะ `response_text`/helper — เทส 4 path ข้างบนตั้งชื่อ path ที่มี**วันนี้** path ที่ 5
ที่เพิ่มทีหลังจะผ่านทั้ง 4 แล้วยัง ship บั๊กเดิม. มี guard ว่าถ้า regex จับไม่ได้เลยให้แดง
(เจอตอนเขียน: regex แรกจับ 0 แล้วเทสเกือบเขียวโดยไม่ตรวจอะไร)
ถ้าผิด: เทสที่ผ่านเพราะ pattern ไม่ match ไม่ใช่เพราะโค้ดถูก

Ruling: (F5) **`#61` ตรวจจับ ไม่แก้** — pg_trgm ตัด trigram ด้วย `LC_CTYPE` ⇒ DB ที่
สร้างด้วย `LC_CTYPE=C` (ค่า default ของ initdb เมื่อ env ไม่มี locale = สภาพปกติของ
container image บาง) ให้ **0 trigram สำหรับภาษาไทย** วัดจริงบน PG17:
```
ctype=C            show_trgm('ประวัติ') -> {}
ctype=en_US.UTF-8  show_trgm('ประวัติ') -> 7 trigrams
```
ไม่มี error ใด ๆ index สร้างได้ query ผ่าน ILIKE คืน**แถวถูกต้อง** — ด้วยการ scan ทั้งตาราง
⇒ ค้นภาษาไทยเสีย index เงียบ ๆ = DoD "<1s ที่หมื่นข้อความ" ไม่จริงสำหรับภาษาหลักของ product
พิสูจน์ระดับ plan ที่ 20k แถว: C → `Seq Scan` (cost 478, 3.8ms) · UTF-8 → `Bitmap Index Scan`
บน trgm (cost 47, 0.05ms)
collation ของ database ตรึงตอนสร้าง ⇒ แก้ไม่ได้จาก migration ต้องเป็น operator action
ถ้าผิด: ลูกค้าไทยได้ full-scan ทุก query โดยไม่มีอะไรบอก
[→ O2 installer ต้องบังคับ locale ตอน initdb — residual]

Ruling: (F5a) migration ใช้ `RAISE WARNING` **ไม่ใช่ EXCEPTION** — collation ตรึงตอนสร้าง
ถ้า fail ที่นี่ operator จะเหลือ migration ที่ apply ไม่ได้และไม่มีทางไปต่อจากใน migration
ค้นภาษาอังกฤษยังทำงาน และส่วนที่เหลือของ migration ยังถูกและยังต้องการ
ถ้าผิด: instance ที่ locale ผิด upgrade ไม่ได้เลยแทนที่จะ upgrade ได้แต่ช้าเฉพาะไทย

Ruling: (F5b) boot report `utils/chatSearch/localeSupport.js` ทรงเดียวกับ
`reportRetrievalFilterSupport` เรียกทั้ง bootSSL/bootHTTP — เพราะ WARNING ของ migration
รันครั้งเดียวแล้วหายไปใน log ตอน deploy ข้อความ log ระบุ 3 อย่าง: ctype ที่เป็นอยู่, ราคาที่จ่าย
(scan ทั้งตาราง), และวิธีแก้ (`TEMPLATE template0` + reindex) — เทส assert ทั้งสามไม่ใช่แค่
"มี log"
ถ้าผิด: operator เห็นบรรทัดที่บอกว่ามีปัญหาแต่ไม่บอกว่าทำอะไรต่อ

Ruling: `show_trgm` ต้อง qualify เป็น `public.show_trgm` — probe รอบแรกเรียกชื่อเปล่า
⇒ `migrate deploy` พังทุก connection ที่มี `?schema=` ด้วย **P3018 / function show_trgm
does not exist** (18 suites แดง) เป็นบั๊กคลาสเดียวกับ `gin_trgm_ops` ที่ migration นี้
เพิ่งแก้อยู่บรรทัดล่างลงไป — ผมทำซ้ำเองภายในไฟล์เดียวกัน ด่านจับได้
ถ้าผิด: เหมือน F5 แต่หนักกว่า — migration ล้มทั้งไฟล์แทนที่จะแค่เตือน

Ruling: EXPLAIN test ถาม**ทีละคอลัมน์** ไม่ใช่ predicate รวม และใช้ `enable_seqscan=off`
ใน `$transaction` (`SET LOCAL` นอก transaction เป็น no-op เงียบ — เจอตอนเขียน เทสดูเหมือน
force แล้วแต่ไม่ได้ force) เหตุผลที่ไม่ assert plan บน predicate รวม: ที่หมื่นแถวตาราง 56kB
planner เลือก **Seq Scan** และ**ถูกแล้ว** (cost 393) มันสลับไป BitmapOr ก่อนถึงแสนแถว
⇒ assert "plan มี Index Scan" ที่ขนาดของ DoD คือการตรึงขนาดตาราง ไม่ใช่ตรึงความถูกของ index
= flake ที่ ruling Q5 ตั้งใจเลี่ยง ลงมาอีกชั้นหนึ่ง. สิ่งที่ deterministic คือ "index นี้ตอบ
predicate นี้ได้ไหม" ซึ่ง `enable_seqscan=off` ตอบได้ทุกขนาดตาราง (มันไม่บังคับ index ที่ตอบ
ไม่ได้เข้ามาใน plan) RED พิสูจน์แล้ว: ปิด `workspace_chats_prompt_trgm` ⇒ แดงเฉพาะตัวนั้น
ถ้าผิด: เทส performance ที่แดงสลับเขียวตามขนาดตารางและ statistics

Ruling: เทส locale เทียบ **plan ธรรมชาติ ไม่ force** (ต่างจากเทส index อังกฤษ) —
`enable_seqscan=off` ทำให้ C database เลือก trgm index เหมือนกัน ทั้งที่ index นั้นไม่มี
trigram ไทยอยู่เลย ⇒ plan ที่ถูก force จะแสดงว่าสอง database เหมือนกันและกลบ finding
ต้องดูว่า planner **เลือก**อะไรเมื่อปล่อยอิสระ และต้องมีแถวพอ (20k) ให้การเลือกมีความหมาย
ถ้าผิด: เทสที่ยืนยัน F5 กลับแสดงว่าไม่มี F5

Ruling: fixture ของเทส edit ห้ามใช้คำที่เป็น substring ของกัน — รอบแรกใช้
`vertebrate` → `invertebrate-mollusc` ซึ่ง**มี** `vertebrate` อยู่ข้างใน ⇒ substring search
ที่ถูกต้องยัง match คำเก่า แล้วเทสรายงานว่ามีบั๊ก stale ทั้งที่ไม่มี เปลี่ยนเป็น
`zygomorphic` → `actinomorphic`
ถ้าผิด: ไล่บั๊กที่ไม่มีอยู่จริงในโค้ดที่ถูกอยู่แล้ว

## GREEN

`Test Suites: 156 passed, 156 total` / `Tests: 1626 passed, 1626 total`
`task.sh check --issue 61` → check ผ่านทุกด่าน (model imports / db push / locals contract clean)

Timing evidence (ruling Q5, วัดจริงไม่ใช่ assert): 20k แถวไทย, needle ที่ไม่มีในข้อมูล —
UTF-8 `Execution Time: 0.048 ms` (Bitmap Index Scan) · C locale `Execution Time: 3.812 ms`
(Seq Scan, Rows Removed by Filter: 20000) ต่างกัน ~79× ที่ 20k และช่องว่างกว้างขึ้นตามขนาด
(fresh DB `approofworkspace_v9`, migrate deploy + seed + prisma generate, node@22,
`API_KEY_PEPPER` 39 bytes — §7.1c)

## Out of scope

- cross-workspace search → V10
- ค้น chat ของผู้ใช้อื่น → V10 พร้อม leak tests
- ranking / stemming / synonyms — trigram ไม่มีให้ และ V9 ไม่ได้อ้างว่ามี
- frontend UI — slice แยก issue นี้ลง route + model + migration

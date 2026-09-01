# Plan: Phase 0 — Foundation (F1–F7)

Spec: `docs/superpowers/specs/approof-workspace-enterprise.md` @ `d798ee23`
สถานะ: **พร้อม dispatch** · ยังไม่เขียนโค้ดใด ๆ — เอกสารนี้คือแผนให้คน/ทีมรับไปทำต่อ
กติกา: หนึ่ง task = หนึ่ง GitHub issue (`task.sh start`) · ทำใน worktree แยก · ปิดงานด้วย `task.sh check` + `close` เท่านั้น

## ลำดับพึ่งพา (ใครบล็อกใคร)

```
P0-1 (F6 modular spec) ──┬─ บล็อกทุก task ที่เหลือ (ทุกคนเขียนตาม contract นี้)
P0-2 (F1 Postgres)      ─┤
                          ├─ P0-4 (F2 hardening) ── P0-5 (F3 authorization)
P0-3 (F4 test suite)    ─┘
P0-6 (F7 core services) — ต้องรอ P0-1 จบ
P0-7 (F5 de-brand)      — อิสระ ทำขนานได้ทันที
```

เดือน 1 ทีมเล็ก: คนออกแบบ 1-2 คนถือ P0-1 + P0-5 · อีก 1-2 คนถือ P0-2/P0-3/P0-7 ขนาน

---

## P0-1 — F6: Modular architecture contracts

**ทำอะไร**: เขียนเอกสาร interface contract ของ 8 seams + job queue + event bus + storage abstraction ลง `docs/superpowers/design/seams/` (ไฟล์ละ seam) แต่ละไฟล์ต้องมี: หน้าที่ของ seam, TypeScript/JSDoc interface จริงที่ driver ต้อง implement, ตัวอย่าง driver แรก, จุดที่ห้าม driver ทะลุ (เช่น connector ห้ามเขียน vector DB ตรง ต้องผ่าน pipeline)

**ขั้นตอน**
1. อ่าน spec section "Modular seams" + audit จุดที่โค้ดเดิม modular แล้ว (`server/utils/AiProviders/`, `EmbeddingEngines/`, `vectorDbProviders/`) เพื่อยึด convention เดิม
2. ร่าง interface ทีละ seam (1→8) + job queue + event bus + storage
3. วาด sequence diagram (mermaid ในไฟล์ md) ของ use case ตัวแทนอย่างน้อย 10 เรื่อง: SSO login, ถามแชทผ่าน redaction→guardrail→meter, Lark bot ถาม, connector sync + ACL map, doc search กรอง ACL, retention purge, license check, audit event, offboarding โอนของ, emergency hide
4. use case ไหนวาดไม่ผ่าน seam = แก้ contract จนผ่าน — ห้ามแก้ use case หนี

**DoD**
- [ ] ครบ 11 ไฟล์ (8 seams + queue + bus + storage) ใน `docs/superpowers/design/seams/`
- [ ] sequence diagram ≥10 use case ผ่านครบ ไม่มี use case ทะลุ seam
- [ ] ผ่าน design review (Opus) — reviewer ต้องลองหา use case ที่ 11 ที่ทะลุ ถ้าเจอ = กลับไปแก้
- [ ] evidence: `ls docs/superpowers/design/seams/*.md | wc -l` → `11`

**Model**: ออกแบบ = Opus review บังคับ (แตะ permission/schema)

---

## P0-2 — F1: Postgres migration

**ทำอะไร**: เปลี่ยน Prisma provider sqlite → postgresql, เขียน migration ใหม่ทั้งชุด, เพิ่ม postgres service ใน docker-compose, ย้าย dev workflow

**ขั้นตอน**
1. สำรวจ: `server/prisma/schema.prisma` (provider + type ที่ sqlite-specific), migration เดิมทั้งหมด, จุดที่โค้ด raw SQL (grep `queryRaw|$executeRaw`)
2. แก้ `datasource` เป็น postgresql + env `DATABASE_URL` · ไล่ type ที่ต้องเปลี่ยน (sqlite ไม่มี native enum/datetime แบบ pg)
3. ลบ migrations เดิม สร้าง init migration ใหม่จาก schema (fork ยาว ไม่ต้อง compat กับ sqlite เดิม — ยกเว้น: เขียนสคริปต์ import ข้อมูลจาก sqlite หนึ่งตัวสำหรับ dogfood/ลูกค้าที่ทดลองของเดิม)
4. docker-compose: เพิ่ม `postgres:16` service + healthcheck + volume · แก้ entrypoint รอ DB พร้อม
5. รัน test suite (จาก P0-3 ถ้าเสร็จแล้ว หรือ smoke test เดิมของ repo)

**DoD**
- [ ] `docker compose up` ขึ้นครบ app+postgres, `/api/ping` → 200
- [ ] `npx prisma migrate deploy` สะอาดบน DB เปล่า
- [ ] สคริปต์ import sqlite→pg รันผ่านกับ storage ตัวอย่าง (มี user+workspace+chat ครบหลังย้าย)
- [ ] ไม่มี raw SQL ที่เป็น sqlite dialect เหลือ (grep แล้วไล่ครบ)
- [ ] evidence: `docker compose exec anythingllm curl -s localhost:3001/api/ping` → `{"online":true}` บน postgres backend

---

## P0-3 — F4: Test suite + release pipeline

**ทำอะไร**: วาง regression suite ระดับ API (supertest หรือเทียบเท่า ครอบ endpoint สำคัญ: auth, workspace CRUD, chat, document upload, admin) + GitHub Actions: lint → test → build image → tag ตาม semver + channel stable/beta

**ขั้นตอน**
1. สำรวจของเดิม: repo มี test อะไรอยู่ (`yarn test`?), CI เดิมของ upstream ใช้อะไร
2. เลือก runner ตามของที่มีใน repo (อย่าเพิ่ม framework ใหม่ถ้า jest มีแล้ว)
3. เขียน API test ครอบ path หลัก ~30 เคสแรก: login ผิด/ถูก, role gate (default โดน 401 ที่ admin route), workspace isolation, upload→query, API key auth
4. Actions workflow: PR → lint+test · tag `v*` → build+push image + changelog
5. เอกสาร `docs/RELEASING.md`: วิธีตัด release, pin version, channel

**DoD**
- [ ] `yarn test` (หรือคำสั่งที่เลือก) เขียว ≥30 เคส และ**พิสูจน์ RED ได้** (สุ่ม 3 เคส ทำโค้ดพังชั่วคราวแล้วเทสต้องแดง)
- [ ] CI เขียวบน PR จริงหนึ่งอัน
- [ ] tag test เวอร์ชันหนึ่ง → image ออกพร้อม tag ตรง
- [ ] evidence: `gh run list --limit 1` → `completed success`

---

## P0-4 — F2: Security hardening (ต้องรอ P0-1 contract + ทำก่อน P0-5)

**ทำอะไร**: อุดช่องโหว่จาก audit — hash API keys, scoped keys, rate limit, IP allowlist, encrypt stored credentials, ปิด Simple SSO god-mode

**ขั้นตอน**
1. API keys: hash ตอนเก็บ (bcrypt/argon2), migration ล้าง plaintext · เพิ่มคอลัมน์ scope/workspace/expiry/last_used ตาม contract seam 8
2. `validApiKey` middleware: ตรวจ scope ต่อ route + ผูก identity ของ key ลง audit ทุก request
3. Rate limit: login (per-IP + per-account, lockout ชั่วคราว) + HTTP ทั่วไป (per-key/per-IP)
4. IP/CIDR allowlist ต่อ deployment (config + middleware, ปิด default)
5. Encrypt credentials ใน DB (LLM/connector secrets) ด้วย key จาก env
6. Simple SSO: จำกัด key ที่ออก temp token ได้ให้เป็น scope เฉพาะ ไม่ใช่ทุก key
7. ทุกข้อมี test ใน suite ของ P0-3

**DoD**
- [ ] ไม่มี API secret plaintext ใน DB (query ตรวจ) · key เดิมใช้ไม่ได้หลัง migration (บังคับ rotate — แจ้งใน release notes)
- [ ] key ที่ไม่มี scope โดน 403 บน route ที่ต้อง scope · test พิสูจน์
- [ ] login ผิด N ครั้ง → 429 · test พิสูจน์
- [ ] `security-review` (Opus) ผ่าน — reviewer ต้อง**ลองเจาะจริง** (replay key เดิม, ยิงข้าม scope, brute force) ไม่ใช่อ่านโค้ดอย่างเดียว
- [ ] evidence: test suite security block เขียวทั้งชุด

**Model**: Dev Sonnet · review **Opus + security-review บังคับ** (แตะ auth)

---

## P0-5 — F3: Authorization redesign (คอขวด — คน 1-2 คน + review หนักสุด)

**ทำอะไร**: permission engine จุดเดียว (seam 2) + custom roles + workspace roles (owner/editor/viewer) + document ACL ถึงชั้น vector query + ตัด admin/manager global bypass + แยก admin duties + admin privacy posture

**ขั้นตอน**
1. ออกแบบ schema: `roles`, `permissions`, `role_permissions`, `workspace_members(role)`, `document_acl` — เสนอผ่าน design review ก่อนเขียน migration
2. Permission engine: `can(user, action, resource)` จุดเดียว · route ทั้งหมดเรียกผ่านตัวนี้ — surface จริง — ตัวเลขปัจจุบันและคำสั่งที่ใช้นับอยู่ใน `phase0-gate-checklist.md` §2.2 ซึ่งเป็นแหล่งอ้างอิงเดียว (ตัวเลขที่เคยเขียนไว้ตรงนี้นับก่อน P0-3/P0-4 เพิ่มไฟล์ route และนับคนละหน่วย — invocation ไม่ใช่ไฟล์ — จึงอ่านขัดกัน) · **ถ้า engine slip ให้แตกงานนี้ตาม route group ห้ามอัดให้จบใน PR เดียว**
3. Workspace roles + migration จาก 3 role เดิม (mapping ที่ประกาศชัด: admin→super-admin, manager→workspace owner ของ workspace ที่ตัวเองสร้าง, default→member) — **ต้องเพิ่ม `workspaces.created_by` ก่อน** เพราะ schema ปัจจุบันไม่มีคอลัมน์นี้ (ruling R1)
4. Document ACL: ตาราง + enforcement ตอน list/read + **filter ใน vector query ทุก provider ที่ support** (LanceDB ก่อน — ตัว default) — ผลลัพธ์: user ไม่มีสิทธิ์เอกสาร → RAG ไม่ดึง chunk นั้นมาตอบเด็ดขาด
5. Admin duties + privacy posture: สิทธิ์ "อ่านแชท user" / "bulk export" เป็น permission แยกที่ปิดได้
6. "View as user" + document access diagnostics (หน้าที่ระบุใน spec)
7. **Frontend capability gates** — `frontend/src` ไม่ import `ROLES` เลย ใช้ literal `"admin"`/`"manager"`/`"default"` 105 ครั้งใน 36 ไฟล์ (`PrivateRoute/index.jsx:89` มี `|| !multiUserMode` แบบเดียวกับ bypass ฝั่ง server) — พวกนี้เป็น UI affordance ไม่ใช่ security boundary แต่จะ evaluate false ทั้งหมดพอ legacy role หาย = admin จริงมองไม่เห็น admin UI · **ต้อง ship พร้อม release เดียวกับข้อ 2**
8. เทสละเอียดสุดในบรรดา P0: matrix ทุก role × action สำคัญ + เทสพิสูจน์ vector query ไม่รั่ว (สร้าง 2 user, เอกสาร ACL แยก, ถามคำถามที่ตอบได้จากเอกสารอีกคนเท่านั้น → ต้องตอบไม่ได้)

**DoD**
- [ ] design review (Opus) ผ่านก่อน migration ถูกเขียน
- [ ] ไม่มี route ที่เช็ค role ตรง ๆ เหลือ (grep `ROLES.` นอก engine = 0) **และ** literal grep `grep -rnE 'role (===|!==) "(admin|manager|default)"' server/` = 0 — จับ `endpoints/invite.js:55` กับ `utils/chats/commands/img.js:55` ที่ไม่ได้ import `ROLES` เลย `ROLES.` grep อย่างเดียวจึงมองไม่เห็น
- [ ] เทส vector-leak ผ่าน (ข้อ 8) — นี่คือเทสที่สำคัญที่สุดของทั้ง Phase 0
- [ ] `security-review` (Opus) ลองเจาะ: privilege escalation, IDOR ข้าม workspace, ACL bypass ผ่าน API เก่า
- [ ] evidence: เทส authorization matrix + vector-leak เขียวทั้งชุด

**Recon + task split**: `docs/superpowers/design/p0-5-authorization-recon.md` — audit finding, schema proposal, แตกเป็น 8 issue พร้อม merge order, security tests 20 เคส

**Model**: Dev Sonnet · design + review **Opus บังคับ**

---

## P0-6 — F7: Core services (job queue + event bus) — รอ contract จาก P0-1

**ทำอะไร**: job queue + scheduler (ตาม contract) และ event bus ที่ audit เป็น subscriber แรก

**ขั้นตอน**
1. เลือกกลไก queue ตาม stack เดิม (Node + Postgres มีแล้ว → pg-boss หรือเทียบเท่า อย่าเพิ่ม Redis ถ้าไม่จำเป็น — ตัดสินใจใน design doc สั้น 1 หน้า)
2. Queue API ตาม contract: enqueue/schedule/retry/dead-letter + หน้าตา admin ดู job ค้าง
3. Event bus: `emit(event, payload)` → subscriber ลงทะเบียน · ย้าย audit logging จาก call-site เดิม (`EventLogs.logEvent` กระจาย) มาเป็น subscriber ของ bus
4. งานแรกที่ย้ายขึ้น queue: telemetry flush + เตรียมช่องให้ retention purge (S6) มาเสียบ

**DoD**
- [ ] job enqueue → รัน → retry เมื่อพัง → dead-letter เมื่อเกิน limit — มีเทสครบ 4 สถานะ
- [ ] audit event ผ่าน bus แล้ว record ลง `event_logs` เหมือนเดิม (เทสเทียบ before/after)
- [ ] ไม่มี call-site ไหนเขียน `event_logs` ตรงอีก (grep = เฉพาะ subscriber)
- [ ] evidence: เทส queue + bus เขียว

---

## P0-7 — F5: De-brand (อิสระ ทำขนานได้เลย)

**ทำอะไร**: strip ชื่อ/โลโก้/ลิงก์ AnythingLLM + PostHog telemetry ออก + audit third-party licenses

**ขั้นตอน**
1. Inventory: grep `AnythingLLM|anythingllm|Mintplex|useanything|posthog` ทั้ง repo — ทำรายการไฟล์+ประเภท (UI string / asset / telemetry / ลิงก์ docs)
2. แทน UI strings ด้วยค่าจาก branding config (ของเดิมมีระบบ custom app name อยู่แล้ว — เปลี่ยน default เป็น "ApproofWorkspace")
3. ถอด PostHog ออกทั้ง dependency (ไม่ใช่แค่ DISABLE flag — spec ต้องการ air-gap จริง)
4. เปลี่ยน asset (logo/favicon default)
5. License audit: สคริปต์ไล่ license ของ dependency ทั้งหมด → รายงาน `docs/superpowers/design/license-audit.md` — ธง GPL/unknown ให้คนตัดสิน

**DoD**
- [ ] grep แบรนด์เดิมใน UI-facing strings = 0 (ยกเว้น LICENSE/ATTRIBUTION ที่ต้องคงตามกฎหมาย — MIT ต้องเก็บ copyright notice เดิมไว้ในไฟล์ LICENSE)
- [ ] `posthog-node` หายจาก package.json + ไม่มี outbound call ตอนรัน (ดักด้วย network log ตอน smoke test)
- [ ] license-audit.md มีผลครบทุก dependency พร้อมธง
- [ ] evidence: grep + network log สะอาด

---

## หลังจบ Phase 0

1. Gate review: ทุก task ปิด issue ครบ (อ่านกลับผ่าน) + เทสรวมเขียว
2. Dogfood เริ่มทันที — deploy ให้ทีมตัวเองใช้
3. แผนถัดไป: เขียน plan Track S / Track V wave 1 / Ops แยกไฟล์ตอน fan-out (อย่าเขียนตอนนี้ — รายละเอียดจะเปลี่ยนตาม contract ที่ P0-1 ตกผลึก)

## Ruling ที่ฝังในแผนนี้ (ให้คนอ่านเห็น ไม่ใช่ตัดสินลับ)

- `Ruling:` แตก Phase 0 เป็น 7 task ตาม F1-F7 ตรง ๆ — เพราะแต่ละตัวปิด issue แยกได้จริง — ถ้าผิด: task ใหญ่ไป แตกย่อยเพิ่มตอน dispatch ได้โดยไม่แก้โครง
- `Ruling:` ไม่เขียน plan Track S/V ตอนนี้ — เพราะรายละเอียด driver ขึ้นกับ contract P0-1 ที่ยังไม่ตกผลึก เขียนก่อน = เขียนสองรอบ — ถ้าผิด: เสียเวลา fan-out ช้าไป ~2-3 วันตอนต้นเดือน 2
- `Ruling:` P0-2 ไม่ทำ dual-support sqlite+pg — เพราะ fork ยาวและ spec ล็อก Postgres แล้ว dual-support คือหนี้ — ถ้าผิด: ลูกค้าเก่าที่อยาก sqlite ไม่มี (แต่ไม่มีลูกค้าเก่า)
- `Ruling:` บังคับ rotate API key ทั้งหมดใน P0-4 — เพราะ plaintext เดิม hash ย้อนไม่ได้ — ถ้าผิด: integration เดิมพัง (ยอมรับได้ ยังไม่มีลูกค้า)

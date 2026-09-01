# ApproofWorkspace — Enterprise Local AI Workspace

Spec วันที่ 2026-09-01 · สถานะ: **รออนุมัติ**
ฐาน: fork AnythingLLM (repo นี้, แยก branch, ไม่ตาม upstream) · อ้างอิง audit โค้ดจริง + market research (Onyx/OpenWebUI/LibreChat)

## เป้าหมาย

ขาย local AI system ให้บริษัทไทย ใช้เป็น AI workspace ขององค์กร
ลูกค้า: SME ไทย 20-200 คน + regulated (ธนาคาร/รพ./ราชการ)
Timeline: **~7 เดือน** (ขยายจาก 3-6 เดือนตามคำสั่ง 2026-09-01 เพื่อรับ Track V wave 2 เต็ม ๆ ไม่เบียดของเดิม) · ทีมใหญ่ · ยังไม่มีลูกค้ากดดัน — สร้าง product ให้ครบก่อนขาย
Pricing: **per-seat** (license enforcement นับ active user)

## Decision ที่ล็อกแล้ว

| เรื่อง | ตัดสินใจ | เหตุผล / ราคาถ้าย้อน |
|---|---|---|
| DB | **Postgres ตั้งแต่ต้น fork** | SQLite ไม่รอด 200 users + audit ทุก action; ย้ายทีหลัง = rewrite migrations ทั้งหมดอีกรอบ |
| Fork | ยาว ไม่ rebase upstream | อิสระเต็มที่ แลกกับต้องมี test suite + release pipeline เอง |
| RBAC | ลึกถึง **document ACL** รวมชั้น vector retrieval | จุดที่ OpenWebUI/LibreChat ไม่มี — differentiator จริง; ต้องออกแบบก่อนทุก feature |
| PDPA | **pattern-based redaction** ก่อน (บัตร ปชช. 13 หลัก, เบอร์, อีเมล, เลขบัญชี) — NER ไทยเป็น phase หลัง | เร็ว ครอบ ~80%; จับชื่อคนไม่ได้ ยอมรับแล้ว |
| LLM | hybrid local (Ollama/vLLM) + cloud API พร้อม **policy ต่อ workspace** (local-only / cloud-allowed) | งานลับบังคับ local ได้ |
| Branding | โลโก้/ชื่อ ลูกค้า per-deployment (ของเดิมมีแล้ว ต่อยอด) + **strip แบรนด์ AnythingLLM ออกหมด** (MIT ให้โค้ด ไม่ให้ trademark) | |
| SSO | Generic **OIDC ก่อน** (ครอบ Google/Entra/Lark ในตัวเดียว) → SAML → LDAP; **Lark org sync** (user/แผนก → workspace/role) | SCIM เลื่อนไป phase หลัง |
| โครงงาน | 2 track ขนาน: **Track S** (security/identity/governance) + **Track V** (product value) + Ops แทรก | ทีมใหญ่พอ |

## สิ่งที่มีอยู่แล้วในโค้ด (จาก audit — ไม่ต้องสร้างใหม่)

- Branding instance-level ครบ: ชื่อ/โลโก้/favicon/footer (`server/endpoints/system.js:761-1030`, `admin.js:352-488`)
- `event_logs` + coverage หลาย action + admin viewer (`server/models/eventLogs.js`, `system.js:1138-1174`)
- Workspace isolation สำหรับ role `default` (`workspace_users`, `validWorkspace.js`)
- Chat export หลาย format + admin browse (`system.js:1177-1247`)
- `dailyMessageLimit` ต่อ user + embed quotas
- Invite flow, JWT auth, bcrypt, password complexity
- i18n framework (คุณภาพ th ต้องตรวจ)

## ช่องโหว่ security ที่ต้องอุดก่อนทุกอย่าง (จาก audit)

- API key = god-mode: เข้าได้ทุก route, export chat ทั้งระบบ, ออก login token เป็นใครก็ได้ (Simple SSO), **secret เก็บ plaintext** (`server/models/apiKeys.js:16-21`)
- ไม่มี rate limit login/HTTP ใด ๆ — brute force ได้
- Audit log ลบทั้งก้อนได้ + บาง record ไม่มี actor identity (API key ไม่ผูกตัวตน)
- admin/manager bypass ทุก workspace (`server/models/workspace.js:297-315`)

---

## หลักการ architecture: Modular seams ("ปลั๊ก + เต้ารับ")

ความกลัวหลักของ program นี้คือ core ไม่ครบแล้วต้องรื้อซ่อม — กันด้วยการตีเส้น interface (seam) ให้ครบก่อน fan-out ทุกการเชื่อมต่อใหม่ในอนาคต = เขียน driver ใหม่ตัวเดียว ไม่ผ่า core

ของเดิมเป็น modular แล้วครึ่งเดียว: LLM providers (~30), embedders, vector DBs เสียบได้ (`server/utils/AiProviders/`, `EmbeddingEngines/`, `vectorDbProviders/`) — ที่เหลือฝังในโค้ด ต้องตีเส้นใหม่:

| # | Seam | Driver แรกที่เสียบ |
|---|---|---|
| 1 | Identity provider | OIDC → SAML → LDAP → Lark (S1-S4) |
| 2 | Authorization engine — permission check จุดเดียว | custom roles + document ACL (F3) |
| 3 | Chat pipeline middleware chain | redaction (S6) → guardrails (S8) → metering (S10) |
| 4 | Connector SDK (auth + sync + ACL mapping ต่อ driver) | Google Drive, Lark Docs (V3) |
| 5 | Channel interface — ทุกช่องทางใช้ chat pipeline เดียวกัน | web, Lark bot (V2), embed widget (V7) |
| 6 | Notification channel | email/SMTP (S11) → Lark → webhook |
| 7 | Vector DB interface + **ACL filter ใน contract** | ต่อยอด interface เดิม |
| 8 | License/entitlement — feature gate จุดเดียว | per-seat (O1) |

บวก core services กลาง 2 ตัวที่ทุก track ใช้ร่วม (ห้ามให้แต่ละ track ประดิษฐ์เอง):
- **Background job queue + scheduler** — connector sync, retention purge, re-embed, backup, license check
- **Internal event bus** — ทุก action ยิง event → audit log เป็น subscriber (แก้จุดอ่อน call-site scattered ที่ audit เจอ) → อนาคตเปิด webhook ให้ลูกค้าต่อ SIEM ได้ฟรี
- **Storage abstraction** (เส้นบาง ๆ): local disk วันนี้ → S3-compatible/MinIO ได้โดยไม่รื้อ

**เกณฑ์ปิดว่า core ครบ**: F6 review วาด sequence diagram ของทุก use case ใน spec ผ่าน 8 seams ได้หมด — use case ไหนทะลุไม่ได้ = เจอของขาดตรงนั้นแบบมีหลักฐาน ไม่ใช่ความรู้สึก

## Phase 0 — Foundation (~เดือน 1, ทีมเล็ก, ห้ามรุม)

ทุกอย่างหลังจากนี้สร้างบนฐานนี้ — งานออกแบบต้องผ่าน `codebase-design` + `security-review` (Opus)

- **F1. Postgres migration**: Prisma provider + เขียน migrations ใหม่ + docker-compose เพิ่ม postgres service
- **F2. Security hardening**: hash API keys · scoped API keys (workspace/permission/**scope + expiry 7/30/365/never**/last-used, ผูก identity ลง audit) · login + HTTP rate limit · ปิดช่อง Simple SSO god-mode · **inbound IP/CIDR allowlist** ต่อ deployment (regulated network zoning) · กัน service-account escalation trap (คนสร้าง key ห้าม assign สิทธิ์เกินตัวเอง) · **encrypt credentials ที่เก็บ** (LLM/connector/API secrets เข้ารหัสด้วย `ENCRYPTION_KEY_SECRET`-style ไม่ใช่ plaintext ใน DB — procurement ถามเรื่อง encryption at rest แน่)
- **F3. Authorization redesign** (คอขวดหลัก — คน 1-2 คน + review หนัก): permission matrix · custom roles · workspace-local roles (owner/editor/viewer) · **document ACL schema ที่ filter ได้ถึงชั้น vector query** · ตัด admin/manager global bypass ให้เป็นสิทธิ์ที่ grant ได้ · **แยก admin duties** (setup admin / super admin / sensitive-content moderator — แบบ Glean) · **feature toggle ต่อ group** (ปิด web search/agent/upload/export/API key รายกลุ่ม — แบบ OpenWebUI) · **admin privacy posture**: ค่า config ว่า admin อ่านแชท user ได้ไหม + คุม bulk export (regulated ถามแน่) · **"view as user"** ให้ admin ตรวจว่า user เห็นอะไร · **document access diagnostics**: หน้า lookup ต่อเอกสาร — index เมื่อไหร่ ใครเห็นได้ ทำไม (ตอบ ticket "ทำไมหาไฟล์ไม่เจอ/ทำไมคนนี้เห็น" โดยไม่ต้องไล่ DB)
- **F4. Test suite + release pipeline**: fork ยาว = QA upstream หาย; ต้องมี regression suite ก่อน fan-out · **release cadence + version pinning** (ลูกค้า pin เวอร์ชัน, stable/beta channel — แบบ Onyx)
- **F5. De-brand**: strip ชื่อ/โลโก้/telemetry (PostHog) AnythingLLM + audit third-party licenses
- **F6. Modular architecture spec** (ทำก่อน fan-out เดือน 2 — บล็อกทุก track): interface contract ของ 8 seams + job queue + event bus + storage abstraction · ผ่านเกณฑ์ sequence-diagram review ข้างบน · ทุก track เขียนตาม contract นี้เท่านั้น
- **F7. Core services**: job queue + scheduler · event bus (audit เป็น subscriber แรก)

## Track S — Security / Identity / Governance (เดือน 2-5)

- **S1. OIDC generic** (Google/Entra/Lark) → **S2. SAML** → **S3. LDAP/AD** — ทุกตัวมี **จำกัด email domain ที่ login ได้** + กันปิด SSO ตัวสุดท้ายจนล็อกตัวเองออก (แบบ Onyx)
- **S4. Lark org sync**: user/แผนก → workspace/role mapping อัตโนมัติ
- **S5. Audit ครบ**: export CSV/SIEM sink · retention policy · กันลบ (append-only) · actor identity ครบทุก record · **รูปแบบ structured JSON stream (OCSF-shaped) + secret scrub** ship ผ่าน stdout/Fluent Bit ได้ (แบบ Onyx) · **compliance feed ระดับเนื้อหาแชท** (eDiscovery/legal investigation — key แยกสิทธิ์จาก audit ปกติ)
- **S6. Data governance**: retention อัตโนมัติ (chat/doc/log) · **PDPA pattern-based redaction** ก่อนส่ง LLM (บังคับได้ต่อ workspace โดยเฉพาะ cloud route) · data-subject export/delete · **consent/AI-policy modal** บังคับกดยอมรับครั้งแรก + ทวนเมื่อ policy เปลี่ยน (PDPA + audit-friendly) · **DLP scan corpus ที่ index แล้ว** (schedule scan หา PII/ความลับในเอกสาร + findings dashboard ให้ moderator จัดการ ซ่อน/ลบ — แบบ Glean; phase หลังของ track ได้) · **emergency content hide**: admin ซ่อนเอกสาร/ทั้ง connector ออกจาก search+RAG ทันทีโดยไม่ต้องลบ (breach containment — เอกสารหลุดผิด workspace ต้องกดปิดได้ใน 1 นาที ไม่ใช่รอลบ re-index) · **temporary chat mode**: แชทที่ไม่บันทึกประวัติ (เลือกเองต่อแชท + admin บังคับทั้ง workspace ได้ — งานลับ/HR/กฎหมาย ใช้แล้วไม่ทิ้งร่องรอยใน retention)
- **S7. LLM policy ต่อ workspace**: local-only / cloud-allowed / model allowlist · **model catalog admin**: enable/disable/ซ่อน model ทั้งระบบ + **จำกัด model ต่อ group** (แผนกไหนใช้ model ไหน — แบบ Onyx/OpenWebUI)
- **S8. Guardrails**: ตอบเฉพาะจากเอกสาร · content filter · disclaimer ต่อ workspace · prompt-injection hardening ของ agent tools · **runtime policy ต่อ agent tool**: Block/Ask/Allow ต่อ action ต่อ group, strictest wins (แบบ Onyx Craft/Glean) · **web-search governance แยกจาก LLM policy**: เปิด/ปิดต่อ workspace/role (query ที่วิ่งออก internet = egress ที่ regulated ต้องคุม)
- **S9. Air-gap switch**: ตัด outbound ทั้งหมด (CDN/GitHub/telemetry) ใน config เดียว
- **S10. Usage analytics dashboard**: token/cost/adoption ต่อ user/workspace (ฐานข้อมูลจาก F2 scoped keys + metering) · **token budget enforcement**: เพดาน global/group/user + throttle เมื่อชน + alert ใกล้ชน (ทุกคู่แข่ง enterprise มี — ไม่ใช่แค่ดู ต้องบังคับได้) · breakdown ต่อ model
- **S11. SMTP/mailer**: invite ทางเมล · reset password · แจ้งเตือน admin (license ใกล้หมด, backup fail) — ของเดิมไม่มี mailer เลย invite เป็นลิงก์ copy มือ
- **S12. User lifecycle/offboarding**: deactivate → โอน chat history + เอกสารที่ user นั้น upload ให้ owner ใหม่ · Lark sync (S4) ต้อง handle ทั้ง onboard และ offboard (ลาออกจาก Lark org = deactivate อัตโนมัติ)
- **S13. MFA + session management**: TOTP สำหรับ local account (SSO ได้ MFA จาก IdP อยู่แล้ว แต่ admin ฉุกเฉิน/local ต้องมี) · admin ดู/บังคับ logout ทุก device · session expiry ตาม policy องค์กร · **OIDC backchannel logout** (IdP logout = app logout ด้วย) + **จำกัด concurrent session ต่อ user**

## Track V — Product Value (เดือน 2-5)

- **V1. ภาษาไทยครบวงจร**: ตรวจ/เก็บ UI th · Thai embedding model ที่ retrieval พิสูจน์แล้ว (eval set ไทย) · OCR เอกสารสแกนไทยใน collector
- **V2. Lark bot**: ถาม AI ผ่านแชท Lark ผูก workspace + สิทธิ์ตาม S4
- **V3. Connectors**: Google Drive + Lark Docs sync อัตโนมัติ (ต่อยอด liveSync experimental) — สิทธิ์เอกสารเข้ากรอบ document ACL ของ F3 · **admin เลือก scope แหล่งข้อมูล + จำกัดว่า group ไหนใช้ connector ไหน** · **connector health UI**: สถานะ index/จำนวน doc/pause/resume/full reindex + **แจ้งเตือนเมื่อ sync พังจนกว่าจะแก้** (แบบ Onyx/Glean — connector เงียบ ๆ ตาย = ข้อมูลเก่าโดยไม่มีใครรู้) · **document sets**: จัดกลุ่ม connector หลายแหล่งเป็นชุด ใช้เป็น scope ของ agent/สิทธิ์ได้
- **V4. Assistant templates**: admin สร้างผู้ช่วยสำเร็จรูป (prompt+เอกสาร+model+guardrails) แจกทีม · **sharing/governance**: สิทธิ์ต่อ assistant (ใช้/ดู config/แก้) แชร์ให้ user/group/ทั้งองค์กร · **ใครสร้างได้คุมด้วย permission** (ไม่ใช่ admin อย่างเดียว) · **version history + rollback** · **โอน ownership เมื่อเจ้าของลาออก** (ผูก S12) · **library/discovery**: หน้ารวม assistant ค้นหา + badge "ทางการ"
- **V5. Answer quality**: citation ชัด · feedback loop · eval harness ต่อ deployment (ใช้พิสูจน์คุณภาพก่อนส่งมอบ + POC)
- **V6. Collaboration**: แชร์บทสนทนาให้เพื่อนร่วมทีม/workspace (link ภายใน, สิทธิ์ตาม ACL ของ F3)
- **V7. Embed widget**: ของเดิมมีอยู่แล้ว (embed quotas ใน schema) — เก็บไว้เป็นของขายเพิ่ม: ลูกค้าฝัง AI ตอบลูกค้าของเขาบนเว็บตัวเอง · ต้อง harden ให้เข้ากรอบ scoped keys (F2) + guardrails (S8)
- **V8. Mobile**: เว็บ responsive ตรวจ/เก็บให้ใช้บนมือถือได้จริง · **Lark bot (V2) คือคำตอบ mobile หลัก** — ไม่ทำ native app
- **V9. Chat history search**: ค้นหาในประวัติแชทของตัวเอง (ใช้ 3 เดือนมีแชทร้อยอัน หาไม่เจอ = pain อันดับต้น)
- **V10. Org-wide document search**: ช่องค้นหาเอกสารแบบ Google — พิมพ์คำค้น เจอรายการไฟล์+ตำแหน่งในเอกสาร ข้ามทุก workspace ที่ user มีสิทธิ์ ผลกรองตาม ACL (F3) เสมอ · ไม่ต้องผ่านแชท · จุดขายหลักของ Onyx/Glean — differentiator เทียบ OpenWebUI/LibreChat ที่ไม่มี · **filters**: ช่วงวันที่/ผู้เขียน/แหล่ง/tag · โหมด Auto สลับ chat↔search ตาม intent (แบบ Onyx)
- **V11. RAG tuning admin**: หน้าจอ admin ปรับ chunk size/overlap, top-K, hybrid BM25+rerank, embedding concurrency · **reindex ทั้ง KB จาก UI** เมื่อเปลี่ยน embedding model (ผูก O4 re-embed workflow) — จำเป็นกับ V1 เพราะจูนภาษาไทยต้องหมุนค่าพวกนี้บ่อย

### Track V — wave 2 (เริ่มเดือน 4-5, จบก่อน integration)

- **V12. Image generation**: สร้างรูปในแชท ผ่าน seam 3/5 · route local หรือ cloud ตาม S7 policy · ต้องคิด GPU budget แยกจาก LLM (VRAM ของ image model)
- **V13. Knowledge curation**: Answers (คำตอบทางการที่ moderator อนุมัติ) · Collections (จัดชุดเอกสารข้ามแหล่ง) · Pins (ปักผลค้นหา) — ซ้อนบน V10 + ACL ของ F3
- **V14. Deep research**: วนคิด-ค้น-สรุปหลายรอบสำหรับคำถามหนัก · กิน token >10 เท่า → **เปิดใช้ได้ต่อเมื่อ S10 token budget + O6 GPU queue เสร็จแล้วเท่านั้น** · admin ปิดได้ต่อ workspace
- **V15. Code interpreter / sandbox agent**: รัน Python วิเคราะห์ไฟล์/คำนวณ/สร้างไฟล์ผลลัพธ์ใน **sandbox แยกขาด** (container แยก, ไม่มี egress, จำกัด CPU/RAM/เวลา) · อยู่ใต้ runtime policy S8 (Block/Ask/Allow ต่อ group) · **ปิดเป็น default — admin เปิดเอง** · **บังคับ security-review (Opus) แยกหนึ่งรอบ + อยู่ใน scope pen-test เดือน 5-6** — attack surface ใหญ่สุดของระบบ

## Ops (แทรกเดือน 3-5)

- **O1. License per-seat**: license key + นับ active user + หมดอายุ/ต่อสัญญา + ทำงาน offline ได้ (air-gap)
- **O2. Installer/setup wizard**: ติดตั้ง + config หลักผ่าน UI ไม่ใช่ .env 20 ค่า
- **O3. Backup/restore ในตัว**: DB + vector + documents, พิสูจน์ restore ได้จริง (นี่คือคำตอบ HA ระดับแรก: active-passive + restore ที่ tested)
- **O4. Model lifecycle tooling**: GPU sizing guide · model update ผ่าน bundle (air-gap ได้) · re-embed workflow เมื่อเปลี่ยน embedding model
- **O6. GPU concurrency/queueing**: request queue เมื่อ concurrent เกิน capacity · UI แสดง "รอคิว" ไม่ใช่ timeout เงียบ · sizing guide กี่ concurrent ต่อ GPU (ผูกกับ O4) — กระทบ POC ตรง ๆ ถ้าช้าคือขายไม่ได้
- **O5. Diagnostic bundle**: export log/metrics ให้ support โดยไม่ remote เข้าเครื่อง · **Prometheus-compatible metrics endpoint** ให้ IT ลูกค้าต่อ Grafana เองได้ (enterprise มีระบบ monitoring อยู่แล้ว อยากเสียบของเขา)
- *(Fleet monitoring หลายลูกค้า — เลื่อนไปหลังมีลูกค้า >5 เจ้า)*

## เดือน 6-7 — Integration & Hardening (กันเวลาไว้จริง ห้ามให้ feature กิน)

- Integration ทุก track · **security review รวม (Opus) + จ้าง pen-test ภายนอก** (ต้องหลัง hardening, scope รวม V15 sandbox) · POC playbook + demo dataset ไทย · เอกสาร admin/user ไทย

## นอก scope รอบนี้ (จดไว้ ไม่ทำ)

SCIM · NER ไทย · fleet monitoring · multi-tenant SaaS (ขาย per-deployment แก้ปัญหานี้แทน) · SharePoint/Confluence connectors · Teams bot · **native mobile app** (Lark bot + responsive web แทน) · HA clustering จริง · DPA template/เอกสาร legal (งาน non-dev แยกไป)

จาก teardown — เห็นแล้ว ตัดสินใจไม่ทำรอบนี้: voice mode · browser extension · people/expertise search · arena/Elo model eval · impact surveys · BYOK/external KMS (ข้อมูลอยู่เครื่องลูกค้าอยู่แล้ว — ใช้ disk encryption + encrypt stored credentials ใน F2 พอ) · compliance content feed แบบ pull-API เต็มรูป (S5 มี eDiscovery access ระดับพื้นฐานแล้ว)

*(ย้ายกลับเข้า scope เป็น Track V wave 2 ตามคำสั่ง 2026-09-01: image generation → V12, knowledge curation → V13, deep research → V14, code interpreter/sandbox → V15)*

## กันโครงรื้อ — activity จับของหลุดที่เหลือ (ทำต้นเดือน 2 ก่อน fan-out)

1. **Competitor teardown**: เปิด Onyx + OpenWebUI จริง ไล่ทุกหน้าจอเทียบกับ spec นี้ — ของหลุดที่เจอเข้าเป็น task ใน track ที่มีอยู่ ไม่เปิด phase ใหม่
2. **Dogfood POC**: ใช้บริษัทตัวเองเป็นลูกค้าเจ้าแรกตั้งแต่จบ Phase 0 — ของหลุดจากการใช้จริงเจอเร็วกว่านั่งนึก
ทั้งสองอย่างส่งผลเป็น backlog item เพิ่มใน track เดิมเท่านั้น — โครง Phase 0 → S/V/Ops → hardening **ไม่เปลี่ยน**

## เกณฑ์วัดความสำเร็จของ program

1. Deployment demo ครบ loop: ติดตั้งผ่าน wizard → SSO login → สร้าง workspace + ACL → upload เอกสารไทย → ถามผ่านเว็บ+Lark bot → audit log export ครบทุก action ข้างต้น
2. Security: pen-test ภายนอกไม่พบ critical/high ค้าง
3. per-seat license enforce ได้จริงใน air-gap
4. Eval ไทย: retrieval quality ผ่าน threshold ที่ตั้งใน V5

# Program Backlog — ApproofWorkspace (เดือน 2–7)

Spec: `docs/superpowers/specs/approof-workspace-enterprise.md` @ `d798ee23`
คู่กับ: `phase0-foundation.md` (เดือน 1 — plan ละเอียดแล้ว)

สถานะไฟล์นี้: **backlog พร้อมยกไปเขียน plan ละเอียดตอน fan-out** — ทุก item มี scope / dependency / DoD ระดับผลลัพธ์ / ประมาณแรง (คน-สัปดาห์, cw) ช่องที่เว้นคือรายละเอียด interface ที่ต้องอ้าง contract จาก P0-1 ซึ่งจะเติมตอนเปิด issue จริง (หนึ่ง item อาจแตกเป็นหลาย issue)

กติกาเดิม: ทุก issue เปิดด้วย `task.sh start` + evidence contract · งานมี UI ต้องมี mockup อนุมัติก่อน (ขั้น 1.5) · แตะ auth/permission/schema → security-review Opus

---

## Track S — Security · Identity · Governance (เดือน 2–6)

| ID | งาน | ขึ้นกับ | ~แรง | DoD ระดับผลลัพธ์ |
|---|---|---|---|---|
| S1 | OIDC generic (Google/Entra/Lark) — driver แรกของ seam 1 · จำกัด email domain · กัน lockout | P0-1, P0-4 | 3 cw | login ผ่าน Google+Entra จริงได้, ปิด password login ได้เมื่อมี SSO, เทส domain-restrict ผ่าน |
| S2 | SAML | S1 | 2 cw | login ผ่าน Entra SAML ได้, metadata upload จาก UI |
| S3 | LDAP/AD on-prem | S1 | 2 cw | bind + login กับ AD ทดสอบได้, TLS + cert validation |
| S4 | Lark org sync — user/แผนก → workspace/role + onboard/offboard อัตโนมัติ | S1, P0-5 | 3 cw | สร้าง/ปิด user ตาม Lark org จริง, แผนก map เป็น workspace, ลาออกจาก org = deactivate |
| S5 | Audit ครบ — append-only, JSON stream (OCSF-shaped) + secret scrub, export CSV/SIEM, retention, eDiscovery key แยกสิทธิ์ | P0-6 (bus) | 3 cw | ลบ log ไม่ได้จาก UI/API ปกติ, ship ผ่าน stdout ได้, export ผ่านเทส, ทุก event มี actor |
| S6 | Data governance — retention อัตโนมัติ, PDPA pattern redaction (บัตรปชช./เบอร์/อีเมล/บัญชี), consent modal, data-subject export/delete, DLP corpus scan + findings dashboard, emergency hide, temporary chat | P0-5, P0-6 | 6 cw (แตก ≥5 issues) | redaction จับ pattern ไทยครบ (เทส corpus), retention purge รันตาม schedule, hide มีผล <1 นาที, consent บล็อกจนกดยอมรับ |
| S7 | LLM policy ต่อ workspace + model catalog — local-only/cloud-allowed, allowlist, จำกัด model ต่อ group | P0-5 | 2 cw | workspace ล็อก local-only แล้วยิง cloud ไม่ได้ (เทสพิสูจน์), group เห็นเฉพาะ model ที่ได้สิทธิ์ |
| S8 | Guardrails + agent runtime policy — ตอบเฉพาะเอกสาร, content filter, Block/Ask/Allow ต่อ tool ต่อ group, web-search governance แยก | S7 | 4 cw | policy Deny ชนะทุกกรณี (เทส), ปิด web search ต่อ workspace ได้, prompt-injection test set ผ่าน |
| S9 | Air-gap switch — ตัด outbound ทั้งหมดใน config เดียว | P0-7 | 1 cw | เปิด switch แล้ว network log = 0 outbound (พิสูจน์ด้วย packet capture ใน CI) |
| S10 | Analytics + token budget — dashboard ต่อ user/workspace/model + เพดาน global/group/user + throttle + alert | P0-6, S11 | 4 cw | ชน budget แล้วโดน throttle จริง (เทส), dashboard ตรงกับ metering |
| S11 | SMTP/mailer — driver แรก seam 6: invite, reset password, admin alerts | P0-1 | 2 cw | invite ทางเมลครบ loop, reset ใช้ได้, alert license/backup ยิงถึง |
| S12 | Offboarding — deactivate + โอน chat/เอกสาร + Lark auto | S4, P0-5 | 2 cw | โอน ownership แล้วของไม่หาย, audit บันทึกการโอน |
| S13 | MFA + session — TOTP local account, force logout, session expiry, backchannel logout, จำกัด concurrent | S1 | 3 cw | TOTP บังคับได้ต่อ role, admin เตะ session ได้, IdP logout สะท้อนใน app |

รวม Track S ≈ **37 cw**

## Track V — Product Value wave 1 (เดือน 2–6)

| ID | งาน | ขึ้นกับ | ~แรง | DoD ระดับผลลัพธ์ |
|---|---|---|---|---|
| V1 | ภาษาไทยครบวงจร — UI th, Thai embedding + eval, OCR สแกนไทย | P0-2 | 5 cw (แตก ≥3) | UI th ครบทุกหน้า, retrieval ไทยผ่าน threshold บน eval set, PDF สแกนราชการอ่านออก |
| V2 | Lark bot — ถามผ่านแชท ผูกสิทธิ์ตาม S4 | S4, P0-1 seam 5 | 3 cw | ถามในกลุ่ม/DM ได้คำตอบพร้อม citation, สิทธิ์เอกสารตาม user จริง |
| V3 | Connectors Google Drive + Lark Docs — SDK seam 4, ACL mapping, health UI, แจ้งพัง, document sets | P0-1, P0-5, P0-6 | 6 cw (แตก ≥4) | sync จริงสองแหล่ง, สิทธิ์ต้นทางสะท้อนใน ACL, ตัด connector แล้ว alert จนแก้ |
| V4 | Assistant templates + governance — สร้าง/แชร์/สิทธิ์/version/โอน owner/library | P0-5 | 4 cw | user สร้างได้ตาม permission, rollback version ได้, owner ลาออกแล้วโอนอัตโนมัติ |
| V5 | Answer quality — citation ชัด, feedback, eval harness ต่อ deployment | V1 | 3 cw | ทุกคำตอบ RAG มี citation คลิกได้, harness รันซ้ำได้ให้คะแนน |
| V6 | แชร์บทสนทนาในทีม (ตาม ACL) | P0-5 | 1 cw | แชร์ลิงก์ภายใน คนไม่มีสิทธิ์เปิดไม่ได้ |
| V7 | Embed widget harden — เข้า scoped keys + guardrails | P0-4, S8 | 2 cw | widget ใช้ key scope แคบ, ยิงข้าม scope ไม่ได้ |
| V8 | Mobile responsive ตรวจ/เก็บทุกหน้า | — | 2 cw | ทุก flow หลักใช้ได้บนจอ 390px |
| V9 | ค้นหาประวัติแชท | P0-2 | 1 cw | ค้นเจอในแชทตัวเอง เร็ว <1s ที่หมื่นข้อความ |
| V10 | Org-wide doc search + filters + Auto mode | P0-5, V1 | 4 cw | ค้นข้าม workspace กรอง ACL เสมอ (เทส leak), filter วันที่/แหล่ง/ผู้เขียน |
| V11 | RAG tuning admin + reindex UI | V1, O4 | 2 cw | ปรับ chunk/topK/rerank จาก UI, reindex มี progress ไม่ล่มระบบ |

รวม wave 1 ≈ **33 cw**

## Track V — wave 2 (เริ่มเดือน 4–5)

| ID | งาน | ขึ้นกับ | ~แรง | DoD ระดับผลลัพธ์ |
|---|---|---|---|---|
| V12 | Image generation — local/cloud ตาม S7 | S7 | 2 cw | สร้างรูปในแชท, workspace local-only ใช้ model local เท่านั้น |
| V13 | Knowledge curation — Answers/Collections/Pins | V10 | 3 cw | Answer อนุมัติแล้วขึ้นก่อนผล search, ACL คุม |
| V14 | Deep research — **เปิดได้เมื่อ S10+O6 เสร็จ** | S10, O6 | 3 cw | งานวิจัยหลายรอบจบใน budget, admin ปิดต่อ workspace ได้ |
| V15 | Code interpreter sandbox — ปิด default, security-review แยก, เข้า pen-test | S8, P0-1 | 5 cw | sandbox ไม่มี egress (เทสเจาะ), resource cap ทำงาน, Block policy ชนะเสมอ |

รวม wave 2 ≈ **13 cw**

## Ops (เดือน 3–5)

| ID | งาน | ขึ้นกับ | ~แรง | DoD ระดับผลลัพธ์ |
|---|---|---|---|---|
| O1 | License per-seat — key, นับ active user, expiry, offline/air-gap ได้ | P0-1 seam 8 | 3 cw | เกิน seat แล้วเพิ่ม user ไม่ได้, ตรวจ offline ได้, ปลอม key ไม่ผ่าน (ลองเจาะ) |
| O2 | Installer/setup wizard | P0-2 | 3 cw | ติดตั้งเครื่องเปล่า → ใช้งานได้ ภายใน 1 ชม. โดยไม่แตะ .env มือ |
| O3 | Backup/restore ในตัว — DB+vector+docs | P0-6 | 3 cw | restore บนเครื่องใหม่แล้วข้อมูลครบ (เทสจริงทุก release) |
| O4 | Model lifecycle — sizing guide, update bundle offline, re-embed workflow | O3 | 3 cw | เปลี่ยน embedding model ผ่าน workflow แล้ว search ยังถูก |
| O5 | Diagnostic bundle + Prometheus endpoint | P0-6 | 2 cw | bundle export ไม่มี secret ปน, `/metrics` ต่อ Grafana ได้ |
| O6 | GPU queue + UI รอคิว + sizing guide | P0-6 | 3 cw | โหลดเกิน capacity แล้วเข้าคิวไม่ timeout, UI แสดงลำดับ |

รวม Ops ≈ **17 cw**

## เดือน 6–7 — Integration & Hardening

| งาน | DoD |
|---|---|
| Integration ทุก track | demo loop เต็ม (เกณฑ์ข้อ 1 ของ spec) ผ่านต่อหน้าคน |
| Security review รวม (Opus) + จ้าง pen-test ภายนอก (scope รวม V15) | ไม่มี critical/high ค้าง |
| POC playbook + demo dataset ไทย | POC 2 สัปดาห์รันได้ด้วย playbook โดยคนขายที่ไม่ใช่ dev |
| เอกสาร admin/user ภาษาไทย | admin ติดตั้ง+ดูแลได้จากเอกสารโดยไม่ถามทีม |

## สรุปแรงงานทั้ง program

Phase 0 ≈ 12 cw · Track S ≈ 37 · V1 ≈ 33 · V2 ≈ 13 · Ops ≈ 17 · Integration ≈ 8 → **รวม ≈ 120 คน-สัปดาห์**
7 เดือน ≈ 30 สัปดาห์ → ต้องมี dev เฉลี่ย **~4-5 คนเต็มเวลา** (เดือนแรก 2-3, ช่วง fan-out 5-6) — ตัวเลขนี้คือไม้บรรทัดวางทีม

## กติกาแตก issue ตอน fan-out

- item ที่ ≥4 cw ต้องแตกเป็นหลาย issue (จุดแตกระบุในคอลัมน์แรง)
- ทุก issue อ้าง contract ไฟล์ seam จาก P0-1 + spec item ID
- ประมาณ issue จริงทั้ง program: **80-100 issues**

# Execution Schedule — ใครทำอะไรตอนไหน ไม่พันกัน

คู่กับ: `phase0-foundation.md` (เดือน 1) · `program-backlog.md` (item + แรง + DoD)
เป้าของไฟล์นี้: จัด **เลน (lane)** ให้งานขนานไม่ชนไฟล์กัน + ลำดับ merge + กติกากันมั่ว

## หลักกันพันกัน 4 ข้อ (บังคับทุกคน)

1. **หนึ่ง issue = หนึ่ง worktree = หนึ่ง branch** (`approof/<item-id>-<slug>`) — ห้ามสอง issue แชร์ branch
2. **Schema คอขวดเดียว**: `server/prisma/schema.prisma` แก้ได้ทีละ 1 PR ใน flight — ใครจะแตะ schema ต้องจอง (ประกาศใน issue + ดู board ว่าไม่มี schema-PR ค้าง) · migration ห้าม rebase ข้ามกัน ให้ merge เรียงคิว
3. **แตะข้ามเลนต้องผ่าน contract**: งานในเลนตัวเองเรียกของเลนอื่นผ่าน interface จาก `docs/superpowers/design/seams/` เท่านั้น — อยากแก้ contract = เปิด issue แก้ contract ก่อน (กระทบทุกเลน ต้องรีวิวรวม) ห้ามแก้เงียบ ๆ ในงานตัวเอง
4. **Merge เข้า `approof/main` ผ่าน PR + CI เขียวเท่านั้น** — สร้าง branch `approof/main` เป็น integration branch ของ program (ไม่ใช้ `master` ที่ยัง track upstream)

## เลนถาวร (ตลอด program)

| เลน | ขอบเขตไฟล์หลัก | คนถือ |
|---|---|---|
| **A — Core/Schema** | `server/prisma/`, permission engine, seams contracts, job queue/event bus | 1-2 คน senior — คนเดียวกับที่ review schema PR ทุกใบ |
| **B — Identity/Security** | `server/utils/middleware/`, auth endpoints, SSO drivers, MFA, API keys | 1-2 คน |
| **C — Data/RAG** | collector, embedders, vector providers, connectors, search | 1-2 คน |
| **D — Product/UI** | `frontend/`, Lark bot, widget, assistant, analytics UI | 1-2 คน |
| **E — Ops** | docker, installer, backup, license, CI, metrics | 1 คน |

งานข้ามเลน (เช่น V10 search มี UI): เลนเจ้าของ backend ทำ API จบก่อน → เลน D ทำ UI ตาม API ที่นิ่งแล้ว — สลับกันแก้ไฟล์เดียวกันไม่ได้

## ตารางเวลา (สัปดาห์ = W)

### เดือน 1 — Phase 0 (ทีมเล็ก 3-4 คน ห้ามเกิน)

| W | เลน A | เลน B | เลน E |
|---|---|---|---|
| W1 | P0-1 contracts (เริ่ม) | — (ช่วย A รีวิว) | P0-3 test suite + CI |
| W2 | P0-1 จบ + review · P0-2 Postgres เริ่ม | P0-4 hardening เริ่ม (รอ contract seam 8 จาก P0-1) | P0-3 จบ · P0-7 de-brand |
| W3 | P0-2 จบ · P0-6 queue/bus เริ่ม | P0-4 จบ + security-review | P0-7 จบ |
| W4 | P0-6 จบ · **P0-5 authorization** (A+B รวมตัวทำคู่ — งานคอขวด) | ← ร่วม P0-5 | buffer/แก้ CI |

**Gate เดือน 1**: ทุก issue Phase 0 ปิด (อ่านกลับผ่าน) + เทสเขียว → เปิด fan-out · ถ้า P0-5 ไม่จบ **ห้าม fan-out** (ทุกอย่างสร้างบน permission engine) — เลื่อนได้ 1 สัปดาห์ กินจาก buffer เดือน 7

### เดือน 2 — fan-out เริ่ม (ขยายเป็น 5-6 คน) + teardown/dogfood

| เลน | งาน (เรียงก่อนหลัง) |
|---|---|
| A | ประคอง contract + review schema PR ทุกใบ + S5 audit (ต่อจาก bus) |
| B | S1 OIDC → เริ่ม S13 MFA |
| C | V1 ภาษาไทย (embedding+eval ก่อน UI) · V9 chat search |
| D | V8 responsive + **mockups ล่วงหน้า** ของ V2/V4/V10 (ขั้น 1.5 — ทำก่อนถึงคิว dev 2 สัปดาห์เสมอ) |
| E | O2 installer เริ่ม · dogfood deploy ให้ทีมใช้เอง |
| PMO | competitor teardown ซ้ำ → ของหลุดเข้า backlog |

### เดือน 3

| เลน | งาน |
|---|---|
| A | S6 governance เริ่ม (retention+redaction ก่อน — ใช้ queue) |
| B | S2 SAML · S3 LDAP · S11 SMTP |
| C | V3 connectors (Drive ก่อน Lark Docs) — ใช้ contract seam 4 |
| D | V2 Lark bot (mockup อนุมัติแล้ว) · V6 แชร์แชท |
| E | O2 จบ · O3 backup |

### เดือน 4

| เลน | งาน |
|---|---|
| A | S6 ต่อ (DLP scan, consent) · S7 LLM policy |
| B | S4 Lark org sync (คู่กับ D ที่ทำ bot แล้ว) · S12 offboarding |
| C | V10 doc search (backend) · V11 RAG tuning |
| D | V4 assistant templates · V10 UI · wave 2: V12 image gen เริ่ม |
| E | O4 model lifecycle · O6 GPU queue |

### เดือน 5

| เลน | งาน |
|---|---|
| A | S8 guardrails + runtime policy (คอขวดที่สอง — แตะ pipeline ทุกคนใช้ ทำตอนเลนอื่นงานเบา) |
| B | S13 จบ · S9 air-gap switch |
| C | V5 eval harness · V13 curation |
| D | V7 widget harden · V13 UI · V14 deep research (S10+O6 ต้องจบก่อนเปิด) |
| E | O1 license · O5 diagnostics · S10 budget (คู่ A) |

### เดือน 6 — ปิด feature + เริ่ม integration

- ทุกเลน: จบงานค้าง + V15 sandbox (B+E คู่กัน, security-review แยก) — **feature freeze สิ้นเดือน 6**
- PMO: เริ่มเดินเกณฑ์ demo loop ทีละข้อ

### เดือน 7 — Integration & Hardening เท่านั้น

- W1-2: integration + แก้ของพัง + security review รวม (Opus)
- W2-3: pen-test ภายนอก (จองผู้ให้บริการล่วงหน้าตั้งแต่**เดือน 5**) + แก้ finding
- W3-4: POC playbook + เอกสารไทย + demo dataset · buffer

## จุดชนที่รู้ล่วงหน้า + ทางแก้ (จองไว้เลย)

| จุดชน | เลนที่ชน | กติกา |
|---|---|---|
| `schema.prisma` | ทุกเลน | คิวเดียว เลน A ถือ merge order — ประกาศจองใน board ก่อนเริ่ม |
| Chat pipeline (seam 3) | S6 redaction, S8 guardrails, S10 metering, V12 | ทำเป็น middleware แยกไฟล์ต่อ step ตาม contract — ห้ามสองคนแก้ core pipeline พร้อมกัน: S6 (ด.3-4) → S10 (ด.5) → S8 (ด.5) เรียงคิวแล้ว |
| Middleware auth | P0-4, P0-5, S1, S13 | จบ P0-4/P0-5 ก่อน แล้ว S1/S13 เขียนเป็น driver ไม่แตะ core |
| `frontend/` โซน settings | S7, S10, V4, V11 UI | เลน D เจ้าของเดียว — เลนอื่นส่ง API + spec ให้ D ทำ UI |
| Lark (S4 sync กับ V2 bot) | B กับ D | แชร์ Lark client module เดียว — สร้างใน V2 ก่อน (ด.3), S4 (ด.4) ใช้ต่อ ห้ามเขียนซ้ำ |
| docker-compose/entrypoint | P0-2, O2, O3, S9 | เลน E เจ้าของเดียวหลัง P0-2 |

## จังหวะ merge (กันมั่วตอนรวม)

- PR เล็ก merge เร็ว — ห้าม branch อายุเกิน 1 สัปดาห์ (ยิ่งค้างยิ่งชน) งานใหญ่แตก PR ย่อยตาม step ใน plan
- ทุกเช้า: rebase branch ตัวเองบน `approof/main` — conflict เจอตอนเช้าวันที่สอง ไม่ใช่ตอน merge สัปดาห์ที่สาม
- Schema PR: merge ก่อนเพื่อนเสมอเมื่อพร้อม (คนอื่นจะได้ rebase ทับของจริง)
- Contract เปลี่ยน: ประกาศใน issue + tag ทุกเลนที่กระทบ ก่อน merge อย่างน้อย 1 วัน

## Ruling ฝังในแผน

- `Ruling:` ใช้ `approof/main` เป็น integration branch แยกจาก `master` — เพราะ master ยัง track upstream ไว้เทียบ/ดึง fix เฉพาะจุด — ถ้าผิด: แค่ rename branch
- `Ruling:` จัดเลนตามชั้นของระบบ (core/auth/data/UI/ops) ไม่ใช่ตาม track S/V — เพราะ track ตัดข้ามไฟล์เดียวกัน แต่เลนตัดตามไฟล์ = ชนกันน้อยสุด — ถ้าผิด: สลับคนข้ามเลนได้ โครงไม่เสีย
- `Ruling:` S8 เลื่อนไปเดือน 5 ทั้งที่อยู่ Track S — เพราะแตะ chat pipeline ที่ S6/S10 ต้องใช้ก่อน เรียงคิวกันชน — ถ้าผิด: guardrails มาช้า แต่ไม่บล็อกใคร
- `Ruling:` จอง pen-test ตั้งแต่เดือน 5 — เพราะผู้ให้บริการคิวยาว 4-8 สัปดาห์ — ถ้าผิด: เสียค่าจองเปล่า ถูกกว่าเลื่อนส่งมอบ

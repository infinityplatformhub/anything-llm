# Recon: E2E headed browser test — gate ปิด Phase 0
- ปัจจุบันทดสอบถึงระดับ API เท่านั้น (supertest 629 เคส) + QA รัน docker/curl เอง — **ไม่มีใครเปิด browser จริง**
- ความเสี่ยง: frontend/backend integration พังโดยไม่มีใครรู้ (โดยเฉพาะหลัง de-brand เปลี่ยน strings/assets, Postgres migration, event bus แทน logEvent 95 จุด, และ P0-5 ที่จะเปลี่ยน role checks 189 จุด + frontend capability 105 จุด)
- งาน: Playwright headed suite รัน flow จริงบน docker stack: ติดตั้ง/onboarding → login → สร้าง workspace → upload เอกสาร → ถามแล้วได้คำตอบพร้อม citation → admin เปิด user/API key → audit log แสดงผล → logout
- ต้อง: รันบน stack ที่ยกจาก docker compose จริง (ไม่ใช่ dev server), screenshot เก็บทุก step, รันใน CI แบบ headless + รัน headed ได้ตอน debug
- ใช้เป็น gate: Phase 0 ปิดไม่ได้ถ้า E2E ไม่ผ่าน — และเป็น regression net ให้ P0-5 ที่จะรื้อ authorization ทั้งระบบ

## เพิ่มจาก QA-1 (คนรัน docker stack จริงบ่อยสุด) — 2026-09-02

### Required scope
1. **Mock LLM ที่ระดับ provider** — container เล็กใน compose ตอบ canned SSE stream ผ่าน generic OpenAI-compatible endpoint · ห้ามใช้ key จริง (flaky+แพง) · ได้ทดสอบ streaming path ที่ API test ไม่แตะ
2. **Audit step assert แถวจาก event bus จริง** — login/api_key_created ต้องโผล่ใน admin UI = ยืนยัน outbox pump ทำงานใน prod mode (regression class ที่ unit test จับไม่ได้ — เพิ่ง FAIL boot wiring มาแล้วรอบหนึ่ง)
3. **Restart resilience** — `docker compose restart anything-llm` แล้ว login ใหม่ + ข้อมูลเดิมครบ (ยืนยัน migrate idempotent + volume + entrypoint wait; จุดที่พังบ่อยสุด)
4. **Multi-user negative** — default user ไม่เห็นเมนู admin + เรียก admin route โดน 401 ผ่าน UI (baseline ก่อน P0-5 รื้อ role checks 189 จุด — ถ้าไม่มีตอนนี้ P0-5 ไม่มี regression net ฝั่ง deny)
5. **De-brand assertion** — หน้า login/onboarding ไม่มีคำว่า AnythingLLM + ไม่มี network request ออก posthog/anythingllm domains (Playwright จับ network ได้ฟรี) ปิด loop P0-7

### ห้าม/ระวัง
- ห้าม assert เนื้อหาคำตอบ LLM — assert แค่ response ไม่ว่าง + citation ชี้ doc ที่ upload
- upload ใช้ .txt เล็ก ไม่ใช่ PDF (collector parsing flaky ไม่ใช่สิ่งที่ gate นี้พิสูจน์)
- screenshot เก็บเป็น artifact เฉพาะตอน fail ใน CI

### Operational
- COMPOSE_PROJECT_NAME แยก + port env override + bind 127.0.0.1 (เครื่อง dev มี 3001/55432 ถูกถือตลอด)
- setup script copy docker/.env จาก .env.example เอง (volume bind ต้องมีไฟล์จริง)
- wait-on /api/ping (first boot หลัง migrate ~25-30s) ห้าม sleep ตายตัว
- onboarding ทำครั้งเดียวต่อ volume → `down -v` ก่อนทุก run หรือแยก project "fresh install" / "existing install"

### Gate criteria
required: flow หลัก 1-7 + restart + negative + de-brand network check · อื่น ๆ optional

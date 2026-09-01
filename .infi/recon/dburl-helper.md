# Recon: DATABASE_URL query-param handling — 3 suites พังบน env จริง
- QA-1 รัน sanity ด้วย DATABASE_URL ที่มี ?schema=public&connection_limit=5 (รูปแบบที่ deployment จริงใช้) → 3 suites / 18 tests fail บน main ffca31ad
  1. t1-authz-migration.test.js (14 fail) — execSync psql "${testUrl}" ส่ง URL ดิบ → psql: invalid URI query parameter: "schema"
  2. sqlite-to-pg-import.test.js (1 fail) — searchParams.set("schema",...) บน URL ที่มี params อยู่แล้ว + connection_limit=5 → db push/import ช้าเกิน hook timeout 5000ms
  3. scheduler.postgres.test.js (3 fail) — beforeAll updateMany PrismaClientInitializationError + timeout (คาด connection_limit=5 ทำ pool อดใน --runInBand หรือ URL-derived DB name เพี้ยน)
- ทั้ง 3 ไฟล์ประกอบ/แปลง DATABASE_URL เองคนละแบบ = bug class เดียวกัน
- Fix: helper เดียวที่ (a) strip query params สำหรับส่งให้ psql (b) derive per-test DB/schema อย่างปลอดภัย + ขยาย hook timeout ที่จำเป็น
- ไม่ใช่ regression ของ #6 — เป็น env-shape bug ที่มีมาก่อน

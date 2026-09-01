# T-1 (#17) ruling ledger

- `Ruling:` NULLS NOT DISTINCT อยู่ใน migration SQL เท่านั้น ไม่มีใน Prisma schema — เพราะ Prisma 5.3 ไม่ express ได้; พิสูจน์ no-drift ด้วย `prisma migrate diff --from-url --to-schema-datamodel` = "No difference detected" + test ยืนยัน indexdef — ถ้าผิด: Prisma จะ generate migration แก้ constraint ทุกครั้งที่ dev diff
- `Ruling:` vocabulary = union 50 actions (23 engine + 33 API scopes ที่ PMO อนุมัติ 2026-09-02) ใน namespace เดียวตาม R3 — เติมจากลิสต์ PMO ไม่ใช่เดาเอง — ถ้าผิด: มีคำเกินใช้จริง (ยอมรับได้, ลบทีหลังได้ ไม่กระทบ wire)
- `Ruling:` migration ใช้ generator script (scripts/gen-vocabulary-sql.js) แทนการพิมพ์ INSERT ซ้ำมือ — เพราะ shell inline กลืน quote เคยทำ SQL เสีย (เกิดจริง 1 รอบ) — ถ้าผิด: step เพิ่มคำทีหลังต้องรัน generator ทุกครั้ง (จำเป็นอยู่แล้ว)
- `Ruling:` seed.js ใช้ find-then-create แทน compound-unique upsert สำหรับ grant ที่ workspace_id NULL — เพราะ Prisma 5 ห้าม null ใน unique where input — ถ้าผิด: ช้าลงไม่มี (seed รันครั้งเดียวต่อ env)
- `Ruling:` integration test รัน backfill ผ่าน psql ไม่ใช่ prisma db execute — เพราะ db execute ตัด statement กลาง DO $$ block (พิสูจน์แล้ว 2 error) — ถ้าผิด: CI ต้องมี psql (ubuntu-latest มี; ถ้า CI เปลี่ยน runner ต้องกลับมาแก้)
- `Ruling:` workspace role เดิมของ default member = editor ไม่ใช่ viewer — พฤติกรรม legacy (upload/update/delete ได้) — ตัดสินร่วมกับ 8b แล้ว

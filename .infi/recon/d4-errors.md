# Recon D4: รวม seam error classes ไว้จุดกลาง
- ปัจจุบัน error ของ seam ฝังใน driver: utils/jobs/PostgresJobQueue.js:18-19 (LeaseLostError, ImpersonatedMutationError), utils/events/PostgresEventBus.js:4-5 (EventConflictError, UnknownEventVersionError)
- ปัญหา: seam 09/10 อ้างชื่อเหล่านี้เป็น public surface แต่ catch ต้อง import จาก path ของ first driver = ผูก contract กับ implementation
- งาน: สร้าง server/utils/jobs/errors.js, server/utils/events/errors.js (P0-5 จะสร้าง utils/authorization/errors.js เอง) แล้วให้ driver re-export ต่อ (call site ไม่พัง, diff ~10 บรรทัด)
- ต้องเสร็จ **ก่อน P0-5 เริ่มเขียนโค้ด** เพราะ P0-5 เป็นตัวแรกที่ throw ข้าม seam ถ้าไม่รวมก่อนจะ import จาก driver path แล้วต้องแก้สองรอบ
- ที่มา: Techlead D4 (docs/superpowers/design/code-standards.md @ 122ab37f)

# Recon: 2 test suites รันไม่ได้บน main (merge interaction)
- QA-1 เจอบน main 9af339e7: __tests__/ssoIssuanceLockHttp.test.js + __tests__/envDumpGuardHttp.test.js (จาก #8/#10) ยัง hardcode sqlite pattern เก่า
  - ตั้ง DATABASE_URL = file:...test.db
  - replace string `url = "file:../storage/anythingllm.db"` ใน schema ซึ่งไม่มีแล้วหลัง P0-2
  → prisma db push ตาย → 2 suites รันไม่ได้เลย = HTTP-level lock proof ของ #8/#10 ไม่มีผลคุ้มครองจริง
- ผลรวมบน main: 58 passed / 2 failed suites, 697 tests passed
- สาเหตุ: PR เขียนก่อน P0-2 merge แล้ว merge ทีหลัง — ด่านต่อ branch ผ่านเพราะรันบน base เก่า
- Fix: แปลงเป็น per-process PG schema pattern แบบ __tests__/api/regression.test.js
- เพิ่มเติมที่ต้องเก็บ: repo root package.json มี diff (prisma 5.3.1 deps) + migrations-draft/ untracked

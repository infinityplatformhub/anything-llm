# Recon P0-4 PR-0b: unauthenticated /v1/system/env-dump (hotfix)
- ยืนยันจากโค้ดจริง server/endpoints/api/system/index.js:16-35 — route ประกาศ `app.get("/v1/system/env-dump", async (_, response) => {...})` **ไม่มี middleware array เลย** (route อื่นในไฟล์เดียวกันใช้ [validApiKey])
- swagger comment อ้าง 403 InvalidAPIKey แต่โค้ดไม่เคยเช็ค → ใครก็เรียกได้แบบ unauthenticated
- production (NODE_ENV=production) เรียก dumpENV() เขียน .env dump ลง file storage — DoS/disk write + เสี่ยงเปิดเผยผ่าน storage path ที่ serve ได้
- งาน: ใส่ validApiKey (และ scope เมื่อ PR-4x มา) + audit sweep ทุก route ใน server/endpoints/api/ ว่ามี route อื่นไม่มี middleware อีกไหม (cc นับ 63 routes: 62 validApiKey + 1 ตัวนี้ — ต้องยืนยันเอง)

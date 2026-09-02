# Recon PR-4a: scope call-sites กลุ่มแรก (admin/userManagement/auth)
- PR-3 (#16) merged แล้ว: validApiKey(action) factory, requireScope default deny, apiKeyContext บน locals, 68 refs ยังใช้ API_KEY_SCOPES.TEMPORARY_ALL = "*"
- PR-4a scope: แทน "*" ด้วย action จริงใน api/admin (13 refs) + api/userManagement (2) + api/auth (1) = 16 refs
- Vocabulary 50 actions merge ไปกับ T-1 แล้ว (seeds/permissions.js) — ใช้ verbatim ห้ามสร้างคำใหม่/translation table (R3)
- ทุก route ที่แทนต้องลด EXPECTED_WILDCARD_ROUTES ใน apiKeyWildcardSweep.test.js (assert ===)
- ต้องมี scope table (route → action) เป็น data structure เดียวที่ route registration + test อ่านร่วมกัน
- Commitment จาก PR-3 ที่ต้องทำใน PR-4: enforce apiKeyContext.workspaceId เทียบ resource (ข้อ 14) · PR-4c drop DB default '["*"]' + เทสยืนยัน 0 rows มี * · scope ceiling ตอนสร้าง key (ข้อ 13)
- QA จะยิงกริด scope × route เต็ม: key scope A ยิง route ที่ต้อง scope B = 403 ทุกคู่

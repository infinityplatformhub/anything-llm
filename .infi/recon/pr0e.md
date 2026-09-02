# Recon PR-0e: sync-watched-documents wrong-document overwrite (hotfix)
- Spec เต็ม: docs/superpowers/design/pr-0e-sync-watched-bloom.md @ 0484b0a5
- บั๊ก: jobs/sync-watched-documents.js:157-193 ทำ Document.where({filename}) แต่ filename คือ basename (models/documents.js:123 — path.split(/[/\\]/).pop(); folder อยู่ใน docpath :124)
  → จับเอกสารคนละตัวที่บังเอิญ basename ตรงกัน แล้ว deleteDocumentFromNamespace + addDocumentToNamespace (:177-190)
  → vector ของ workspace B ถูกลบแล้วแทนด้วยเนื้อหาจาก URL ของ workspace A = data corruption + cross-tenant disclosure ทุกรอบ sync
- Fix: เปลี่ยน match key `filename: document.filename` → `docpath: document.docpath` (docpath คือ identity ของไฟล์จริงบน disk ที่ถูกเขียนทับ)
- ห้าม fix ด้วยการ scope ด้วย workspaceId — updateSourceDocument (jobs/helpers/index.js:23-28) เขียนทับไฟล์จริงไฟล์เดียวที่ทุก workspace ที่อ้าง docpath เดียวกันอ่านร่วม ตัด fan-out = vector เก่าค้าง drift กับ disk (มีเทสกันไว้แล้ว 2 เคส)
- Tests: attack (RED ก่อน fix) basename เดียวกัน docpath ต่าง → addDocumentToNamespace ถูกเรียกครั้งเดียว · regression: docpath เดียวกันคนละ workspace ยัง bloom ปกติ
- ไม่ปิด: actor ที่หาย (ยังอยู่ T-4b) — หลัง PR-0e job ยังเขียนข้าม workspace โดยไม่มี principal แต่เขียนผิดเอกสารไม่ได้แล้ว

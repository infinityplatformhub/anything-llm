# Recon PR-0c: G11 cross-workspace purge IDOR (hotfix)
- DELETE /workspace/:slug/remove-and-unembed (server/endpoints/workspaces.js:861-888) รับ arbitrary body.documentLocation ส่งเข้า purgeDocument (:881) โดยไม่เช็คว่า doc นั้นอยู่ใน workspace นั้น + manager ผ่านทุก workspace (A-2 bypass ใน getWithUser)
- purgeDocument ลบ canonical file + vectors ทุก workspace → cross-workspace destructive IDOR
- Fix ขั้นต่ำ: query workspace_documents ที่ workspaceId = currWorkspace.id AND docPath = body.documentLocation ก่อน purge; ไม่เจอ = 400 · ห้าม match ด้วย filename อย่างเดียว
- Test: manager ของ A ส่ง location ของ B → 400, ไฟล์ B ยังอยู่, vector B ยังคืนผล; happy path ยัง purge ได้

# Recon PR-0d: G12 embed history IDOR (hotfix)
- GET/DELETE /embed/:embedId/:sessionId (server/endpoints/embed/index.js:69-107) ใช้แค่ [validEmbedConfig] ขาด setConnectionMeta + เช็ค enabled/origin allowlist/UUID validate ที่ POST path มี
- ใครรู้/เดา embedId+sessionId อ่านหรือลบ history ได้
- Fix: middleware ใหม่ canAccessEmbedHistory ใน embedMiddleware.js — (1) embed.enabled เท็จ → 503 (2) origin allowlist เหมือน canRespond :66-96 รวม EMBED_REQUIRE_ALLOWLIST deny-all (3) uuid.validate(sessionId) ไม่ผ่าน → 404 · ใช้ทั้ง GET+DELETE · ห้ามลาก canRespond ทั้งอัน (อ่าน reqBody/quota ของ POST)
- Test: origin นอก list → 401, disabled → 503, sessionId ไม่ใช่ UUID → 404, ติดทั้ง GET/DELETE
- หมายเหตุ: session ownership เต็มปิดที่ P0-5 T-4b (embed actor) — hotfix นี้ปิด unauth surface กว้าง

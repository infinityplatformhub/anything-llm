# Recon T-2 (P0-5): Authorization engine core + actor resolver
- Spec: docs/superpowers/design/p0-5-authorization-recon.md (T-2) + p0-5-t2-actor-resolver.md (11 ingress rows, resolveActor signature, §2b status table) + p0-5-stest-harness.md
- Base: main de95015b (T-1 schema + PR-3 apiKeyContext merged แล้ว)
- งาน: engine can(actor, action, resource) จุดเดียว + actor resolver กลาง 6 identity types (JWT user, API-key service, browser-extension key, mobile device token, embed anonymous, SSO temp) + missing actor = deny ที่ engine ไม่ใช่ caller + single-user virtual principal {type:"service", id:"single-user"} + impersonation blanket deny + policy_versions clock
- A-1 fix (R5): flexUserRoleValid bypass ตอน single-user mode → deny-by-default + explicit single-user principal ที่มี role เต็ม ไม่ใช่ skip check
- Commitments จาก T-1 review: visibility เช็คก่อน ACL เป็น hard override ใน documentFilter() ระดับ query (ห้าม post-filter) · policy_version bump ผ่าน repository เดียว (ทุก mutation ที่แตะ grant/ACL) · T-2 เป็นที่เดียวที่สร้าง Actor (PR-3 ให้แค่ apiKeyContext)
- Env note: หลัง rebase ต้อง prisma generate ใหม่ ไม่งั้น client เก่าไม่รู้จัก secretDigest = 57 fails หลอก

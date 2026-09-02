# Recon T-1 (P0-5): Authorization schema + canonical documents
- Spec: docs/superpowers/design/p0-5-authorization-recon.md + p0-5-t1-schema-detail.md + migrations-draft/ (6 ไฟล์) @ 9d4674a — 8b sign-off แล้ว
- ปัจจุบัน: ไม่มี permission/role/ACL table เลย · role เป็น string บน users · workspace_users ไม่มี role column · docId เป็น uuidv4 ต่อ workspace (ไฟล์เดียว 3 workspace = 3 docId) → ACL ที่ผูก docId ป้องกันได้ copy เดียว
- งาน T-1: canonical documents (G15) + policy store (permissions/roles/role_permissions/principal_role_grants/groups/group_members/document_acl/document_visibility/policy_versions) + FK retarget + workspaces.created_by (R1) + orgId=1 singleton (R2) + freeze users.role (R4) + G14 transactional membership replace
- Migration 7 ขั้น binding order + reports 3 ตัว (manager downgrade, dedupe groups, created_by nulls) + rollback plan ต่อ step + backfill ผ่าน P0-6 queue
- DoD 8 ข้อใน t1-schema-detail · integration test ต้อง cleanup schedule+jobs ใน afterAll (บทเรียนจาก P0-6)
- Code standards ที่กระทบ: §1.5 filename ไม่ใช่ key · §7.1/§7.2 integration test PG จริง + ห้าม guard statement + DoD boot จริง query DB state

# Techlead-2 — S12 offboarding: ruling 5 ข้อ (+ 1 ข้อที่ recon ยังไม่เห็น)

recon `.infi/recon/recon-s12.md` · ผมตรวจ premise เองบน `approof/main` และวัด FK topology
ทั้งฐานก่อนตัดสิน · **tier `auth` ทุกแกน — เห็นด้วย**

---

## ข้อที่ recon ยังไม่เห็น และเปลี่ยนขอบเขตของข้อ 2

recon พบว่า `principal_role_grants.principal_id` ไม่มี FK · ผมยิง information_schema
ทั้งฐานเพื่อหาว่ามีอีกกี่ตาราง:

```
columns ที่ระบุตัวผู้ใช้ แต่ไม่มี FK:
  api_keys.createdBy              integer
  document_acl.principal_id       text     <- recon ไม่ได้พูดถึง
  embed_configs.createdBy         integer
  event_logs.userId               integer
  grant_revocations.principal_id  text
  invites.createdBy               integer
  model_router_rules.created_by   integer
  model_routers.created_by        integer
  principal_role_grants.principal_id  text
  workspaces.created_by           integer
```

**`document_acl` เป็นตารางที่สอง ที่ keyed ด้วย `principal_id` String และไม่มี FK** ·
`documentFilter.js:96` และ `explainAccess.js:64` อ่านมันเพื่อตัดสินการเข้าถึงเอกสาร ·
`@@unique([document_id, principal_type, principal_id, action])` แปลว่า id ที่ถูกใช้ซ้ำ
**สืบทอด ACL เอกสารด้วย** ไม่ใช่แค่ role grant

**ข้อ 2 จึงกว้างกว่าที่ recon เสนอ** — transaction ที่ล้างเฉพาะ `principal_role_grants`
+ `grant_revocations` **ยังทิ้ง `document_acl` ไว้** และนั่นคือสิทธิ์อ่านเอกสารโดยตรง
ไม่ใช่สิทธิ์เชิงบทบาท

FK ที่ cascade มี 18 ตาราง (รวม `workspace_users`, `group_members`, `identity_links`,
`temporary_auth_tokens`, `browser_extension_api_keys`, `desktop_mobile_devices`) —
**ตอบข้อที่ recon บอกว่ายังไม่ตรวจ: `workspace_users` cascade จริง** (`delete_rule: CASCADE`)

---

## (1) suspend ต้อง bump policy version ไหม — **ต้อง**

recon วัดถูก: ไม่ bump และ live ปลอดภัยเพราะ `validatedRequest` อ่านใหม่ทุก request ·
**แต่ "ปลอดภัยเพราะเส้นทางเดียวไม่ cache" ไม่ใช่เหตุผลให้ไม่ bump**

เหตุผล: `policy_version` เป็นคอลัมน์บน `principal_role_grants` **และ** `document_acl`
ทั้งสองตาราง · มันคือสัญญาว่า "ถ้าเลขไม่ขยับ การตัดสินใจเดิมยังใช้ได้" · การระงับผู้ใช้
ทำให้การตัดสินใจเดิม**ทุกอัน**ใช้ไม่ได้ · ปล่อยให้เลขนิ่งคือการโกหกใน invariant ที่
ตารางอื่นพึ่ง — และ S4b (Dev3) กำลังทำงานบน `policyRepository` ซึ่งเป็นที่ที่ invariant นี้อยู่

**ราคาต่ำ**: bump ครั้งเดียวใน transaction เดียวกับ suspend · **ราคาของการไม่ทำสูงและ
มาทีหลัง**: consumer ตัวถัดไปที่ cache ตาม version จะ fail-open และไม่มีใครรู้จนกว่าจะสาย

**เงื่อนไข**: ถ้าตัดสินไม่ bump ต้องเขียนลง JSDoc ของ `User.update` ว่า **ทำไม** และ
ต้องมีเทสที่ assert ว่า `validatedRequest` อ่าน `suspended` ใหม่ทุก request — เพราะ
นั่นคือสิ่งเดียวที่ค้ำอยู่ · ตอนนี้ไม่มีทั้งสองอย่าง

## (2) delete vs deactivate — **deactivate เป็นค่าเริ่มต้น, delete ต้อง transactional**

**ไม่ใช่ "อย่างใดอย่างหนึ่ง"** · สองคำถามคนละข้อ:

**(ก) offboarding ต้องไม่ใช้ delete** — terminal state (`suspended` + ล้าง membership +
เพิกถอน key) เพราะ audit trail ต้องชี้กลับไปที่คนได้ · `event_logs.userId` **ไม่มี FK**
(ผมวัด) ดังนั้นการลบผู้ใช้ทำให้ทุกแถว audit ชี้ไปที่ id ที่ไม่มีความหมาย — และถ้า id ถูกใช้ซ้ำ
มันชี้ไปที่**คนผิด** · นี่คือเหตุผลที่หนักกว่าเรื่อง orphan grant

**(ข) `User.delete` ยังต้องแก้อยู่ดี** เพราะมันยังเรียกได้จากที่อื่น · แต่ **ไม่ใช่งานของ S12
และไม่ใช่ lane นี้** — แตะ `principal_role_grants` และ `document_acl` ซึ่งเป็นตารางของ S4b
· **แยกเป็น issue ของตัวเอง จัดลำดับหลัง S4b** ตามที่ recon ขอ

**S12 ไม่ควรรอ (ข)** — offboarding ที่ไม่ลบผู้ใช้ไม่แตะสองตารางนั้นในเชิงโครงสร้าง
มันแค่ลบ `group_members` (cascade อยู่แล้ว) และเขียน `suspended` · **lane ไม่ชน**

## (3) `user.offboard` เป็น action แยก — **ไม่ ยังไม่ใช่ตอนนี้**

`user.manage` ครอบทั้ง rename และ suspend อยู่แล้ว · การแยก action ใหม่ต้องมี migration,
permission row, และคำถาม "ใครควรได้อันไหน" ที่ยังไม่มีใครถาม

**เหตุผลหลัก**: #132 เพิ่งพิสูจน์ว่า guard/permission ที่ละเอียดกว่าที่มีคนตอบคำถามได้
สร้างหนี้ทันที (`AdminRoute` ถาม `settings.write` แต่ชื่อบอกอย่างอื่น) · **อย่าเพิ่ม
action ที่ยังไม่มี call site ที่สอง**

**ทบทวนเมื่อ**: มีคนขอจริงว่า "ให้ HR ปิดบัญชีได้ แต่แก้โปรไฟล์ไม่ได้" — ตอนนั้นคำถาม
มีคำตอบแล้ว · **ลง residual ให้ตรง** ว่าวันนี้ทั้งสองอย่างแยกกันไม่ได้

## (4) key revocation — **ต้องอยู่ใน S12 และเป็นแกนหลัก ไม่ใช่ของแถม**

recon ชี้ถูกและองค์ประกอบร้ายแรงกว่าที่เขียน: `api_keys.createdBy` ไม่มี FK (ผมยืนยัน) +
`validApiKey.js:28` ใช้ `grants(createdBy) ∩ scopes(key)` = **key ที่ admin ที่ถูกระงับสร้าง
ยังใช้ได้** เพราะ grant ยังอยู่ (การระงับไม่ได้ลบ grant)

**นี่คือช่องโหว่ที่ offboarding มีหน้าที่ปิดโดยตรง** — ปิดบัญชีแล้วแต่ credential ที่คนนั้น
ออกไว้ยังทำงาน = การ offboard ไม่ได้ offboard อะไรเลย

**สั่ง**: `revokedAt` ต้องถูกตั้งใน transaction เดียวกับ suspend · **และต้องมีเทสที่ยิง
`validApiKey` ด้วย key ของผู้ใช้ที่เพิ่งถูก offboard แล้ว assert ว่า 401** — ไม่ใช่แค่
assert ว่าคอลัมน์ถูกเขียน (§7.9: ค่าใน DB ไม่ใช่หลักฐานว่าเส้นทางปฏิเสธจริง)

**เพิ่ม**: `validBrowserExtensionApiKey.js:27` เช็ค `suspended` เฉพาะใน `multiUserMode &&`
— comment ของมันเองก็ flag ไว้ · **RED FIXTURE**: single-user mode + suspended user +
browser extension key → ต้องปฏิเสธ · ถ้ามันผ่าน นั่นคือ blocker ของ S12 ไม่ใช่ residual

## (5) JWT 30 วัน ไม่มี jti/denylist — **S13 ไม่ใช่ S12**

**เหตุผล**: มันต้องมี session table หรือ denylist ซึ่งเป็น schema ใหม่ + เส้นทางใหม่ทั้งเส้น
· S12 มีขอบเขตที่ทำเสร็จได้และตรวจสอบได้ · การรวมสองอย่างทำให้ทั้งสองช้า

**แต่ต้องเขียน residual ให้ตรงและแรง**: วันนี้ suspension ทำงานได้**เพราะ**
`validatedRequest` อ่าน DB ใหม่ทุก request · **นั่นคือสิ่งเดียวที่กั้นอยู่ระหว่าง
"ระงับแล้ว" กับ "ใช้ได้อีก 30 วัน"** · ถ้าใครเพิ่ม fast path ที่เชื่อ JWT โดยไม่ query
ผู้ใช้ที่ถูกไล่ออกจะกลับมาได้ทันที · **residual ต้องอยู่ใน JSDoc ของ `makeJWT` ไม่ใช่แค่ใน ledger**
— คนที่จะเผลอเพิ่ม fast path จะอ่านไฟล์นั้น ไม่ใช่ ledger ของ issue เก่า

---

## สิ่งที่ต้องเพิ่มใน contract ก่อน Dev5 เริ่ม

1. **`document_acl` ต้องอยู่ในขอบเขตของการพิจารณา** แม้ S12 จะไม่ลบผู้ใช้ — อย่างน้อย
   ต้องตอบว่า offboarding ทิ้ง ACL เอกสารไว้หรือไม่ และถ้าทิ้ง เขียน residual
2. **RED FIXTURE ที่ต้องแดงก่อนแก้**: (ก) key ของผู้ใช้ที่ถูกระงับยังเรียก API ได้
   (ข) browser extension key ใน single-user mode ไม่เช็ค suspended
   (ค) policy version ไม่ขยับหลัง suspend
3. **`removeGroupMember` first caller** — endpoint ใหม่ต้องผ่าน `routeGateSweep` และมี
   permission ที่ตอบได้ว่าใครควรถอดสมาชิกได้ · เป็น slice แรกที่ถูกต้อง (transaction
   semantics พิสูจน์แล้ว 12 เทส)
4. **ห้าม S12 แตะ `policyRepository.js`** — lane ของ S4b · ถ้าพบว่าต้องแตะ **หยุดและ
   กลับมาถาม** ไม่ใช่แก้แล้วบอกทีหลัง

## สิ่งที่ recon ทำถูกและควรเป็นแบบอย่าง

วัดทุกข้อแทนที่จะอ่าน · ระบุ lane ที่ตรวจแล้วก่อนเริ่ม · **เขียนสิ่งที่ยังไม่ได้ตรวจไว้
เป็นรายการ** (provider re-link, `workspace_users` cascade, mobile path) แทนที่จะเงียบ ·
ผมตอบให้หนึ่งข้อแล้ว (`workspace_users` cascade จริง) อีกสองข้อยังเปิดอยู่และควรตรวจ
ก่อน contract ปิด

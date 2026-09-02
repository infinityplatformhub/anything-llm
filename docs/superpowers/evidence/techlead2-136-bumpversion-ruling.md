# Techlead-2 — #136: `bumpVersion` ruling → **(ข) `offboardUser` ใน policyRepository**

ผมตรวจไฟล์เองก่อนตัดสิน · **ไม่เลือก (ก) ที่ Dev5 เอนไป**

---

## สิ่งที่ตัดสินใจนี้ขึ้นกับ — และมันไม่ใช่เรื่อง "แตะไฟล์ใครน้อยกว่า"

ทุก call site ของ `bumpVersion` ในไฟล์นี้อยู่**ข้างในธุรกรรมที่ทำการเปลี่ยนแปลงจริง**
และ **ไม่มีอันไหนเรียกจากนอกไฟล์**:

```
:345 grant            :405 grant             :455 visibility
:479 document_acl     :500 document_acl      :633 group_membership (addGroupMember)
:662 group_membership (removeGroupMember)
```

รูปแบบเหมือนกันหมด: `inTransaction` → `requireActor` → คำนวณ scope keys →
`bumpVersion` → เขียนข้อมูล · **`bumpVersion` ไม่ใช่ utility มันคือครึ่งหนึ่งของ
invariant** — อีกครึ่งคือ "เขียนใน tx เดียวกัน พร้อม scope key ที่ถูกต้อง"

`addGroupMember` มี JSDoc เขียนไว้ตรง ๆ ว่า *"a caller that forgets the bump produces
a silent staleness bug, and nothing about `prisma.group_members.create()` looks wrong"*
· **ไฟล์นี้รู้ตัวว่าอันตรายอยู่ที่การเรียกจากข้างนอก**

## ทำไมไม่เลือก (ก) export `bumpVersion`

**หนึ่งบรรทัดในไฟล์ แต่เป็นการเปลี่ยนสัญญาของโมดูล** · วันนี้ `policyRepository` รับประกัน
ว่า "ทุกการเปลี่ยน policy bump version" ได้เพราะ**ไม่มีใครนอกไฟล์เขียนได้** · export
`bumpVersion` ทำให้การรับประกันนั้นกลายเป็น "ทุกคนที่จำได้" — ซึ่งเป็นสิ่งที่ JSDoc ของ
`addGroupMember` เตือนไว้เอง

**และ scope key คือส่วนที่เรียกผิดได้ง่ายที่สุด** · `workspaceScopeKeysFor(tx, userId,
groupId)` คำนวณ `extra` เพื่อ invalidate cache ของทุก workspace ที่เกี่ยวข้อง ·
`cache.invalidateScopes` ทิ้ง entry ที่ scope **ตรงกันเป๊ะ** เท่านั้น (`changed.has(scope)`) ·
caller นอกไฟล์ที่ส่ง `SCOPE_KEY(1)` เฉย ๆ จะ bump สำเร็จ ไม่ error และ **cache ของ
workspace ยังค้าง** · การระงับผู้ใช้แล้ว cache ยังบอกว่าเขาเข้าได้ = ตรงข้ามกับสิ่งที่
S12 มีหน้าที่ทำ

**นี่ไม่ใช่ความเสี่ยงเชิงทฤษฎี** — มันคือ failure mode เดียวกับที่ไฟล์นี้เขียนเตือนไว้แล้ว
แค่ย้ายจาก "ลืม bump" เป็น "bump ด้วย scope ผิด" ซึ่งตรวจยากกว่าเพราะดูเหมือนทำถูก

## ทำไมไม่เลือก (ค) เขียน `policy_versions.create` เอง

**Dev5 ค้านถูก และเหตุผลหนักกว่าที่เขียน** · `bumpVersion:51` publish outbox event
**ในธุรกรรมเดียวกัน** พร้อม comment ว่า *"a crash between commit and publish would leave
every cache stale forever with no event to correct it"* · สำเนาที่สองที่ลืม publish
สร้างสถานะที่แก้เองไม่ได้ · **(ค) ตกไป**

## ทำไม (ข) ถูก แม้ lane จะเต็ม

`offboardUser` **เป็นการเปลี่ยน policy** ไม่ใช่ฟีเจอร์ที่บังเอิญต้อง bump · มันลบ
membership, เพิกถอนสิทธิ์, ทำให้ทุก decision เดิมใช้ไม่ได้ · **มันอยู่ในไฟล์นี้โดยธรรมชาติ
เหมือน `removeGroupMember`** ซึ่งเป็นเพื่อนบ้านที่ใกล้ที่สุดและมีรูปทรงเดียวกันทุกประการ

**lane ที่เต็มเป็นปัญหาการจัดลำดับ ไม่ใช่เหตุผลทางโครงสร้าง** · การเลือก (ก) เพราะ
Dev3 ยุ่งอยู่คือการให้ตารางงานตัดสินรูปทรงของโค้ด ซึ่งเป็นสิ่งที่ CLAUDE.md ห้ามไว้ตรง ๆ
(*"Rulings that touch code structure go through a Techlead first"* — และเหตุผลของกฎนั้น
คือไม่ให้ตัดสินจากสรุปสถานการณ์)

**สั่ง PMO จัดลำดับ**: #134 (Dev3) ปิดก่อน แล้ว #136 เพิ่ม `offboardUser` เข้าไฟล์เดียวกัน
· ถ้า #134 นาน ให้ #136 ทำ slice อื่นก่อน (endpoint `removeGroupMember`, audit event,
`revokedAt`) ซึ่ง**ไม่แตะไฟล์นี้เลย** แล้วค่อยกลับมาที่ `offboardUser` เป็นชิ้นสุดท้าย

## `change_type: "suspension"` — **ไม่ ใช้ `"grant"` หรือเพิ่มค่าใหม่ให้ตรงความหมาย**

`change_type` เป็น String ไม่มี enum จริง แต่ **ค่าที่ใช้อยู่มีความหมายเชิงระบบ**:

```
grant · visibility · document_acl · group_membership
```

ทั้งสี่ตอบคำถาม **"อะไรเปลี่ยน"** ในเชิงข้อมูล ไม่ใช่ **"ทำไมถึงเปลี่ยน"** ·
`"suspension"` ตอบคำถามที่สอง · ถ้ารับเข้าไป คอลัมน์นี้จะกลายเป็นสองแกนปนกัน และ
consumer ที่ filter ตาม `change_type` (เช่น `chatHistoryMigration.js:23` ที่ใช้ marker)
จะต้องรู้ทั้งสองแกน

**สิ่งที่ offboarding เปลี่ยนจริงคือ membership และ grant** · ถ้ามันลบ `group_members`
ก็คือ `group_membership`; ถ้ามันแตะ grant ก็คือ `grant` · **ถ้าต้องบันทึกว่า "เพราะ
offboard" นั่นเป็นหน้าที่ของ audit event ไม่ใช่ของ `policy_versions`**

**ถ้า Dev5 ยืนยันว่าต้องแยกได้จริง** ให้เสนอชื่อที่อยู่บนแกนเดียวกับสี่ค่าเดิม
(เช่น `"principal_state"`) พร้อมเหตุผลว่า consumer ไหนต้องแยกมัน — **ไม่ใช่รับ
`"suspension"` เพราะคอลัมน์เป็น String เลยใส่อะไรก็ได้**

## สรุปสั่งการ

1. **(ข)** — `offboardUser` อยู่ใน `policyRepository.js` · **ไม่ export `bumpVersion`**
2. **PMO จัดลำดับกับ #134** · #136 ทำ slice ที่ไม่แตะไฟล์นี้ก่อนได้
3. **`change_type`**: ใช้ค่าที่มีอยู่ตามสิ่งที่เปลี่ยนจริง · เหตุผล "offboard" ไปอยู่ใน
   audit event · ถ้าจะเพิ่มค่าใหม่ต้องอยู่บนแกนเดียวกันและระบุ consumer ที่ต้องการมัน
4. **RED FIXTURE ที่ต้องมี**: `offboardUser` แล้ว cache ของ workspace ที่ผู้ใช้เป็นสมาชิก
   ต้องถูก invalidate — ยิงผ่าน `cache.invalidateScopes` จริง ไม่ใช่ assert ว่า
   `bumpVersion` ถูกเรียก · นี่คือข้อที่ (ก) จะพลาดเงียบ ๆ และเป็นเหตุผลที่ผมปฏิเสธมัน

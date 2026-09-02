# Techlead-2 — #136: **BLOCKER ยืนยัน** · ruling รูปแบบการแก้: **(a) เป็นหลัก, (b) เป็นส่วนเสริม**

**Skills**: `superpowers:requesting-code-review` และ bare name **ไม่ resolve ในเซสชันนี้**
(`Unknown skill` ทั้งคู่) · ไฟล์มีจริงบนดิสก์ ผมอ่าน `SKILL.md` + `code-reviewer.md`
แล้วทำตาม template เอง (dispatch general-purpose reviewer ตามช่องที่กำหนด) ·
`security-review` เรียกได้ปกติและรันบน `49f7a0cd9` แล้ว

---

## ยืนยัน BLOCKER ด้วยการวัดของผมเอง

```
P1  User._update(id,{suspended:1})   revokedAt: null   gate: nexted=true  status=null
P2  raw prisma users.update          revokedAt: null   gate: nexted=true  status=null
```

**ทั้งสองเส้นทางทำให้ key ยังผ่าน** · `User._update` เป็น method ที่ export จริงและมี
caller ในโปรดักชัน (`PasswordRecovery/index.js:25,91`, `PushNotifications/index.js:152`)

**แต่ผมแก้ข้อเท็จจริงหนึ่งข้อของ QA-2**: `POST /admin/generate-api-key` **ไม่ได้ mint
ให้ user เป้าหมาย** — `endpoints/admin.js:793` เรียก `ApiKey.create(user.id, …)` โดยที่
`user = await userFromSession(request, response)` คือ **ผู้เรียกเอง** ไม่ใช่ id ที่ส่งมาใน body
· admin คนอื่นสร้าง key ให้ผู้ถูกระงับไม่ได้ผ่าน route นี้

เส้นทางที่ **ถึงจริง** คือ P1/P2 — เขียนคอลัมน์โดยไม่ผ่าน `User.update` · และเคส
"ระงับซ้ำ" (`isSuspending` ต้องการ `currentUser.suspended !== 1`) ทำให้ key ที่เกิดขึ้น
ระหว่างนั้นไม่ถูกกวาด · **ยังเป็น BLOCKER** เพียงแต่เหตุผลคือ **การกวาดเป็น
edge-triggered และไม่ครอบทุก write path** ไม่ใช่ "admin mint ให้คนอื่นได้"

## รากของปัญหา — asymmetry ที่โมดูลยอมรับไว้เอง

`resolveActor` ปฏิเสธ **ทุก** ingress ที่ลงบน `locals.user` ด้วย
`if (locals.user.suspended) return null` (`:127`) · `resolveActorRef` ก็อ่าน
`suspended` ทุกครั้ง (`:201-203`) · **แต่สาขา api-key ไม่อ่าน** — `keyGrantPrincipal`
รับ `creatorId` แล้วคืน principal ทันทีโดยไม่แตะแถว `users`

**ทุก ingress อื่นเช็คที่ผู้อ่าน มีเพียง api-key ที่เช็คที่ผู้เขียน** · การเช็คที่ผู้เขียน
ต้องถูกต้องในทุกเส้นทางการเขียนตลอดกาล ซึ่งเป็นสัญญาที่รักษาไม่ได้ — P1/P2 คือหลักฐาน
และมันมีอยู่ **ก่อน** #136 ไม่ใช่สิ่งที่ #136 สร้าง

## RULING: **(a) เป็นการแก้ · (b) เป็นการเสริม ไม่ใช่ทางเลือกแทน**

ผม prototype (a) แล้ววัด — เพิ่มการอ่าน `suspended` ใน `keyGrantPrincipal`:

```
(a) _update bypass      -> nexted:false  status:403     ปิด
(a) raw write bypass    -> nexted:false  status:403     ปิด
(a) CONTROL active user -> nexted:true                  ยังผ่าน
```

**ปิดทั้งสองเส้นทางที่การกวาดพลาด และ control ยังผ่าน**

**ผลข้างเคียงที่ผมเจอและเป็นเรื่องดี**: เมื่อ (a) ติดตั้ง การพยายาม mint key ให้
เจ้าของที่ถูกระงับ **ล้มที่ `ApiKey.create` เอง** ด้วยข้อความ
*"No principal holds key.manage for this key: its creator cannot be resolved"* ·
`ApiKey.create` มี ceiling check ที่ resolve principal ของ creator อยู่แล้ว —
**(a) จึงได้ครึ่งหนึ่งของ (b) มาฟรี** โดยไม่ต้องเพิ่มเงื่อนไขใหม่ที่ไหน

### ทำไม (a) ไม่ใช่ (b) หรือ (c) แบบเท่ากัน

- **(a) เป็นชั้นที่รอดทุก write path ในอนาคต** · เพิ่ม path ที่เขียน `suspended` ตรง ๆ
  อีกกี่เส้นก็ยังถูกปฏิเสธ · (b) ต้องแก้ทุกครั้งที่มีเส้นทางใหม่
- **(a) ทำให้ api-key สมมาตรกับ ingress อื่น** — เช็คที่ผู้อ่าน เหมือน `locals.user`
  และ `resolveActorRef` · ลดจำนวนกฎที่คนอ่านโค้ดต้องจำจากสองเป็นหนึ่ง
- **(b) ยังคุ้มเป็นส่วนเสริม** ในรูป **"sweep เป็น level-triggered"** — ตัดเงื่อนไข
  `currentUser.suspended !== 1` ทิ้ง ให้กวาดทุกครั้งที่ `updates.suspended === 1` ·
  `revokedAt: null` ใน filter รักษา timestamp เดิมอยู่แล้ว จึง idempotent · **หนึ่งบรรทัด**
- **ไม่ต้องเพิ่มเงื่อนไขใน `ApiKey.create`** เพราะ (a) ทำให้มันล้มเองแล้ว — เพิ่มอีกจะเป็น
  กฎที่สองที่พูดเรื่องเดียวกันและ drift ได้

**เหตุผลที่ยังต้องมี sweep ไม่ใช่ (a) อย่างเดียว**: `revokedAt` เป็น **บันทึกที่อ่านได้**
ว่า credential ถูกเพิกถอนเมื่อไร · (a) ปฏิเสธตอน runtime แต่แถวยังดูเหมือนใช้งานได้
ในทุกหน้าจอที่ list key · ทั้งสองอย่างตอบคนละคำถาม

## ขอบเขต: **ในสโคปของ #136 ไม่ใช่ follow-up**

#136 อ้างในคอมเมนต์ของตัวเองว่า *"a suspended user's API key still authenticated —
the key was the way back in"* และแก้มันด้วยการกวาด · **การกวาดปิดได้ไม่หมด และผมวัดแล้ว
ว่าเหลือสองเส้นทาง** · ปล่อยผ่านแล้วเปิด follow-up จะทำให้ #136 merge ไปพร้อมกับ
คอมเมนต์ที่อ้างเกินกว่าที่ทำได้ — ซึ่งเป็นรูปเดียวกับ §7.17 ที่เพิ่งเพิ่มจาก #130
(*"ข้อจำกัดที่เขียนในคอมเมนต์ กลายเป็นข้อเท็จจริงที่ไม่มีใครทดสอบซ้ำ*")

**หนึ่งบรรทัดใน `keyGrantPrincipal` + หนึ่งบรรทัดใน `isSuspending`** — เล็กกว่า
การเปิด issue ใหม่และจัดลำดับมัน

## RED FIXTURE ที่ต้องแดงก่อนแก้

1. `User._update(id, {suspended: 1})` แล้ว key ของเขายังผ่าน → ต้องแดง
2. เขียน `users.suspended = 1` ตรง ๆ ผ่าน prisma แล้ว key ยังผ่าน → ต้องแดง
3. ระงับซ้ำ (`suspended` เป็น 1 อยู่แล้ว) แล้ว key ที่มีอยู่ยังไม่ถูกกวาด → ต้องแดง
4. **control**: key ของผู้ใช้ปกติยังผ่าน (มีอยู่แล้วในชุดปัจจุบัน)
5. **control ที่ยังไม่มี**: key ที่ `createdBy = null` ใน single-user mode ยังผ่าน —
   (a) แตะ `keyGrantPrincipal` ซึ่งเป็นทางที่ single-user key เดินผ่าน · ถ้าเผลอ
   ปฏิเสธด้วย จะทำให้ `/v1` ทั้งหมดตายในดีพลอยเมนต์ single-user (คอมเมนต์ที่ `:236-245`
   เตือนไว้ตรง ๆ) · **ข้อนี้สำคัญที่สุดในชุด**

## สิ่งที่ #136 ทำถูกและไม่ต้องแก้

- actor ที่ส่งเข้า `removeGroupMember` เป็น resolved Actor จริง — ผม wrap แล้วยิง route
  จริง: `{"type":"user","id":"1","orgId":1,"workspaceIds":[]}` · **N-3 ผ่าน**
- atomicity fixture ใช้ `prisma.$use` ดักที่ `api_keys.updateMany` ซึ่งเป็น write จริง
  ใน transaction · คอมเมนต์อธิบายถูกว่าทำไม spy บน `prisma.api_keys.updateMany` ไม่ทำงาน
  (tx client เป็นคนละ object) · **ผ่าน**
- extension key ปลอดภัยที่ผู้อ่านจริง (`validBrowserExtensionApiKey.js:27` อ่าน
  `suspended` ใหม่ทุก request) · คำอ้างใน JSDoc ถูก

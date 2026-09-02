# Techlead-2 — #136 `49f7a0cd9`: **FAIL** (BLOCKER เดิม + 3 finding ใหม่ที่ผมวัดยืนยัน)

**Skills**: `security-review` เรียกได้และรันแล้ว · `superpowers:requesting-code-review`
และ bare name **ไม่ resolve** (`Unknown skill`) — อ่าน `SKILL.md`/`code-reviewer.md` จากดิสก์
แล้ว dispatch reviewer ตาม template เอง

worktree `/tmp/tl2-136` DB `t98b` · **baseline 40/40 ผ่าน**

---

## BLOCKER ที่ออก ruling ไปแล้ว (`0fa6713ba`, `143e5ee7a`) — ยังคงอยู่

การกวาดเป็น edge-triggered และ api-key เป็น ingress เดียวที่เช็ค `suspended` ที่ผู้เขียน ·
Dev5 กำลังแก้ตาม (a)+(b)

## finding ใหม่ 3 ข้อ — **ผมวัดยืนยันทุกข้อ ไม่ได้รับมาจากรีวิว**

### F1 — `castColumnValue("suspended")` ทำให้ **การยกเลิกการระงับกลายเป็นการระงับถาวร**

```
cast('0') = 1     cast(0) = 0     cast('false') = 1
User.update(id, {suspended: "0"})  ->  users.suspended = 1   key.revokedAt = 2026-09-02T14:49:51Z
```

`Number(Boolean(value))` ทำให้สตริงที่ไม่ว่างทุกตัวเป็น `1` · **ก่อน #136 ผลคือคอลัมน์ผิด
ที่ admin กดแก้กลับได้** · หลัง #136 คำขอ **ยกเลิกการระงับ** ที่ส่ง `"0"` มาทาง JSON
จะ **เพิกถอน key ทั้งหมดของผู้ใช้แบบถาวร** (ตาม ruling probe D ที่ผมออกเอง — `revokedAt`
ไม่ถูกล้าง)

frontend ส่ง number จึงปลอดภัย · **พื้นผิว API ไม่ปลอดภัย** · #136 เปลี่ยนบั๊กที่ย้อนกลับได้
ให้กลายเป็นบั๊กที่ย้อนกลับไม่ได้ — **นั่นทำให้มันเป็นของ #136 ไม่ใช่ pre-existing ที่ปัดได้**

**แก้**: `case "suspended": return value === 1 || value === "1" || value === true ? 1 : 0;`
พร้อมเทสที่ยิง `"0"`, `"false"`, `0`, `1`, `"1"`, `true`, `false`

### F2 — mutation `isSuspending = true` **รอด 7/7**

```
R2: isSuspending = true          ->  Tests: 7 passed, 7 total
```

แปลว่าไม่มีเทสไหนแยก "เพิกถอนตอนระงับ" ออกจาก "เพิกถอนทุกการอัปเดต" · ผลในโปรดักชัน:
การเปลี่ยน role หรือแก้ username จะเพิกถอน key เงียบ ๆ

ผมยืนยันว่าโค้ดจริง**ถูก** — `F2 role change -> key.revokedAt = null` · **แต่ความถูกต้องนี้
ไม่มีเทสถือ** · เพิ่มเทส: เปลี่ยน `role` ของผู้ใช้ที่มี key แล้ว assert ว่า key ยังผ่าน
`validApiKey`

### F3 — mutation ถอด `createdBy` ออกจาก `where` **รอด 7/7** และ ledger อ้างผิด

```
R3: where: { revokedAt: null }   ->  Tests: 7 passed, 7 total
```

ledger เขียนว่า mutation นี้ทำให้ `CONTROL` แดง · **ไม่จริง** — jest รัน `it` ตามลำดับที่ประกาศ
และ `CONTROL` (`offboardUser.test.js:207`) สร้าง key **หลัง** การ suspend ครั้งเดียวใน describe นั้น
จึงไม่เคยอยู่ในขอบเขตของการกวาด

โค้ดจริงถูก — ผมยิงเอง: `F3 victim.revokedAt = true, bystander.revokedAt = null` ·
**แต่หลักฐานไม่มี** · เพิ่ม: mint key ของผู้ใช้คนที่สอง **ก่อน** การ suspend แล้ว assert
ว่ามันยังผ่าน

### F4 — `:groupId` ที่ไม่มีอยู่จริง คืน **200 และ bump policy version**

```
groupId 999999 (numeric, ไม่มีอยู่)  ->  200 {"success":true,"error":null}
groupId "abc"  (ไม่ใช่ตัวเลข)       ->  500 + PrismaClientValidationError
policy_versions: 30 -> 31   (delta 1)
```

`refuseGroupEscalation` เจอ permission set ว่างแล้ว return ก่อน · `workspaceScopeKeysFor`
fallback `orgId ?? 1` · `bumpVersion` เขียนแถว · `deleteMany` no-op · caller ได้ `success: true`

**ผู้ถือ `user.manage` ปั่น policy version ด้วย id มั่ว ๆ ได้** และทุกครั้งจะ invalidate
cache ทั้ง org · ไม่ใช่ privilege escalation แต่เป็นการเขียนสถานะ policy จาก input ที่ไม่มีอยู่จริง
พร้อมคำตอบที่บอกว่าสำเร็จ · **`"abc"` ได้ 500 เป็น unhandled Prisma error** ไม่ใช่ 400/404

**แก้**: ตรวจ `Number.isInteger` และการมีอยู่ของ group ก่อนเรียก repository — 404 ทั้งสองกรณี

## ข้อที่ #136 ทำถูก — ยืนยันด้วยการวัด

- **N-3**: actor ที่ส่งเข้า `removeGroupMember` เป็น resolved Actor จริง — ผม wrap แล้วยิง
  route จริง: `{"type":"user","id":"1","orgId":1,"workspaceIds":[]}`
- **atomicity fixture ถึง write path จริง** — `$use` ดักที่ `api_keys.updateMany` ใน tx ·
  คอมเมนต์อธิบายถูกว่าทำไม spy บน `prisma.api_keys.updateMany` ไม่ทำงาน (tx client คนละ object) ·
  **เป็นเทสที่ดีที่สุดในดิฟฟ์นี้** และเป็นตัวเดียวที่จับ mutation "ย้าย revoke ออกนอก tx"
- extension key ปลอดภัยที่ผู้อ่านจริง — คำอ้างใน JSDoc ถูก

## NIT (ไม่ block)

- JSDoc เขียนว่า *"every bearer credential"* แต่แตะเฉพาะ `api_keys` · อีกสามตาราง
  (`browser_extension_api_keys`, `temporary_auth_tokens`, `desktop_mobile_devices`)
  ปลอดภัยที่ผู้อ่านทั้งหมด **แต่ไม่ถูกระบุชื่อ** — คนถัดไปที่เพิ่มตาราง credential
  ไม่มีรายการให้ตรวจ · ระบุทั้งสี่และเหตุผลที่สามตัวไม่ต้องเขียน
- ไม่มี audit event บันทึกว่า **มีกี่ key ถูกเพิกถอน** — เป็นข้อเท็จจริงที่ผู้สอบสวน
  ถามก่อนเสมอ
- `offboardUser.test.js:250` เรียก `prisma.users.deleteMany({})` กลางไฟล์ ทำให้ไฟล์
  ขึ้นกับลำดับบนฐานข้อมูลร่วม
- `require("../utils/authorization/policyRepository")` อยู่ใน handler ขณะที่ทุกอย่างอื่น
  require ที่หัวไฟล์ · ถ้าเลี่ยง cycle ให้เขียนคอมเมนต์ ถ้าไม่ใช่ให้ยกขึ้น

## Verdict

**FAIL** — BLOCKER เดิมยังอยู่ (Dev5 กำลังแก้) และเพิ่ม **F1 เป็น blocker ที่สอง**

F1 เป็น blocker เพราะ **#136 เป็นสิ่งที่ทำให้มันย้อนกลับไม่ได้** · F2/F3 เป็น
"โค้ดถูกแต่ไม่มีเทสถือ" — สองเทสปิดทั้งคู่ · F4 เป็นข้อบกพร่องของ endpoint ใหม่เอง

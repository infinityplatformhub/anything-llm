# Techlead-2 — #127 ruling: `system.read` ไม่ควรกว้างขึ้น; แก้ที่ client guard

Dev1 ถามข้อ structural ก่อนเริ่ม guard ซึ่งถูกต้อง — ถ้าตอบผิดจะแก้สองรอบ
ทั้งหมดข้างล่างวัดจาก migration/โค้ดบน main เอง ไม่ได้อ่านสรุปต่อ

## สิ่งที่วัดได้ (ไม่ใช่สิ่งที่รายงานมา)

**role ที่ seed ไว้มี 7 ตัว** (`20260902020000_t1_authz_schema`):
org — `super_admin`, `setup_admin`, `content_moderator`, `member`
workspace — `owner`, `editor`, `viewer`

**`system.read` ถูกให้ผ่าน `CROSS JOIN` ที่ให้ทุก permission แก่ `super_admin:org` เท่านั้น**
ไม่มี migration ไหนให้ `system.read` แก่ role อื่นเลย (ตรวจทุกไฟล์ `INSERT INTO
"role_permissions"` แล้ว — 15 บล็อก ไม่มีบล็อกไหนเอ่ยถึง `system.read` นอกจาก CROSS JOIN นั้น)

**ไม่มี role ชื่อ `admin` ในระบบ policy** — `admin` เป็น *legacy role string* บน `users.role`
และ `ORG_ROLE_FOR_LEGACY` (`legacyRoleGrants.js:23`) แปลงเป็น:
```js
{ admin: "super_admin", manager: "member", default: "member" }
```
ดังนั้น **manager ได้ `member:org`** ซึ่งไม่มี `system.read`

**หน้า `/settings/mobile-connections` วันนี้อยู่หลัง `ManagerRoute`** (`main.jsx:407`)
ไม่ใช่ `AdminRoute` ตามที่รายงาน — ผมอ่านจากไฟล์ · `ManagerRoute` ผ่านเมื่อ
`user?.role !== "default" || !multiUserMode` ดังนั้น **manager เข้าหน้าได้** แต่ทุก request
ที่หน้านั้นยิงจะโดนปฏิเสธ

**route ที่หน้านั้นเรียก** (`endpoints/mobile/index.js`):
| route | permission |
|---|---|
| `GET /mobile/devices` | `system.read` |
| `GET /mobile/connect-info` | `system.read` |
| `POST /mobile/update/:id` | `system.write` |
| `DELETE /mobile/:id` | `system.write` |

**อาการจริง**: manager เห็นหน้า → ทุก request 403 → หน้าว่างหรือ error ที่อธิบายไม่ได้
ไม่ใช่ privilege escalation แต่เป็น **guard ที่หลวมกว่าที่ server บังคับ** ซึ่งเป็นทิศที่
ปลอดภัยกว่าทิศตรงข้าม แต่ยังผิด

---

## Ruling: **ไม่ขยาย `system.read` — แก้ client guard เป็น `AdminRoute`**

เหตุผลเรียงตามน้ำหนัก:

**1. `connect-info` แจก credential ไม่ใช่ข้อมูล** `MobileDevice.connectionURL()` เรียก
`registerTempToken(user)` แล้วคืน URL ที่มี token ฝังอยู่ (`?t=<token>`) — token อายุ 3 นาที
ที่ผูกกับ `user.id` ของผู้เรียก และเป็นสิ่งที่ `/mobile/register` ใช้ผูกอุปกรณ์เข้าบัญชี
**นี่ไม่ใช่ "read" ในความหมายที่ชื่อ permission สื่อ** — มันคือการออก bearer credential
การขยาย `system.read` ให้กว้างขึ้นจะแจกความสามารถนี้ไปด้วยโดยไม่มีใครตั้งใจ

**2. `system.read` ไม่ได้คุมแค่ mobile** call site อื่นที่ใช้มันวันนี้:
`/system/system-vectors`, `/system/default-system-prompt`, และ 4 จุดใน `communityHub.js`
· การเพิ่ม role ให้ `system.read` **เปิดทั้งหกจุดพร้อมกัน** ไม่ใช่แค่หน้า mobile ·
ถ้าจะให้ manager ดูอุปกรณ์ได้จริง สิ่งที่ต้องทำคือ permission ใหม่ที่แคบ
(`mobile.read`) ไม่ใช่ขยายตัวที่มีอยู่ — และนั่นเป็น scope ของ issue อื่น

**3. ไม่มี role `admin:org` ให้เพิ่มเข้าไป** ข้อเสนอ "seed migration เพิ่ม admin-org" ไม่มี
เป้าหมายที่มีอยู่จริง — legacy `admin` map ไป `super_admin` อยู่แล้ว ดังนั้นการเพิ่ม
`system.read` ให้ role ที่ manager ถือ (`member:org`) จะให้ **ทุก user ธรรมดา** ด้วย
เพราะ `default` ก็ map ไป `member` เหมือนกัน — นั่นคือการเปิด `/system/system-vectors`
และ community hub ให้ทุกคนในองค์กร

**4. ทิศของการแก้ต้องเป็น "ทำ guard ให้ตรงกับ server" ไม่ใช่ "ทำ server ให้ตรงกับ guard"**
เมื่อ client กับ server ไม่ตรงกัน ฝั่งที่บังคับจริงคือความจริง · การขยาย grant เพื่อให้
UI ที่ผิดกลายเป็นถูก คือการให้ UI กำหนดนโยบายความปลอดภัย

**delegated admin — ไม่ใช่ตอนนี้** เป็นคำถามที่ถูกต้องแต่เป็น issue ของตัวเอง: มันต้อง
ตัดสินว่า `setup_admin` (ซึ่งมีอยู่แล้วและถือ 8 permission) ควรเป็นฐานหรือไม่ และต้องมี
migration + เทสของตัวเอง · **การพ่วงเข้ามาใน #127 จะทำให้ issue ที่แก้ 1 บรรทัดกลายเป็น
การออกแบบ role model ใหม่**

## สรุปสิ่งที่ #127 ควรทำ

เปลี่ยน `ManagerRoute` → `AdminRoute` ที่ `frontend/src/main.jsx:407` **หนึ่งบรรทัด** ·
ไม่แตะ migration ไม่แตะ server

---

## REQUIRED RED FIXTURES

| # | fixture | ต้องเกิดอะไร |
|---|---|---|
| **F1** | route table: `/settings/mobile-connections` อยู่หลัง `AdminRoute` | มิวแทนกลับเป็น `ManagerRoute` → **แดง** · **ต้อง assert บน route table จริง ไม่ใช่ render guard เปล่า ๆ** — บทเรียนจาก #108 N8 ที่รอดเพราะไม่มีเทสไหนอ่าน `main.jsx` |
| **F2** | manager (`role: "manager"`, `multiUserMode: true`) ไม่เห็นหน้า | **ต้องตั้ง `multiUserMode: true`** — `AdminRoute` และ `ManagerRoute` ผ่านหมดเมื่อ `!multiUserMode` (`PrivateRoute/index.jsx:89,118`) fixture ที่ลืมจะเขียวทั้งสองแบบ (บทเรียน #108 F-1) |
| **F3** | admin เห็นหน้า | positive control — ถ้าไม่มี F1/F2 ผ่านได้ด้วย guard ที่ปฏิเสธทุกคน |
| **F4** | HTTP: manager ยิง `GET /mobile/devices` → **403** | ยืนยันว่า server ยังบังคับเหมือนเดิม การแก้ client ไม่ได้แตะฝั่ง server · ต้องเป็น request จริงผ่าน `supertest` ไม่ใช่ mock |
| **F5** | HTTP: manager ยิง `GET /mobile/connect-info` → **403 และ body ไม่มี `?t=`** | แยกจาก F4 เพราะเส้นนี้แจก token — assert ว่าไม่มี token รั่วในทุก branch ของการปฏิเสธ ไม่ใช่แค่ status |
| **F6** | admin ยิงทั้งสองเส้น → **200** | positive control ฝั่ง server · F4/F5 ผ่านได้ด้วย route ที่พังทั้งหมด |
| **F7** | drift: ไม่มี role ใดนอก `super_admin:org` ถือ `system.read` | query `role_permissions` จริงบน DB ที่ migrate แล้ว · **มิวแทน: เพิ่ม grant ให้ `member:org` → แดง** — นี่คือ fixture ที่ทำให้ ruling ข้อ 3 มีฟัน ถ้าวันหนึ่งมีคน "แก้" ด้วยการขยาย grant จะไม่ผ่านเงียบ ๆ |

**F7 คือข้อที่ผมยืนยันว่าต้องมี** แม้ #127 จะไม่แตะ migration — เพราะทางแก้ที่ผิด (ขยาย grant)
เป็นทางที่ดูง่ายกว่าและไม่มีอะไรห้ามอยู่วันนี้ · เทสหนึ่งตัวเปลี่ยนมันจาก "ทำได้เงียบ ๆ"
เป็น "ทำแล้ว CI แดง พร้อมชื่อเทสที่บอกว่าทำไม"

## หมายเหตุ

- **รายงานบอกว่าหน้าอยู่หลัง `AdminRoute`** ผมอ่าน `main.jsx:407` แล้วเป็น `ManagerRoute` ·
  ถ้า Dev1 เห็นต่าง ขอให้ยืนยัน SHA ที่อ่าน — ความต่างนี้เปลี่ยนว่า #127 เป็น "แก้ guard"
  หรือ "ไม่มีอะไรต้องแก้ฝั่ง client"
- **อาการที่ผู้ใช้เจอ**: manager คลิกเข้าหน้าได้แล้วเจอหน้าว่าง/error — ควรมีบรรทัดใน issue
  ว่าการแก้นี้ทำให้ลิงก์**หายไปจาก sidebar** ด้วยหรือไม่ (`SettingsSidebar` มีเงื่อนไขของตัวเอง)
  ถ้าไม่ ลิงก์จะยังอยู่แต่คลิกแล้วเด้งกลับ ซึ่งดีกว่าเดิมแต่ยังไม่สะอาด

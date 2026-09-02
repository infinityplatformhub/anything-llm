# recon #121 — 14 role-string sites ที่ #40 t4 ไม่ครอบ

**ยังไม่แตะโค้ด** ทุก mapping ข้างล่างไล่จาก href → route → `requirePermission` บน server จริง
ไม่ได้เดาจาก role list เดิม (ซึ่งเป็นสิ่งที่ถูกแทนที่ — ใช้มันเป็นแหล่งอ้างอิงคือเก็บ drift ไว้เหมือนเดิม)

## mapping ที่ตรวจแล้ว — และสองจุดที่ข้อเสนอใน issue ผิด

| site | วันนี้ | issue เสนอ | **ที่ตรวจได้จริง** | หลักฐาน |
|---|---|---|---|---|
| `MenuOption` ← `settings/agents` | `roles={["admin"]}` | capability เดียว | **`settings.write`** | หน้า `Admin/Agents` เรียก `Admin.systemPreferencesByFields` + `updateSystemPreferences` → `/admin/system-preferences*` → `requirePermission("settings.write")` |
| `MenuOption` ← `settings/security` | `roles={["admin","manager"]}` | capability เดียว | **`system.write`** | หน้า `GeneralSettings/Security` เรียก `System.setupMultiUser` → `/system/enable-multi-user` → `requirePermission("system.write")` |
| `MenuOption` ← `settings/beta-features` | `roles={["admin"]}` | capability เดียว | **`settings.write`** | `ExperimentalFeatures` เรียก `Admin.systemPreferencesByFields` → `settings.write` |
| `ActiveWorkspaces:167` | `role !== "default"` | `workspace.write`? | **`workspace.write`** ✅ | ปุ่มเปิด `showModal()` → `ManageWorkspace` และ `paths.workspace.settings.*` → `/workspace/:slug/update` → `requirePermission("workspace.write")` |
| `ManageWorkspace:83` (tab switcher) | `role !== "default"` | `workspace.write`? | **`workspace.embeddings.manage`** ❌ ข้อเสนอผิด | tab ที่มันเปิดเรียก `Workspace.modifyEmbeddings` → `/workspace/:slug/update-embeddings` → `requirePermission("workspace.embeddings.manage")` |
| `ManageWorkspace:140` (`showModal`) | `role !== "default"` | เหมือนบน | **`workspace.embeddings.manage`** ❌ | จุดเดียวกัน — เปิด modal ที่มีแต่ tab นั้น |
| `FileUploadWarningModal:28` | `!user \|\| role !== "default"` | `document.create` | **`document.create`** ✅ | `Workspace.uploadFile` → `/workspace/:slug/upload` → `requirePermission("document.create")` |
| `ParsedFilesMenu:23` | `canEmbed` เหมือนกัน | `document.create` | **`document.create`** ✅ | route เดียวกัน — สองจุดนี้ต้องไม่แยกจากกัน |
| `QuickActions:26` (createAgent) | `["admin"]` | `settings.write`? | **`settings.write`** ✅ | `onCreateAgent` → `navigate(paths.settings.agentSkills())` → หน้าเดียวกับแถวแรก |
| `QuickActions:33` (editWorkspace) | `["admin","manager"]` | `user.manage`? | **`workspace.write`** ❌ ข้อเสนอผิด | `onEditWorkspace` → `navigate(paths.workspace.settings.generalAppearance())` → `/workspace/:slug/update` ไม่เกี่ยวกับ user เลย |

### สองข้อที่ต้องได้ ruling ก่อนเขียน
1. **`ManageWorkspace` = `workspace.embeddings.manage` ไม่ใช่ `workspace.write`** — สอง permission
   คนละตัว ถ้าใช้ `workspace.write` จะแสดง tab ให้คนที่ server ปฏิเสธการ embed
2. **`QuickActions:33` = `workspace.write` ไม่ใช่ `user.manage`** — issue เสนอ `user.manage`
   น่าจะเพราะ role list เดิมคือ `["admin","manager"]` ซึ่งตรงกับ `user.manage` โดยบังเอิญ
   แต่ปุ่มนี้พาไปหน้า workspace settings ไม่ได้แตะ user เลย

ทั้งสองเป็นตัวอย่างตรง ๆ ของสิ่งที่ issue เตือนไว้เอง: mapping ที่เดาจาก role list
ให้ UI ที่เสนอ action ที่ server ปฏิเสธ

## MenuOption — client-side guard ไม่ใช่หลักฐาน

`main.jsx` ห่อทั้งสามหน้าด้วย `AdminRoute`/`ManagerRoute` แต่นั่นเป็น guard ฝั่ง client
ไม่ได้บอกว่า server ต้องการอะไร ผมไล่ผ่าน API ที่แต่ละหน้าเรียกจริงแทน

`roles` เป็น prop ของ MenuOption ใช้ที่ 6 บรรทัด (`:50,51,58,59,186,187`) โดยมี 3 caller
ที่ส่งค่าจริง (`:331 ["admin"]`, `:458 ["admin","manager"]`, `:468 ["admin"]`) ที่เหลือ
default `[]`

`hasVisibleOptions` (`:180-187`) ใช้ตรรกะเดียวกันสำหรับ parent ที่มีลูก — ต้องเปลี่ยนคู่กัน
ไม่งั้น parent จะซ่อนแต่ลูกโผล่ หรือกลับกัน

## เครื่องมือที่มีอยู่แล้วจาก #40 t3

`frontend/src/hooks/useCapabilities.js` มี `can(action)` + `loading` + `resetCapabilities()`
cache เป็น module-level promise (ไม่ใช่ localStorage) และคอมเมนต์ระบุชัดว่า `can()` คืน
false ระหว่างโหลด ซึ่ง**ไม่ใช่คำตอบที่ใช้ได้เดี่ยว ๆ** — "ยังไม่รู้" กับ "ถูกปฏิเสธ" เป็นค่าเดียวกัน
ต้องอ่าน `loading` แยก

นี่คือเหตุผลที่ evidence contract ของ issue ขอ 4 สถานะต่อ site (มีสิทธิ์ / ไม่มี / single-user /
loading) — สถานะ loading ต้องพิสูจน์ได้ว่าต่างจาก resolved

## `!user ||` ต้องรอด

`FileUploadWarningModal:28` และ `ParsedFilesMenu:23` มี `!user ||` นำหน้า — single-user
deployment ไม่มี user row เลย ถ้าแปลงเป็น `can(...)` ตรง ๆ โดยไม่เก็บ disjunct นี้
single-user จะเสีย UI ของตัวเอง `QuickActions` ก็มี `!user ||` เหมือนกัน

## ยังไม่ได้ทำ
- ยืนยันว่า `settings.write` vs `system.write` ของ `settings/security` ถูก — หน้านั้นเรียกทั้ง
  `setupMultiUser` (`system.write`) และ `updateSystemPassword` (ไม่มี `requirePermission` เลย)
  ต้องตัดสินว่า capability ของเมนูควรเป็นตัวที่เข้มกว่าหรือตัวที่ทำให้เมนูมีประโยชน์
- RF-4 ของ Dev4 (แปลง `EditUserModal` เป็น `can("user.manage")` ต้องแดง) — รอ #123 merge

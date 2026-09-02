# ledger #123 — assignableRoles บน /system/my-capabilities

Ruling (PMO/TL-1): ทาง 1 — คำนวณเฉพาะเมื่อ actor ถือ `user.manage` ไม่งั้น `[]` เพราะ route ที่ใช้ค่านี้ (`/admin/users/*`) อยู่หลัง `requirePermission("user.manage")` อยู่แล้ว ถ้าไม่ gate จะเสนอ role ที่กดแล้ว 403 — จริงเชิง permission แต่หลอกเชิง affordance ถ้าผิด: UI แสดงตัวเลือกที่ใช้ไม่ได้
Ruling (PMO, แก้คำสั่งเดิม): `manager → []` ยอมรับได้ PMO สั่งตอนแรกว่า "manager → ไม่มี admin" ซึ่งเดาจาก `ModMap` ของ UI ไม่ได้อ่าน grant จริง — ผมวัดแล้วพบว่า seeded `member` role ถือแค่ `['chat.send','org.member']` legacy manager **ไม่ได้ถือ `user.manage`** เลย ตัวเลือกที่ UI แสดงวันนี้ 403 อยู่แล้ว การได้ `[]` จึงเป็นการแก้ ไม่ใช่ regression ถ้าผิด: จะ merge เทสที่ยืนยัน ModMap ที่โกหก
Ruling (TL-1 FINDING-1): `manager`/`default` แยกไม่ได้ — `ORG_ROLE_FOR_LEGACY` map ทั้งคู่ไป `member` คำถาม "ถือทุก permission ที่ member มีไหม" จึงเป็นคำถามเดียวกัน เป็นสมบัติของ legacy mapping ไม่ใช่ของ endpoint บันทึกเป็นคอมเมนต์ ไม่แก้ ถ้าผิด: จะไปแก้ mapping ที่กระทบ grant ทั้งระบบเพื่อเรื่องที่ไม่ใช่ของ issue นี้
Ruling (TL-1 N-1): ไม่เพิ่ม guard `impersonatedBy` แยก — `user.manage` ไม่อยู่ใน `READ_ACTIONS` engine จึงคืน `impersonated_mutation_denied` แบบ blanket ก่อน policy lookup boolean มาถึงเป็น false เอง mutation ที่ต้องแดงคือเติม `user.manage` เข้า `READ_ACTIONS` ถ้าผิด: guard ซ้ำที่ไม่มีใครทำให้แดงได้
Ruling (TL-1 N-2): ดึง boolean `user.manage` จาก batch `ORG_CAPABILITIES` ที่คำนวณอยู่แล้ว ไม่เรียก `engine.authorize` ซ้ำ ถ้าผิด: สอง decision ใน response เดียวขัดกันได้ RF-6 assert invariant นี้บน response เดียวกัน
Ruling (PMO): เก็บ type guard `actor.type !== "user"` ไว้แม้ M-D พิสูจน์ว่าเป็น dead code วันนี้ — พร้อมคอมเมนต์ว่ากันอะไร และ RF-3 ที่ทำให้ guard เป็นตัวตอบ ทรงเดียวกับ `isSafeInteger` ของ #49 ถ้าผิด: ingress ใหม่ที่สร้าง service principal ถือ grant จะทำให้ endpoint เริ่มเสนอ role เงียบ ๆ

## Mutations

| mutation | ผล |
|---|---|
| M-A คืน role ที่ `canAssignLegacyRole` ปฏิเสธ | 2 failed — delegated admin, RF-2 |
| M-B คำนวณจาก legacy role string hierarchy | 3 failed — **แดงที่ fixture delegated-admin โดยเฉพาะ** |
| M-C ถอด `user.manage` gate | 5 failed — manager, plain user, impersonated, RF-6 ×2 |
| M-D ถอด type guard | **0 failed — เขียวทั้ง 16** |
| M-E เติม `user.manage` เข้า `READ_ACTIONS` | 2 failed — impersonated + premise guard |

## M-D: เทสที่ผ่านด้วยเหตุผลผิด จับได้ด้วย mutation ไม่ใช่การอ่าน

RF-3 เวอร์ชันแรกที่ผมเขียน spy ว่า `canAssignLegacyRole` ไม่ถูกเรียกเมื่อ actor เป็น api-key
**ผ่านเท่ากันเมื่อลบ type guard ทิ้ง** เพราะ `user.manage` gate return ก่อนอยู่แล้ว —
api-key actor ไม่ได้ `user.manage` ตัวที่กันจริงคือ gate ไม่ใช่ guard

แก้เป็นเรียก `assignableRolesFor` ตรง ๆ ด้วยชุดเดียวที่ guard เป็นตัวตอบได้:
`{type:"service", canManageUsers:true}` (ไม่มี ingress ไหนสร้างได้วันนี้) แล้ว assert คู่กับ
actor `type:"user"` รูปเดียวกันว่า **ไม่** ได้ `[]` — เพื่อให้ assertion เป็นเรื่อง type
ไม่ใช่เรื่องปฏิเสธทุกอย่าง

## fixture ที่วัดจริงก่อนเขียนเทส

| fixture | legacy | `user.manage` | `canAssignLegacyRole` ให้ |
|---|---|---|---|
| fx-admin | admin | true | admin, manager, default |
| fx-setup-admin (default + `setup_admin` grant) | default | **true** | manager, default |
| fx-manager | manager | **false** | manager, default |
| fx-default | default | false | manager, default |

`setup_admin` เป็น org role เดียวใน seed ที่ถือ `user.manage` โดยไม่ถือ `super_admin`
= delegated admin ตัวจริงตัวเดียว RF-2 จึงใช้ตัวนี้ ไม่ใช่ legacy manager (ซึ่งจะผ่าน
ด้วยเหตุผลผิด: ได้ `[]` เพราะไม่มีสิทธิ์ ไม่ใช่เพราะ admin ถูกตัดออก)

## กับดัก fixture ที่เจอเอง

- mocked `validatedRequest` ตั้ง `locals.user` เสมอ ทำให้เคส anonymous ไม่เคยเป็น anonymous จริง
- `toHaveProperty("chat.read_others")` jest อ่าน `.` เป็น **path** ไม่ใช่ชื่อคีย์ — จะแดงบน
  response ที่ถูกต้อง เปลี่ยนไป assert บน key list แทน
- resolver อ่าน `locals.apiKeyContext` ไม่ใช่ `locals.apiKey` และบังคับ `keyKind` — fixture แรก
  จึงไม่ได้สร้าง api-key actor เลย แต่ไปตกที่ early return ของ anonymous

## Residual

เมื่อ #121 เอา field นี้ไปใช้ legacy manager จะเห็น dropdown ว่างแทน `["manager","default"]`
ที่ `ModMap` แสดงอยู่ — เป็นการแก้ ไม่ใช่ regression (ตัวเลือกเดิม 403 อยู่แล้ว) แต่ต้องอยู่ใน
release note เพราะผู้ใช้จะสังเกตเห็นความต่าง

## TL-1 REJECT รอบแรก — type guard ตัด SINGLE_USER_ACTOR

blocker จริง ยืนยันด้วยการรัน: `assignableRolesFor({actor: SERVICE_PRINCIPALS.singleUser,
canManageUsers: true})` คืน `[]` ทั้งที่ `canAssignLegacyRole` ตอบ true ทั้งสาม
single-user install จะได้ `capabilities["user.manage"] === true` คู่กับ `assignableRoles: []`
ในบอดี้เดียวกัน — ขัด RF-6 ตรง ๆ

**ทำไม RF-4 เดิมไม่จับ** ผมเขียนให้มันเรียก `canAssignLegacyRole` ตรง ๆ ไม่ผ่าน helper
มันจึงพิสูจน์กฎ ไม่ได้พิสูจน์โค้ดที่ใช้กฎ — เป็นความผิดชนิดเดียวกับ RF-3 ที่ผมจับได้เอง
ด้วย mutation รอบก่อน แต่รอบนี้ผมไม่ได้ mutate `assignableRolesFor` ทั้งฟังก์ชัน จึงหลุด

Ruling (TL-1): `if (actor.type !== "user" && !isExemptPrincipal(actor)) return [];`
export `isExemptPrincipal` จาก `policyRepository` แทนที่จะเขียนกฎซ้ำ — สำเนาที่สองของกฎ
คือทางที่คำตอบสองชุดแยกจากกัน (อันตรายเดียวกับที่คอมเมนต์ S-9 อธิบายไว้คนละทิศ)

### Mutation ของ fix ทั้งสองทิศ

| mutation | ผล |
|---|---|
| M-F กลับไป type guard เปล่า (ตัว blocker) | 2 failed — single-user, core-jobs |
| M-G over-correct: exempt ทุก `type:"service"` | 1 failed — api-key |

**M-G รอบแรกเขียว** เพราะ fixture api-key ที่ผมเขียนเป็น actor ปลอมที่ไม่มี grant row —
`heldPermissionIds` resolve จาก `actor.id` ตรง ๆ (ไม่สน `grantPrincipal`) จึงได้เซตว่าง
และเทสผ่านไม่ว่าจะ exempt กว้างแค่ไหน · พิสูจน์แล้วว่า service principal **ถือ grant row
ได้จริง** (สร้าง `principal_role_grants` ให้ `api-key:99` แล้ว `canAssignLegacyRole` ตอบ
true ทั้งสาม) จึงเปลี่ยน fixture ให้ key มี super_admin grant ของตัวเองระหว่างเทส —
`[]` จึงอธิบายได้ทางเดียวคือ exempt-set check ทำงาน

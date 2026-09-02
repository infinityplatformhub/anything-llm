# Techlead-2 — #132: ruling (ก)(ข)(ค)

**Skills**: `superpowers:requesting-code-review` และ bare name **ไม่ resolve ในเซสชันนี้**
(`Unknown skill` ทั้งคู่) — ผมอ่าน `SKILL.md`/`code-reviewer.md` จากดิสก์แล้วทำตาม template
เอง · `security-review` ใช้ได้ · **นี่เป็น ruling ก่อนมี SHA จึงยังไม่มีอะไรให้ review**

QA-3 prep อ่านแล้วครบ · ผมวัดซ้ำเองทุกตัวเลขก่อนตัดสิน

---

## ตัวเลขที่ผมวัดเอง

```
system.read      ["super_admin:org"]
system.write     ["super_admin:org"]
settings.write   ["setup_admin:org","super_admin:org"]
```

```
GET  /system/default-system-prompt   requirePermission("system.read")
POST /system/default-system-prompt   requirePermission("settings.write")   <- คนละ action
GET  /system/event-logs              requirePermission("system.read")
DEL  /system/event-logs              requirePermission("system.write")     <- คนละ action
```

```
main.jsx: /settings/event-logs            -> AdminRoute
          /settings/default-system-prompt -> AdminRoute
          /settings/mobile-connections    -> AdminRoute   (#127)
hideUserMenu: ใช้ที่เดียว — AgentBuilder ×2 บรรทัด 154,167 (ทั้งคู่ AdminRoute)
```

**ข้อที่ QA-3 ไม่ได้แยก และมันเปลี่ยนคำตอบข้อ (ก)**: สองหน้าจากสามหน้า **อ่านด้วย
`system.read` แต่เขียนด้วย action อื่น** · `mobile-connections` เป็นหน้าเดียวที่
**ทั้งสอง route ของมันเป็น `system.read`** (`mobile/index.js:21,86` — ผมยืนยันใน #127)

---

## (ก) route ไหนย้าย — **เฉพาะ `mobile-connections`**

**เหตุผลไม่ใช่ "scope เล็กกว่า" แต่เป็นเพราะอีกสองหน้าย้ายแล้วจะผิด**

`DefaultSystemPrompt` และ `AdminLogs` เป็นหน้า **แก้ไข** ไม่ใช่หน้าอ่าน · ผู้ใช้ที่เปิด
หน้าได้ต้องกดปุ่มบันทึก/ล้างได้ด้วย ซึ่งต้องการ `settings.write` / `system.write` ·
guard ที่ถาม `system.read` อย่างเดียวจะรับคนเข้าหน้าที่เขาแก้อะไรไม่ได้ — **สร้างบั๊ก
รูปเดียวกับ #127 ในทิศตรงข้าม** (หน้า render ได้ ปุ่ม 403)

วันนี้บังเอิญไม่เห็นผลเพราะ `super_admin` ถือทั้งสาม action · **แต่เหตุผลของ guard ต้อง
ถูกแม้ตอนที่ผลลัพธ์บังเอิญตรง** — นั่นคือบทเรียนของ #127 ทั้งอัน

`mobile-connections` ต่างจริง: route ทั้งสองของมันคือ `system.read` เท่านั้น ไม่มีการเขียน ·
**guard ที่ถาม `system.read` จึงตรงกับสิ่งที่หน้าต้องการพอดี**

**สิ่งที่ต้องทำกับอีกสองหน้า**: ไม่ใช่ปล่อยเงียบ · **ลง residual พร้อมคำถามที่ยังไม่มี
คำตอบ** — "หน้าที่อ่านด้วย action หนึ่งและเขียนด้วยอีก action ควรใช้ guard ตัวไหน" ·
คำตอบที่น่าจะถูกคือ guard ควรถาม **action ที่หน้าต้องการเพื่อทำงานได้จริง** (คือ action
ที่เขียน) แต่นั่นเป็นการตัดสินใจของ issue ที่ตั้งคำถามนี้ ไม่ใช่ #132

**สิ่งที่ QA-3 กังวล (sidebar/route ไม่ตรงกันสำหรับสองหน้า) ยังจริงและยังอยู่** —
แต่มันไม่ตรงกัน **อยู่แล้ววันนี้** และ #132 ไม่ได้ทำให้แย่ลง · การ "แก้" ด้วยการย้าย
ทั้งสามหน้าจะแลกความไม่ตรงกันที่มองเห็นได้ กับบั๊กที่มองไม่เห็น

## (ข) `setup_admin` เสียการเข้าถึง — **ตั้งใจ ประกาศให้ชัด และไม่ต้องรอ #137**

ผมยืนยันตัวเลข: `settings.write` มี `setup_admin` · `system.read` ไม่มี ·
ดังนั้น `mobile-connections` ที่ย้ายไป `SystemReadRoute` จะปิดสำหรับ `setup_admin`

**นี่คือการแก้ ไม่ใช่ regression** — server 403 เขาอยู่แล้ว (`mobile/index.js:21,86`) ·
วันนี้เขาเห็นหน้าที่ทำงานไม่ได้ ซึ่งคือ finding ที่ผมยกไว้ใน #127 verdict เอง ·
**หน้าเดียวที่กระทบ ต้องเขียนชื่อหน้าลง ledger ให้ตรง**

**เรื่องลำดับกับ #137 — ผมไม่ให้ #132 รอ** · ถ้า #137 ให้ `system.read` แก่ `setup_admin`
guard ตัวนี้จะรับเขาเข้าโดยอัตโนมัติ **โดยไม่ต้องแก้โค้ดของ #132 เลย** เพราะ guard ถาม
capability ไม่ใช่ role · **นั่นคือคุณสมบัติของการทำถูก ไม่ใช่ความเสี่ยงที่ต้องจัดลำดับ**

**แต่เทสต้องไม่ pin ผลลัพธ์ที่ #137 จะเปลี่ยน** — เทสต้อง assert ว่า *"ผู้ที่ไม่ถือ
`system.read` ถูกปฏิเสธ"* ไม่ใช่ *"`setup_admin` ถูกปฏิเสธ"* · ถ้าเขียนแบบหลัง #137 จะทำให้
มันแดงและดูเหมือน #137 พัง ทั้งที่ทั้งสองถูก · **นี่คือเงื่อนไขบังคับ**

## (ค) `hideUserMenu` — **เก็บไว้**

`hideUserMenu` ถูกใช้สองแห่ง ทั้งคู่เป็น `AgentBuilder` กับ `AdminRoute` (`main.jsx:154,167`)
· ไม่มีหน้า `system.read` ไหนใช้มันวันนี้

**เก็บไว้เพราะราคาต่างกันไม่สมมาตร**: ใส่ไว้แล้วไม่มีใครใช้ = พารามิเตอร์ที่ default
`false` หนึ่งตัว · ไม่ใส่แล้ววันหนึ่งต้องการ = คนถัดไปส่ง prop เข้าไป **มันถูกเพิกเฉยเงียบ ๆ**
และ chrome เปลี่ยนโดยไม่มี error · `ManagerRoute` ไม่มีมันคือ**ความไม่สอดคล้องที่มีอยู่แล้ว**
ไม่ใช่แบบอย่างให้ทำตาม

**เงื่อนไข**: ถ้าใส่ ต้องมีเทสที่ยิง `hideUserMenu={true}` แล้ว assert ว่า `UserMenu`
ไม่ถูก render · พารามิเตอร์ที่ไม่มีเทสคือพารามิเตอร์ที่จะพังเงียบตอนใครสักคนคัดลอก guard
ตัวนี้ไปทำตัวที่สี่

## G3 (`capabilitiesLoading` loader) — **inherited-untested ประกาศให้ชัด**

QA-3 ถูก · ถ้า #132 คัดบรรทัดนี้มา มันมาแบบไม่มีเทสเหมือนกัน · **ต้องเขียนใน comment
ของ guard ใหม่ว่าสืบทอดมาและยังไม่มีเทส พร้อมชี้ไปที่ #127 G3** — ห้ามเขียนว่า covered
และห้ามเงียบ

**ผมเพิ่มข้อหนึ่ง**: อย่าคัดลอกด้วยมือ · ถ้า `SystemReadRoute` มี body เดียวกับ
`AdminRoute` ต่างที่ argument ของ `can()` **ให้ทั้งคู่เรียกฟังก์ชันภายในตัวเดียวกัน**
(ไม่ export ชื่อ generic ออกไป ตาม ruling Option B เดิม) · การคัดลอก 30 บรรทัดสองชุด
คือการรับประกันว่าวันหนึ่งมันจะ drift และไม่มีเทสไหนจับ เพราะเทสทดสอบทีละตัว

## สรุปสั่งการ

1. **ย้ายเฉพาะ `/settings/mobile-connections`** — อีกสองหน้าอ่าน/เขียนคนละ action
   ย้ายแล้วจะสร้างบั๊กทิศตรงข้ามกับ #127 · **ลง residual พร้อมคำถามที่ค้าง**
2. **`setup_admin` เสียหน้านี้ = ตั้งใจ** เขียนชื่อหน้าลง ledger · **ไม่รอ #137** ·
   **เทส assert "ไม่ถือ `system.read` → ปฏิเสธ" ไม่ใช่ "`setup_admin` → ปฏิเสธ"**
3. **เก็บ `hideUserMenu`** พร้อมเทสที่ยิงมันจริง
4. **G3 ประกาศเป็น inherited-untested** ชี้ไป #127 G3
5. **แชร์ body ระหว่าง `AdminRoute` และ `SystemReadRoute`** ผ่านฟังก์ชันภายใน
   ห้ามคัดลอก

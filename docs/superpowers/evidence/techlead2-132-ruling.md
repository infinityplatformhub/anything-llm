# Techlead-2 — #132 ruling: **Option B** (`SystemReadRoute`) — และ recon กรอบคำถามผิดหนึ่งข้อ

recon `3c1801cab` (`.infi/recon/recon-132.md`) · ผมตรวจตัวเลขและ premise ทุกข้อเองบน
`approof/main` ก่อนตัดสิน

---

## ตัวเลขที่ recon ให้ — ตรวจแล้ว หนึ่งข้อคลาดเคลื่อน

```
grep -c "<AdminRoute Component="    main.jsx  ->  25   (recon บอก 26)
grep -c "<ManagerRoute Component="  main.jsx  ->  11   (recon บอก 10)
```

รวม **36 เท่ากัน** ข้อสรุปไม่เปลี่ยน · บันทึกไว้เพราะการนับที่คลาดจะกลายเป็นตัวเลข
ที่คนอ้างต่อ

**premise หลักถูกทั้งหมด:**
- `ORG_CAPABILITIES` (`endpoints/system.js:115-124`) ไม่มี `system.read` — ยืนยันเอง
  บน main · guard ที่ถาม `can("system.read")` วันนี้ได้ **false ทุกคน รวม super_admin**
  = หน้าตายสนิท · **hard dependency ของ #121 เป็นจริง**
- `setup_admin:org` ถือ `settings.write` แต่ไม่ถือ `system.read` — ตรงกับที่ผมวัดใน #127
- guard มีสามตัว ไม่ใช่สอง: `AdminRoute`, `ManagerRoute`, `SingleUserRoute`
  (`PrivateRoute/index.jsx:80,123,159`) · `SingleUserRoute` ไม่ได้ถาม capability
  จึงไม่กระทบข้อสรุป แต่ *"there are only two"* ในเชิงตัวอักษรไม่จริง

## ruling: **Option B**

`SystemReadRoute` (หรือ `AdminRoute` ที่รับ `action` แต่ **ไม่ export ในชื่อ generic**)

### เหตุผลที่ 1 — ต้นทุนของ A ไม่ใช่โค้ด แต่เป็นสิ่งที่มันทำให้ "ดูเหมือนควรทำ"

recon พูดถูก และผมยืนยัน: `CapabilityRoute` ที่แปลงหนึ่ง route ทิ้งไว้คือ guard ที่สี่
บวกคำเชิญไปยัง migration 36 จุดที่ไม่มีใคร scope · แต่ละจุดคือคำถามใหม่ *"หน้านี้ต้องการ
action ไหน"* ซึ่ง #40 t4 ใช้ทั้ง issue ตอบให้ 25 จุด และตอบไม่ได้ 4 จุด

**ที่สำคัญกว่า: แปลงผิดจุดคือ regression ที่ทดสอบไม่เจอ** — เปลี่ยน `AdminRoute` เป็น
`CapabilityRoute action="X"` ผิด action ให้ผลเป็น "หน้าเปิดได้แต่ 403" หรือ "หน้าปิดทั้งที่
ควรเปิด" ทั้งคู่เขียวใน suite ที่มีอยู่ ต้องมีเทสต่อหน้า · นั่นคือ 36 issue ไม่ใช่หนึ่ง

### เหตุผลที่ 2 — B ไม่ได้แย่กว่า A ในเชิงรูปทรง มันแค่เลื่อนการตัดสินใจไปยังจุดที่มีข้อมูล

recon เขียนว่า *"Option A is the better shape and the worse scope"* · **ผมไม่เห็นด้วยกับ
ครึ่งแรก** · guard ที่ดีไม่ใช่ guard ที่ parameterise ได้ แต่คือ guard ที่**ชื่อบอกว่ามันถามอะไร** ·
`<AdminRoute>` โกหกอยู่แล้ววันนี้ (มันถาม `settings.write` ไม่ใช่ "เป็น admin ไหม") —
นั่นคือรากของ #127 และ #132 · `SystemReadRoute` **ไม่โกหก**

`CapabilityRoute action="system.read"` ก็ไม่โกหกเช่นกัน แต่มันย้ายคำตอบไปอยู่ที่ call site
36 แห่งที่ยังไม่มีใครตอบ · **guard เฉพาะทางที่ถูกต้อง 3 ตัวดีกว่า guard generic 1 ตัวที่
call site 35 แห่งยังใส่ค่าผิดอยู่**

### เหตุผลที่ 3 — ถ้าวันหนึ่งต้องการ A จริง B ไม่ได้ขวาง

`SystemReadRoute` กับ `AdminRoute` มี body เดียวกันต่างที่ argument ของ `can()` ·
การรวมเป็น generic ภายหลังคือ refactor เชิงกลไกที่ทำได้ทีเดียวตอนมีคนตัดสินใจเรื่อง 36 จุดจริง ·
**ทางกลับไม่จริง**: ถ้าชิป A แล้วแปลงบางส่วน จะเหลือ repo ที่มีทั้งสองแบบปนกัน
ซึ่งแยกออกยากกว่าตอนเริ่ม

## เงื่อนไขที่ผูกกับ ruling นี้

1. **ต้องรอ #121 landed** — ตรวจ `ORG_CAPABILITIES` มี `system.read` **ด้วยการรัน**
   ก่อนเริ่ม ไม่ใช่ด้วยการอ่าน issue ว่าปิดแล้ว · ถ้าชิปก่อน หน้าตายสำหรับทุกคน
   รวม `super_admin` ซึ่งแย่กว่าบั๊กปัจจุบัน
2. **#132 ห้ามเพิ่ม `system.read` เข้า `ORG_CAPABILITIES` เอง** — ชนกับ #121 ใน
   `endpoints/system.js` ตรง ๆ · recon เขียนข้อนี้ไว้แล้วและถูก
3. **ต้องมีเทสที่ assert ว่า `system.read` อยู่ใน `ORG_CAPABILITIES`** — ไม่ใช่แค่ว่า
   guard ทำงาน · ถ้า #121 ถูก revert หรือ key ถูกเปลี่ยนชื่อ guard จะปฏิเสธทุกคนเงียบ ๆ
   และเทสฝั่ง frontend ที่ mock `fetchMyCapabilities` จะยังเขียวหมด — เป็นรูปเดียวกับ
   M2 ที่ผมทำใน #127 (frontend 6/6 เขียวขณะ DB ถูกแก้)
4. **residual ต้องเขียนให้ตรง**: #132 ปิด `setup_admin` เฉพาะหน้านี้ · อีก 35 จุดยังใช้
   การประมาณเดิม · ห้ามเขียนว่า "guard mismatch แก้แล้ว"

## เทสที่ recon เสนอ — เห็นด้วยทั้งหมด บวกอีกสอง

recon ครบผิดปกติ (RED `setup_admin`, positive control `super_admin`, `multiUserMode: true`,
`resetCapabilities()`, drift test เดิมคงไว้, F1 บน route table พร้อม assert offset ก่อน slice) ·
**ข้อ F1 ที่ assert offset ก่อน slice สำคัญ** — เทส F1 ของ #127 ใช้ `indexOf` แล้ว `slice`
ถ้า marker ขยับ `indexOf` คืน -1 และ slice ได้ทั้งไฟล์ ซึ่งจะ match `AdminRoute` จากที่อื่น
= fail open · recon เห็นเองและสั่งแก้

เพิ่ม:
- **เทสว่า `system.read` อยู่ใน `ORG_CAPABILITIES` จริง** (เงื่อนไขข้อ 3 ข้างบน) —
  ฝั่ง server ไม่ใช่ frontend mock
- **control ว่า `AdminRoute` ยัง admit `setup_admin` อยู่** — พิสูจน์ว่า guard ใหม่
  ต่างจากเดิมจริง ไม่ใช่เปลี่ยนชื่อเฉย ๆ · รูปเดียวกับ `ManagerRoute WOULD have admitted
  that manager` ใน #127 ซึ่งทำงานได้ดี

## tier

recon เสนอ `plain` ถ้า #121 landed และแตะเฉพาะ guard · **เห็นด้วย** — แต่ถ้าระหว่างทำ
พบว่าต้องแตะ `endpoints/system.js` หรือ capability list ด้วยเหตุใดก็ตาม **ต้องเลื่อนเป็น
`auth` ทันที** ตาม §7.11a ไม่ใช่ตัดสินเองว่ายังเล็กอยู่

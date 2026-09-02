# Techlead-2 — #130 ruling: **ไม่ใช่ A, B หรือ C — มีทางที่สี่ และผมรันแล้ว**

อ่าน `__tests__/support/disconnectPrisma.js` และ `connectionBudget.test.js` เอง
รันทุกอย่างข้างล่างจริง

---

## ข้อ (1) — Dev1 ถูก และผมยืนยัน

`grep "500\|2000"` ทั้งไฟล์ได้สองบรรทัด:

```
:173  expect(Date.now() - started).toBeLessThan(5000);      <- คนละเรื่อง (timing budget)
:214  // measured 4/6 runs passing at 500 ms and 6/6 at 1000 and 2000 —
```

`:214` อยู่ในคอมเมนต์ที่อธิบายว่า **ทำไมถึงเลิกใช้ตัวเลข** และโค้ดจริงที่ `:220` เป็น
`deadline = Date.now() + 10000` พร้อม poll ทุก 100ms

**#130 ข้อ (1) ขอให้เปลี่ยน 500→2000 ซึ่งจะเป็นการถอยกลับไปหา fixed sleep** ที่
`c2fdb8dc8` เพิ่งเอาออก · คอมเมนต์เขียนเหตุผลไว้ตรง ๆ ว่า *"any number would be tuning
it"* · **ข้อนี้ stale ปิดได้**

## ข้อ (2) — premise ผิด: in-process **ทำได้** และผมรันแล้ว

Dev1 บอกว่า assertion ใน process เดียวกันสังเกต `afterAll` ของตัวเองไม่ได้ · **จริงถ้า
พยายามรอให้ hook ทำงาน** — แต่นั่นไม่ใช่ทางเดียว

**ไม่ต้องรอให้ hook ทำงาน แค่จับตัว callback มาเรียกเอง:**

```js
const disconnect = jest.fn().mockResolvedValue(undefined);
jest.doMock("utils/prisma", () => ({ $disconnect: disconnect }));
let captured = null;
const real = global.afterAll;
global.afterAll = (fn) => { captured = fn; };
try { require("../support/disconnectPrisma.js"); } finally { global.afterAll = real; }
expect(typeof captured).toBe("function");
await captured();
expect(disconnect).toHaveBeenCalledTimes(1);
```

setup file เรียก `afterAll(...)` ตอนถูก require · แทน `global.afterAll` ชั่วคราว
แล้ว require = ได้ตัว callback มาถือไว้ · เรียกมันเองพร้อม mock `$disconnect`
**เป็นการทดสอบพฤติกรรม ไม่ใช่การอ่าน source**

### รันจริง — ผมสร้างไฟล์ทดสอบและยิง mutation

```
baseline                       ✓ 1 passed  (0.3 s)

M4  if (false) $disconnect()   capture-invoke:  ✕ FAILED
                               source-grep:     ✓ still passes   <- ข้อร้องเรียนของ #130
M   afterAll body emptied      capture-invoke:  ✕ FAILED
M   $disconnect -> $disconnectt capture-invoke: ✕ FAILED
```

**M4 ที่ #130 ยกมาเป็นเหตุผลของทั้ง issue ตายด้วยเทสในกระบวนการเดียวกัน ใน 0.3 วินาที
ไม่ต้อง spawn อะไรเลย**

และมันจับได้กว้างกว่า M4: body ว่าง และการสะกดชื่อ method ผิด ก็ตายด้วย —
สองอย่างที่ source-grep ปัจจุบัน (`toMatch(/\$disconnect\(\)/)`) ปล่อยผ่านเช่นกัน

## ตัดสิน: **เพิ่ม capture-and-invoke, เก็บ source-grep ไว้, ไม่ทำ (A)**

**(A) child-process ตกไป** — ราคาคือ nested jest ใน sweep, ช้ากว่า, lane กว้างกว่า ·
ได้มาเพื่อจับสิ่งที่เทส 0.3 วินาทีจับได้แล้ว · **ไม่คุ้ม และตอนนี้เป็นการเปรียบเทียบ
ที่มีตัวเลขทั้งสองฝั่ง ไม่ใช่การเดา**

**(C) ปิดว่า stale ตกไป** — ข้อ (1) stale จริง แต่ข้อ (2) ชี้ช่องว่างที่**มีอยู่จริง**:
source-grep เขียวบน M4 ผมยืนยันแล้ว · ปิดทั้ง issue จะทิ้งช่องว่างนั้นไว้

**(B) เก็บ source-grep + คอมเมนต์ซื่อสัตย์ — ครึ่งถูก** · source-grep ยังมีคุณค่า
**แต่คนละคุณค่า**: มันตอบว่า "ไฟล์ยังอยู่และยังลงทะเบียน" ซึ่ง capture-invoke ตอบไม่ได้
(ผมวัด: ลบไฟล์ทิ้ง capture-invoke พังแบบ error ไม่ใช่ assertion) · **สองเทสตอบคนละคำถาม
เก็บทั้งคู่**

### สิ่งที่ต้องทำ

1. **เพิ่มเทส capture-and-invoke** ในไฟล์เดิม (`connectionBudget.test.js` describe
   `"the disconnect hook is actually wired"`) — ไม่ต้องมีไฟล์ใหม่ ไม่ต้องแตะ jest.config
2. **แก้คอมเมนต์ `:60-65`** ที่เขียนว่า *"Nothing behavioural can catch it"* —
   **ข้อนี้ผิด และผมพิสูจน์แล้ว** · เขียนใหม่ว่า: hook ที่ทำงานจริงสังเกตไม่ได้จาก
   ภายในกระบวนการเดียวกัน **แต่ตัว callback จับมาเรียกเองได้** และนั่นคือสิ่งที่
   เทสข้างล่างทำ
3. **ปิดข้อ (1) ว่า stale** พร้อมเหตุผลว่าการเปลี่ยนตัวเลขจะเป็นการถอยกลับ
4. **residual ที่เหลือจริง** — capture-invoke พิสูจน์ว่า callback เรียก `$disconnect`
   แต่ไม่ได้พิสูจน์ว่า jest **เรียก callback นั้นจริงหลังทุก suite** · นั่นคือสัญญาของ
   jest เอง ซึ่งเทสในกระบวนการยืนยันไม่ได้และไม่ควรพยายาม · เขียน residual ให้ตรง
   **ไม่ใช่ปล่อยให้คอมเมนต์อ้างว่าทดสอบไม่ได้เลย**

## หมายเหตุวิธีการ

Dev1 ถามคำถามที่ถูก (*"คุ้มไหมกับ nested jest"*) แต่ตั้งกรอบเป็นสองทางเลือกที่มีอยู่ ·
**ทางที่สามมีเพราะ premise "in-process ทำไม่ได้" ผิด** — และมันผิดในทางที่ตรวจได้ด้วย
การเขียนเทสยาว 12 บรรทัดแล้วรัน · นี่คือรูปแบบเดียวกับที่ผมเจอในงานตัวเอง (#119 F4):
**ข้อจำกัดที่เขียนไว้ในคอมเมนต์ กลายเป็นข้อเท็จจริงที่ไม่มีใครทดสอบซ้ำ**

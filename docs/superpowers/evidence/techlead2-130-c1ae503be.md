# Techlead-2 — #130 `c1ae503be`: **PASS** (plain tier, pre-read)

**Skills invoked**: `requesting-code-review` — **ไม่มีในระบบนี้** (`Unknown skill: requesting-code-review`)
ผมพยายามเรียกก่อนอ่าน SHA ตามที่สั่ง และมันไม่มีอยู่ · รีวิวนี้จึงทำด้วยวิธีเดิม
(worktree detached + baseline + mutation) และผม **ไม่ได้เรียก skill ใด ๆ ใน #130 รอบก่อน
หรือ #136** เพราะกฎเพิ่งประกาศ · `security-review` มีอยู่จริงและผมเรียกไปแล้วสำหรับ #136

worktree `/tmp/tl2-130b` DB `t98b` · **baseline 13/13** (จาก 12)

---

## สองข้อที่ถูกขอให้ตรวจเฉพาะ

### (1) `finally` คืนสภาพให้เพื่อนบ้าน `--runInBand` ครบไหม — **ครบ และผมพิสูจน์ทั้งสองทาง**

`finally` คืน `global.afterAll` และเรียก `jest.dontMock(prismaPath)` · ผมไม่เชื่อการอ่าน
เขียนไฟล์เพื่อนบ้านที่รันหลังจริง:

```js
it("global.afterAll still works and prisma is NOT mocked", async () => {
  expect(typeof global.afterAll).toBe("function");
  const prisma = require("../../../utils/prisma");
  expect(typeof prisma.users?.count).toBe("function");   // mock มีแต่ $disconnect
  expect(typeof (await prisma.users.count())).toBe("number");
});
```

```
ทางปกติ:        14 passed, 14 total          <- เพื่อนบ้านผ่าน
ทางที่เทสล้มเหลว: 1 failed, 13 passed          <- ล้มเฉพาะ capture test
                PASS __tests__/utils/test/zzneighbour.test.js
```

**ทางที่สองสำคัญกว่า** — ผมทำให้ assertion ใน capture test ล้ม (`toHaveBeenCalledTimes(999)`)
แล้วเพื่อนบ้าน **ยังเขียว** · แปลว่า `finally` ทำงานตอน throw ด้วย ไม่ใช่เฉพาะ happy path ·
ถ้าใช้ `try` เปล่า ๆ หรือคืนสภาพหลัง assertion เทสที่ล้มหนึ่งตัวจะลาม

`prisma.users?.count` เป็น oracle ที่ถูก — mock มีแค่ `$disconnect` ดังนั้นถ้า
`dontMock` ไม่ทำงาน เพื่อนบ้านจะเห็น mock และ assertion นี้ล้ม · **ไม่ใช่แค่เช็คว่า require ได้**

### (2) guard `typeof captured === "function"` อยู่ก่อน invoke ไหม — **อยู่ และ load-bearing**

ลำดับในโค้ด: `isolateModules(require)` → `expect(typeof captured).toBe("function")` →
`await captured()` · **guard อยู่ก่อน**

ผมพิสูจน์ว่ามันไม่ใช่บรรทัดประดับ — ถอด `jest.isolateModules` ออก (จำลองความล้มเหลว
ที่ Dev1 เจอจริงในเวอร์ชันแรก):

```
✕ the registered callback actually disconnects when invoked
  expect(typeof captured).toBe("function");
```

**ล้มที่ guard พร้อมข้อความที่อ่านรู้เรื่อง** ไม่ใช่ `TypeError: captured is not a function` ·
นี่คือเหตุผลที่ comment อ้างไว้ และมันเป็นความจริงที่วัดได้

## mutation ผมทำเอง

| # | mutation | ผล |
|---|---|---|
| **W1** | `if (false && …) await prisma.$disconnect()` | **1 failed** — เทสใหม่เท่านั้น (source-grep ยังเขียว ตามที่ควร) |
| **W2** | `$disconnect` → `$disconnectt?.()` | **2 failed** — เทสใหม่ **และ** source-grep |

**W1 คือ M4 ที่เป็นเหตุผลของทั้ง issue** — ตายด้วยเทสในกระบวนการเดียวกัน ตรงกับ ruling
**W2 แดงสองตัวและนั่นถูกต้อง** — การสะกดผิดเปลี่ยนทั้งพฤติกรรมและข้อความ จึงถูกจับสองชั้น ·
ยืนยันว่า source-grep ที่เก็บไว้ยังทำงาน ไม่ได้กลายเป็นโค้ดตาย

ตัวเลขตรงกับที่ Dev1 รายงาน (if(false) 1, typo 2) — ผมวัดเองได้ผลเดียวกัน

## สามข้อที่ Dev1 แก้ระหว่างทาง — ตรวจแล้วว่าเขียนตรงกับที่เกิดจริง

comment อ้างสามอย่าง: `isolateModules` แทน `require.cache` delete, invoke ขณะ mock
ยังติดอยู่, `finally` คืนทั้งสองอย่าง · **ข้อแรกผมยืนยันด้วย mutation ข้างบน** (ถอดออกแล้ว
`captured === null` จริง) · ข้อสองอธิบายว่าทำไม `await captured()` ต้องอยู่ **ใน** `try`
ไม่ใช่หลัง `finally` — โครงโค้ดตรงกับคำอธิบาย · **คำอธิบายที่วัดได้ ไม่ใช่ที่เล่ามา**

## comment `:60-65` — แก้ตรงตาม ruling

เดิม: *"Nothing behavioural can catch it"* · ใหม่: ระบุว่าข้อความเดิม **ผิดและเสียเวลาไปหนึ่งรอบ**
แล้วขีดเส้นให้ชัดว่าอะไรทดสอบไม่ได้จริง (*"only jest's promise to call it is taken on trust"*) ·
**residual แคบลงตรงตามข้อ 4 ของ ruling** — จาก "ทดสอบไม่ได้เลย" เหลือ "jest เรียก callback
ที่ลงทะเบียนไว้จริงไหม"

## Verdict

**PASS** — ไม่มี blocker · merge ได้

`finally` คืนสภาพครบทั้งทางปกติและทางที่ throw (พิสูจน์ด้วยเพื่อนบ้านที่รันหลัง) ·
guard อยู่ก่อน invoke และล้มด้วยข้อความที่ถูกต้องเมื่อ capture พลาด · W1/W2 จับได้ทั้งคู่ ·
source-grep ที่เก็บไว้ยังมีชีวิต (W2 แดง) ไม่ใช่โค้ดตาย

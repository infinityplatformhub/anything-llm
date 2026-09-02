# Techlead-2 — #119 `c44b059d3`: **PASS** — และคำค้านของ Dev5 ถูก ผม pre-read ผิด

worktree `/tmp/tl2-119` (detached `c44b059d3`) donor `/tmp/qa2-84b`, DB `t98b`

**baseline: 2/2 suites, 71/71 tests, 0 failed** — วัดซ้ำหลัง mutation ครบ ยัง 71/71

---

## ข้อแรก: pre-read ของผมผิด และ Dev5 พิสูจน์ด้วยการวัด

ผมเขียนไว้ว่า *"ข้อเสนอ: seal ตัว argument แล้วค่อยเรียก original — ปิดทั้งสามรูปทรง"*
**ผิด** · Dev5 ค้านพร้อมการวัด: router ที่มี `POST /deep` อยู่**ก่อน** mount ยังตอบ 200
เพราะ route นั้นไม่เคยผ่าน sealed method — seal ปิดได้แค่การเขียน**ในอนาคต** ไม่ได้ถอน
route ที่มีอยู่แล้ว และ `routeGateSweep` มองไม่เห็นมันเพราะอยู่ใน stack ของ router ตัวเอง

ผมยืนยันด้วย mutation ของตัวเอง:

| mutation | ผล |
|---|---|
| **M1** seal argument แต่ **ไม่ throw** (= ข้อเสนอของผมเป๊ะ) | **8 failed** |
| **M2** throw แต่ **ไม่ seal** | **6 failed** |

**ทั้งสองครึ่งจำเป็นจริง และแดงคนละชุดไม่ทับกัน** — M1 แดงรวม `a router built and populated
BEFORE being use()d is refused as a whole` (ข้อที่ผมมองไม่ออก) · M2 แดงรวม `F3: a router
mounted EMPTY and filled afterwards` (ข้อที่ผมมองออกและเป็นเหตุผลที่ผมเสนอ seal) ·
**คำตอบคือทั้งสองอย่าง ไม่ใช่อย่างใดอย่างหนึ่ง**

## ข้อสอง: F4 oracle ที่ผมเขียนไว้ก็ผิด และ Dev5 แก้ถูก

ผมเขียน RED FIXTURE F4 ว่า *"ทั้งสามเส้นต้องไม่ตอบ 200"* · ผมทดสอบเองแล้ว:

```
POST /api/definitely-not-a-route-xyz  -> 200 body: {}
POST /api/f1/deep                     -> 200 body: {}
```

**path ที่ไม่มีอยู่จริงก็ตอบ 200** เพราะ SPA fallback (`app.use("/", IndexPage.generate)`)
อยู่ก่อน wildcard · ดังนั้น `status !== 200` พิสูจน์อะไรไม่ได้เลย — fixture ที่ผมสั่งจะ
**เขียวโดยไม่ได้ทดสอบอะไร** · Dev5 แก้เป็น **marker ใน body + control** ซึ่งถูก:
สิ่งที่แยก "route ถูก mount" ออกจาก "fallback" คือ marker ไม่ใช่ status

นี่เป็นความผิดพลาดรูปแบบเดียวกับที่ผมเคยจับได้ในงานคนอื่น (§7.9 — เขียวด้วยเหตุผลผิด)
บันทึกไว้เพราะผมเป็นคนสั่ง fixture นั้นเอง

## ข้อสาม: `.stack` — ข้อเดียวที่ผม pre-read ถูก

Dev5 รับ §1 และวัดซ้ำได้ตรงกัน · M3 (ย้อน discriminator กลับเป็น `Array.isArray(value.stack)`)
→ **2 failed** รวม `F2: an express() SUB-APP is refused too, though it has no .stack` ·
ยืนยันว่า false negative ที่ผมวัดไว้เป็นของจริงและตอนนี้มีเทสถือ

---

## ยิง fixture ทั้ง 9 เองบน app จริง

```
F1  use(subRouter prepopulated)   GUARD THROW
F1b subRouter.post AFTER          GUARD THROW
F2  use(express() sub-app)        GUARD THROW
F2b subApp.post AFTER             GUARD THROW
F3  use(empty router)             GUARD THROW
F3b empty.post AFTER mount        GUARD THROW
F9  subR.route().post()           GUARD THROW
F7  use(A) where A.use(B)         GUARD THROW
F7b B.post AFTER                  GUARD THROW
F5  use(plain fn)                 MOUNTED
F6  use(express.static)           MOUNTED
F6b use(express.json())           MOUNTED
```

**สามรูปทรงที่ผมยิงได้ 200 บน `12f8732b8` ปิดหมด** และ middleware ธรรมดาสามแบบยังผ่าน

## mutation ทั้งหมด

| # | mutation | ผล |
|---|---|---|
| **M1** | seal อย่างเดียว ไม่ throw | **8 failed** |
| **M2** | throw อย่างเดียว ไม่ seal | **6 failed** |
| **M3** | discriminator กลับเป็น `.stack` | **2 failed** (F2, F4) |
| **M4** | ตัด `nestedSealables` | **1 failed** (F7) |
| **M5** | `isSealable` รับทุก function/object | **4 failed** — `read methods still mount`, `a READ route added after boot still works`, `ordinary middleware still mounts`, `index.js's own post-boot mounts still work` |
| **M6** | `guardDisabled` คืน false เสมอ | **3 failed** รวม `ROUTE_MOUNT_GUARD=off leaves a use()d sub-router mountable AND writable` |

**M5 คือคำตอบของคำถาม "throw ขัดกับ middleware ต้องผ่านไหม"** — ไม่ขัด และมีเทสสี่ตัวถือ
เส้นแบ่งไว้ · ถ้า `isSealable` กว้างเกินไปจนจับ middleware ธรรมดา เทสสี่ตัวนี้แดงทันที
รวมถึงเทสที่ยิง `index.js` เองซึ่งใช้ `express.static` และ MetaGenerator จริง · **เส้นแบ่งอยู่ที่
"object นี้มี method ที่ seal จะแทนที่ไหม" ซึ่งเป็นคำถามเดียวกับที่ seal ตอบอยู่แล้ว**

**M6 ตอบข้อที่ผมยกไว้ใน pre-read** (`GUARD=off` ต้องปิด recursion ด้วย) — มีเทสเฉพาะ
`ROUTE_MOUNT_GUARD=off leaves a use()d sub-router mountable AND writable` ซึ่ง assert **ทั้งสอง**
คุณสมบัติ ไม่ใช่แค่ mount ได้

---

## ตอบคำถามสองข้อที่ถามมา

### (1) throw ขัดกับ "middleware ต้องผ่าน" ไหม — **ไม่ขัด**

`use` ถูก seal **แบบมีเงื่อนไข**: ถ้า argument ไม่มี sealable method เลย → `originalUse(...args)`
ทันที ไม่แตะอะไร · middleware ธรรมดาไม่มี `.post`/`.put`/… จึงไม่เข้าเงื่อนไข

ผมยิงเองสามแบบ (plain fn, `express.static`, `express.json()`) — **MOUNTED ทั้งสาม** และ M5
พิสูจน์ว่าถ้าเส้นแบ่งเลื่อน เทสจะจับ · คำเตือนใน JSDoc ของ #98 (*"a guard that cries wolf
gets removed"*) ยังเป็นจริงและถูกเคารพ

**สิ่งที่เปลี่ยนความหมายของ `use` จริง ๆ คือ throw ไม่ใช่ seal** — และมันเปลี่ยนเฉพาะกับ
argument ที่เป็น router/sub-app ซึ่งเป็น "การเพิ่ม route" ไม่ใช่ "การเพิ่ม middleware"
· การปฏิเสธการเพิ่ม route หลัง boot คือสิ่งที่ #98 ทำอยู่แล้วกับทุกเส้นทางอื่น · **#119 ทำให้
`use` สอดคล้องกับที่เหลือ ไม่ใช่พิเศษกว่า**

### (2) residual "captured before seal" พอไหม — **พอ**

ต้องจงใจสองชั้น: (ก) เก็บ reference ของ router ข้าม boot (ข) เพิ่ม route ทีหลังโดย
**ไม่เคย `use` มันอีก** — เพราะถ้า `use` อีกครั้งจะโดน seal · ไม่มีโมดูลไหนใน tree ทำทั้งสองอย่าง
(`apiRouter` เป็น `const` ที่ไม่ export และไม่มีใครถือ reference ข้าม module)

ต่างจากสามรูปทรงที่ปิดไป ซึ่ง**เผลอทำได้ด้วยโค้ดปกติ** (เขียน `router.use(sub)` ตามที่
express docs สอน) · การปิด residual ที่เหลือต้อง seal ตอน **construction** ซึ่งแปลว่าต้อง
patch `express.Router` เอง — เปลี่ยนพฤติกรรมของ library ไม่ใช่ของ app · **ราคาไม่คุ้มกับ
รูที่ต้องจงใจสองชั้นถึงจะถึง**

JSDoc เขียน residual นี้ไว้ตรงกับที่วัดได้ และคง**เทสที่ assert ว่ามันยัง mount ได้** ตามรูปแบบ
ที่ #98 วางไว้ — ถ้าวันหนึ่งปิด เทสจะแดงและบังคับให้ตัดสินใจ

---

## Verdict

**PASS** — ไม่มี blocker

- fixture ทั้ง 9 ยิงเองบน app จริง ผ่านครบ · สามรูปทรงที่ผมเจาะได้ 200 บน `12f8732b8` ปิดหมด
- **คำค้านของ Dev5 ถูก และผม pre-read ผิดสองข้อ** — ข้อเสนอ "seal แล้วเรียก original" ของผม
  ปล่อย router ที่ populate ไว้ก่อน (M1 แดง 8) · fixture F4 ที่ผมสั่ง (`status !== 200`)
  เขียวโดยไม่ทดสอบอะไร เพราะ SPA fallback ตอบ 200 ให้ทุก path (ผมยืนยันด้วย control เอง)
- mutation 6 ตัว จับได้ทุกตัว แดงคนละชุด · M1/M2 พิสูจน์ว่าทั้งสองครึ่งจำเป็น
- middleware ธรรมดาผ่านครบ และ M5 ถือเส้นแบ่งไว้ด้วยเทสสี่ตัว

## หมายเหตุ (ไม่ block)

- **`nestedSealables` เดิน express internals** (`.stack`, `._router.stack`) ซึ่งเป็น API ภายใน
  · โค้ดอ่านแบบ defensive แล้ว (คืน `[]` เมื่อไม่รู้จักรูปทรง) และ **discriminator ไม่ได้พึ่งมัน** —
  ใช้เฉพาะการ *เดินหา* ตัวที่ซ้อนอยู่ ไม่ใช่การ *ตัดสิน* ว่าอะไรคือ router · แปลว่าถ้า express
  เปลี่ยนที่เก็บ layer ผลคือ seal ลงลึกไม่ได้ (F7 แดง) ไม่ใช่ปล่อยผ่านเงียบ ๆ — fail-visible
- **`sealRoutes` เรียกตัวเองแบบ recursive ผ่าน `use` wrapper** — ถ้ามี router ที่อ้างถึงตัวเอง
  จะวน · `nestedSealables` มี `seen` Set กันไว้แล้ว แต่ `sealRoutes(sealable, ...nested)` เอง
  ไม่มี — ในทางปฏิบัติไม่ถึงเพราะ `use` ที่ถูก seal จะ throw ก่อน แต่บันทึกไว้

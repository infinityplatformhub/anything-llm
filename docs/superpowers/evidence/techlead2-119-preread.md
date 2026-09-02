# Techlead-2 — #119 pre-read: `.stack` ไม่พอเป็น discriminator, และ recursion แก้ได้ไม่ครบ

วัดบน express **4.22.1** (เวอร์ชันที่ tree ใช้จริง) ด้วยการรัน ไม่ใช่การอ่าน docs

## (1) `.stack` เป็น discriminator ที่พอไหม — **ไม่พอ ผิดทั้งสองทาง**

รูปทรงที่ทดสอบ:

| object | `typeof` | `.stack` | `.use` | `.post` |
|---|---|---|---|---|
| `express.Router()` | function | **array** | fn | fn |
| **`express()` sub-app** | function | **none** | fn | fn |
| plain middleware `(req,res,next)=>{}` | function | none | — | — |
| `Object.assign(fn, {use, get, post})` | function | none | fn | fn |
| **`Object.assign(fn, {stack: []})`** | function | **array** | — | — |
| Router ห่อใน closure | function | none | — | — |

**false negative — sub-app ไม่มี `.stack`**: `express()` เก็บ layer ไว้ใต้ `._router` ไม่ใช่
`.stack` และ `._router` **ยังไม่มีอยู่เลย** จนกว่าจะ mount route แรก (`lazyrouter()`)
วัดได้:
```
sub-app before route: .stack = undefined | ._router = undefined
sub-app after route:  .stack = undefined | ._router.stack len = 3
```
ดังนั้น seal ที่ discriminate ด้วย `.stack` จะ **ไม่มองว่า sub-app เป็น router** และปล่อยผ่าน

**false positive — object ที่ไม่ใช่ router มี `.stack` ได้**: `Object.assign(fn, {stack: []})`
ผ่าน discriminator แต่ไม่มี method ให้ seal — จะไม่พังเพราะโค้ดควรเช็ค `typeof` ก่อน แต่แปลว่า
discriminator ไม่ได้บอกสิ่งที่มันอ้าง

**สิ่งที่ควรใช้แทน**: discriminate ด้วย **method ที่จะ seal** ไม่ใช่ด้วยรูปทรงภายใน —
`SEALED_METHODS.some((m) => typeof target[m] === "function")` · ตรงกับสิ่งที่ seal ทำจริง
(มันแทนที่ method) และครอบทั้ง Router และ sub-app โดยไม่ต้องรู้ว่า express เก็บ layer ไว้ที่ไหน
· `sealRoutes` ปัจจุบันก็ใช้หลักนี้อยู่แล้ว (`if (typeof original !== "function") continue`)
— #119 แค่ต้องใช้หลักเดียวกันตอนตัดสินใจว่าจะ recurse เข้าไปไหม

## (2) middleware ธรรมดาหลัง seal — **ต้องผ่าน**

`use` คือทางที่ middleware ทุกตัว mount และ `index.js` ใช้มันหลัง registration loop
(static handler, MetaGenerator) · seal ที่ปฏิเสธ `use` จะปฏิเสธโค้ดที่ถูกต้อง ซึ่ง JSDoc ของ
#98 เขียนไว้แล้วและยังจริง

**ทางที่ถูกคือ**: `use` ยังผ่านเสมอ แต่ **ถ้า argument เป็นสิ่งที่ seal ได้ ให้ seal มันตอน mount**
· ไม่ใช่ปฏิเสธ ไม่ใช่ปล่อยผ่าน — เป็น "รับไว้แล้วปิดผนึกทันที"

## (3) residual "router captured before seal" — **ยอมรับได้ แต่ไม่ใช่ residual ที่ใหญ่ที่สุด**

ผมยิงสามรูปทรงบน `12f8732b8` (SHA ที่ #98 merge) หลัง boot เสร็จ ผ่าน HTTP จริง:

```
POST /api/sub-app/deep      -> 200 {"pwned":"sub-APP (no .stack)"}
POST /api/sub-router/deep   -> 200 {"pwned":"sub-ROUTER (.stack)"}
POST /api/late-empty/deep   -> 200 {"pwned":"router EMPTY at mount, filled after"}
```

ตัวที่สามคือตัวที่ **recursion แก้ไม่ได้เลย**: mount router **เปล่า** เข้าไปก่อน แล้วค่อยเพิ่ม
route ทีหลัง · seal ที่เดิน `.stack` ตอน mount จะเห็น array ว่างและไม่มีอะไรให้ seal — แต่
object นั้นยังถูกถืออยู่และ `.post()` บนมันยังทำงาน

**นี่ไม่ใช่ residual เดียวกับ "captured before seal"** — router ตัวนี้ถูกสร้างและ mount
**หลัง** seal ทั้งคู่ · การแก้คือ **seal ตัว router ตอน mount** (แทนที่ method ของมัน)
ไม่ใช่แค่ recurse เข้า `.stack` ที่มีอยู่ตอนนั้น · ถ้า #119 ทำแบบหลัง จะปิดได้แค่สองในสาม
และ residual ที่เหลือจะอธิบายยากกว่าเดิม

**ข้อเสนอรูปแบบ**: ใน wrapper ของ `use`
```
เดิม: target.use(...args)
ใหม่: seal ทุก arg ที่ SEALED_METHODS.some(m => typeof arg[m] === "function")
      แล้วค่อยเรียก original.use(...args)
```
ปิดทั้งสามรูปทรง: sub-app (มี `.post`), sub-router (มี `.post`), router เปล่า (มี `.post`
ตั้งแต่สร้าง แม้ `.stack` จะว่าง) · และไม่ต้องรู้จัก `._router`/`.stack` เลย

**residual ที่เหลือหลังทำแบบนี้** = router ที่ถูกจับ reference ไว้**ก่อน** seal แล้วเพิ่ม route
ทีหลังโดยไม่เคย `use` มันใหม่ · **ยอมรับได้** เพราะต้องจงใจสองชั้น (เก็บ reference ข้าม boot
+ เพิ่ม route ทีหลัง) และไม่มีโมดูลไหนใน tree ทำ — ต่างจากสามรูปทรงข้างบนที่เผลอทำได้ด้วย
โค้ดปกติ

---

## REQUIRED RED FIXTURES

| # | fixture | ต้องเกิดอะไร |
|---|---|---|
| **F1** | `apiRouter.use("/x", subRouter)` หลัง boot โดย `subRouter` มี `POST` อยู่แล้ว → เรียก `subRouter.post()` เพิ่มอีกเส้น | **GUARD THROW** |
| **F2** | `apiRouter.use("/x", expressSubApp)` — **sub-app ไม่ใช่ Router** | **GUARD THROW** · fixture ต้องใช้ `express()` ไม่ใช่ `express.Router()` — ถ้าไม่มีข้อนี้ discriminator ที่ผิดจะผ่าน |
| **F3** | `apiRouter.use("/x", emptyRouter)` แล้ว `emptyRouter.post()` **หลัง** mount | **GUARD THROW** · นี่คือ fixture ที่แยก "seal object" ออกจาก "recurse .stack" — recursion ล้วนจะเขียว |
| **F4** | HTTP: ทั้งสามเส้นต้อง **ไม่ตอบ 200** (404 หรือไม่มี route) | ยิงผ่าน `supertest` บน app จริง ไม่ใช่แค่ assert ว่า throw — #98 บทเรียน: mount ได้กับ HTTP ถึงได้เป็นคนละคำถาม |
| **F5** | middleware ธรรมดา (`app.use((req,res,next)=>next())`) หลัง seed → **ผ่าน** | positive control · ถ้าไม่มี F1–F3 ผ่านได้ด้วยการ seal `use` ทั้งหมด ซึ่งจะพัง static/MetaGenerator |
| **F6** | `app.use("/path", express.static(...))` หลัง seal → **ผ่าน** | positive control ที่เจาะจงกว่า F5 — `express.static` คือ middleware ที่ `index.js` ใช้จริง |
| **F7** | nested สองชั้น: `use(A)` โดย A มี `use(B)` โดย B มี `POST` | **GUARD THROW** ตอนเรียก `B.post()` หลัง boot · ทดสอบว่า seal ลงลึกจริงไม่ใช่ชั้นเดียว |
| **F8** | เทสที่ **assert ว่า `use(subRouter)` ยังใช้งานได้** (#98 มีอยู่แล้ว) → **ต้องแดง** และถูกแก้ในคอมมิตเดียวกัน | #98 ใส่เทสที่ยืนยันว่า `use(sub)` mount ได้ พร้อมคอมเมนต์ว่าถ้า #119 ปิดมันเทสนี้จะแดงและบังคับให้ตัดสินใจ · **ถ้า #119 merge โดยเทสนั้นยังเขียว แปลว่า seal ไม่ทำงาน** |

**F3 และ F8 คือสองข้อที่ผมยืนยันว่าต้องมี** — F3 เพราะมันเป็นรูปทรงที่ recursion แก้ไม่ได้และ
ผมยิงได้ 200 จริง · F8 เพราะ #98 วางกับดักไว้ให้ตัวเองแล้ว ถ้ามันไม่แดงคือหลักฐานว่า #119
ไม่ได้ทำสิ่งที่อ้าง

## หมายเหตุ

- **`.route()` factory ถูก seal แล้วใน #98** ดังนั้น sub-router ที่ถูก seal ต้องได้ทั้ง
  `SEALED_METHODS` และ `.route` เหมือนกัน — ไม่งั้น `subRouter.route("/x").post()` จะรอด
  ซึ่งเป็นรูเดียวกับที่ #98 เพิ่งปิดไป เพียงแค่ลึกลงไปหนึ่งชั้น · **ขอ F9: `subRouter.route(p).post()`
  หลัง boot → GUARD THROW**
- **`ROUTE_MOUNT_GUARD=off` ต้องปิด recursion ด้วย** — ถ้า escape hatch ปิดแค่ชั้นบนแต่ยัง seal
  sub-router deployment ที่ตั้ง flag เพื่อ "แก้ปัญหาเฉพาะหน้า" จะยังพังในทางที่อธิบายไม่ได้

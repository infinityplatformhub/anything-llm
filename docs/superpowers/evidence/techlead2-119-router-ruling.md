# Techlead-2 — #119 ruling: `app._router` bypass (QA-2 FAIL)

**QA-2 ถูก และผมพลาดเอง** — ผมยิง 9 fixture ผ่าน `apiRouter` ที่ mount แล้ว แต่ไม่ได้ยิงผ่าน
`app._router` เลย · ยืนยันด้วยตัวเองบน app จริง `NODE_ENV=production`:

```
MOUNTED   app._router.post
MOUNTED   app._router.all
MOUNTED   app._router.route().post
MOUNTED   app._router.use(Router)
MOUNTED   app.param        <- ไม่ถูก seal ทั้ง app และ router
```

`sealRoutes(app, apiRouter)` seal สอง object แต่ `app.post` เป็นแค่ delegate ไป
`app._router` · seal บน `app` ปิดทางเข้าหน้าบ้าน ไม่ได้ปิดตัวจริง · **นี่ไม่ใช่ residual
เดียวกับ captured-before-seal** — `app._router` เป็น property บน object ที่ export อยู่แล้ว
เข้าถึงได้ทุกเมื่อ ไม่ต้องเตรียมอะไรก่อน boot

---

## ตัดสิน: **option 1 (seal `_router`) ถูกทาง แต่ one-liner ที่เสนอมาใช้ไม่ได้**

รัน `sealRoutes(app, app._router, apiRouter)` ตรง ๆ:

```
Tests: 4 failed, 34 passed, 38 total
  ✕ production boots, and READ routes stay mountable on the real app afterwards
  ✕ a READ route added after boot still works, on the real app
  ✕ index.js's own post-boot mounts still work on the real app
  ✕ read-only mounts are unaffected, since index.js depends on them
```

probe แยกอธิบายว่าทำไม:

```
THROW    [opt1] app2.get LEGIT robots.txt
THROW    [opt1] app2.post
THROW    [opt1] app2._router.post
```

**`app.get` เดินผ่าน `app._router.route(path).get(...)`** · `sealRoutes` seal `.route`
แบบ **ปฏิเสธทั้งหมด** ซึ่งบน `apiRouter` ถูก (ไม่มีใครเรียกหลัง boot) แต่บน `_router`
มันคือทางที่ `app.get`/`app.use("/")` ใช้จริงหลัง seal — `index.js:171,175` mount
`robots.txt`, `manifest.json`, SPA fallback **หลัง** จุด seal · one-liner จึงยิง
correct code ตรงตามที่ JSDoc เตือนไว้เอง (*"a guard that cries wolf gets removed"*)

## รูปแบบที่ใช้ได้ — วัดแล้ว

seal `_router` แบบ **แยก `.route` ออกจากตัวอื่น**: ไม่ปฏิเสธ `.route()` แต่คืน Route ที่
**เมธอด mutating ถูก seal** ส่วน `get`/`head` ปล่อยผ่าน

```
MOUNTED   app.get LEGIT
MOUNTED   app.use('/') LEGIT
MOUNTED   app.use(static) LEGIT
THROW     app._router.post
THROW     app._router.all
THROW     app._router.route().post
THROW     app._router.route().all
THROW     app._router.use(Router)
MOUNTED   app._router.use(plain fn)
```

ปิดครบทั้ง 4 รูปทรงของ QA-2 · legit mount ทั้งสามยังผ่าน · เส้นแบ่ง middleware
ยังอยู่ที่เดิม

**สิ่งที่ต้องเปลี่ยนคือ `sealRoutes` ไม่ใช่ callsite** — เพิ่มพารามิเตอร์/โหมดที่บอกว่า
target นี้ต้องคง `.route()` ไว้ใช้งาน แล้ว seal เฉพาะเมธอด mutating บน Route ที่มันคืน ·
callsite เป็น `sealRoutes(app, app._router, apiRouter)` ตามที่เสนอ แต่ `_router` ต้อง
เข้าโหมดนี้

## guard `_router` ยังไม่มี

ไม่จำเป็นบน app จริง (`app.use(...)` ที่ `index.js:73` สร้าง `_router` ตั้งแต่บรรทัดแรก ๆ
ผมยืนยัน `has _router before seal: true`) แต่ `sealRoutes` เป็นฟังก์ชันทั่วไปที่รับ
`...targets` — `undefined` เข้าไปจะ throw ที่ `target.route` · ให้ข้าม target ที่เป็น
`null`/`undefined` แทนที่จะ throw ระหว่าง boot

## สองข้อที่ QA-2 สังเกตเพิ่ม

**`router.get`/`head` throw ขณะ `app.get` ผ่าน** — จริง ผมวัดได้ `THROW api.get` ·
เพราะ `.route` ถูกปฏิเสธทั้งหมดบน `apiRouter` และ `router.get` เดินผ่านมัน · JSDoc เขียนว่า
*"`get`/`head` are deliberately absent"* ซึ่งเป็นจริงเฉพาะ `app` · **comment ผิด ต้องแก้**
ให้บอกว่า บน router ที่ `.route` ถูกปฏิเสธ `get`/`head` ก็ถูกปฏิเสธด้วยเป็นผลพลอยได้
ปลอดภัยเพราะไม่มีใคร mount read route บน `apiRouter` หลัง boot — และรูปแบบใหม่ข้างบน
ทำให้ `_router.route().get` ผ่าน ซึ่งจำเป็น

**`param` ไม่ถูก seal** — ยืนยัน `MOUNTED app.param` และ `MOUNTED api.param` ·
**ไม่ block**: `param` ไม่ mount route ใหม่ ไม่เพิ่ม surface ให้ `routeGateSweep` มองไม่เห็น ·
แต่มันแทรก middleware ที่รันก่อน handler ของ route ที่มีอยู่ ซึ่งเป็นการเปลี่ยนพฤติกรรม
หลัง boot · **ลง residual พร้อมเทส assert ว่ามันยัง mount ได้** ตามรูปแบบเดิม

# Ledger — #119 (seal `use(subRouter)` recursively)

Reclassified to `auth` tier by PMO — a guard on the surface that mounts routes.

## What made this closeable, measured

Ruling: a ROUTER is distinguishable from ordinary middleware at mount time, measured on express
4.22.1 rather than assumed:

    app.use(express.json())     → function, no .stack   → middleware
    app.use("/api", subRouter)  → function, has .stack  → router

That is the whole basis for the fix. #98 left `use` open because sealing it outright refuses the
static handler, the body parsers and the SPA catch-all — correct code — and a guard that fires on
correct code is removed within a week. The rule is therefore narrow: refuse a router, pass
everything else through untouched. — ถ้าผิด: guard ที่ยิงใส่โค้ดที่ถูกต้อง แล้วโดนถอดทิ้งใน
สัปดาห์เดียว = แย่กว่าไม่มี guard

Ruling: `isRouter` is STRUCTURAL, not `instanceof`. Express's Router is a function with a prototype
rather than a class, and a router created by a different copy of express in a nested `node_modules`
would fail an identity check while behaving identically. — ถ้าผิด: bypass ที่เปิดขึ้นเองเมื่อมี
express สองชุดในทรี

Ruling: a router is REFUSED, not sealed-and-mounted. Its routes already exist by the time it is
handed over — nobody mounts an empty router — and those routes never crossed a sealed method, so
`routeGateSweep` cannot see them. Sealing it and letting it mount would leave exactly the
invisibility this closes.

Ruling: the seal is ALSO applied to the refused router, recursively. A caller that keeps the
reference and writes to it afterwards is refused, and so is a router mounted into it. One level
would leave `outer.use("/in", inner)` as the next bypass — one line longer than the one being
closed. — ถ้าผิด: ปิดรูหนึ่งแล้วเปิดรูที่ยาวกว่าเดิมหนึ่งบรรทัด

Ruling: `get`/`head` stay unsealed, unchanged from #98. `index.js` legitimately mounts
`app.get("/robots.txt")`, `app.get("/manifest.json")` and `app.use("/")` after the seal point.
Verified by booting the real app in `NODE_ENV=production` — it boots, with the static handler and
the SPA catch-all mounted.

## The two inverted assertions

Ruling: `routeMountGuard.test.js`'s two RESIDUAL tests asserted these mounts SUCCEED. #98 wrote them
that way deliberately — "if someone later closes this hole, they go red and force a deliberate
decision instead of leaving a stale claim about coverage lying around". One is inverted here, and
the inversion is the record of the decision. The other stays.

## Residual, still open and still asserted as such

**A sub-router captured BEFORE the seal keeps an unsealed handle.** The seal holds references; a
router grabbed earlier is outside it, and #119 does not close it because such a router is never
handed to `use` while the seal is armed — there is no moment at which to seal it. Closing it means
sealing at CONSTRUCTION, which is a different change. No module in the tree does this. Its test
still asserts the current behaviour, so it too inverts if anyone closes it.

## Evidence

`routeMountGuard.test.js` **32 passed** (29 before + 3 net; two rewritten). With
`routeGateSweep.test.js`: **65 passed**.

RED before implementation: 3 failed — the sub-router refusal, the depth case, and the prebuilt
router. The middleware tests passed BEFORE the change too, which is the point: they pin behaviour
that must not change.

Real app boots under `NODE_ENV=production` with 16 top-level layers.

### Mutations — each named at the test it takes red (§7.9f)

| mutation | test that goes red |
|---|---|
| seal `use` unconditionally (drop the `isRouter` filter) | `ordinary middleware still mounts after boot`, `index.js's own post-boot mounts still work on the real app`, `read methods still mount — index.js mounts app.get AFTER the seal point`, `a READ route added after boot still works, on the real app` |
| drop the recursive seal | `DEPTH: a router mounted onto a router mounted after boot is sealed too` |

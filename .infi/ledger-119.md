# Ledger — #119 (seal `use(subRouter)` recursively)

Reclassified to `auth` tier by PMO — a guard on the surface that mounts routes.

## What made this closeable, measured

Ruling: a ROUTER is distinguishable from ordinary middleware at mount time — but NOT by `.stack`.
TL-2's pre-read said `.stack` is wrong in both directions; re-measured here on express 4.22.1
rather than taken on trust:

    object                        .stack     has a SEALED_METHOD
    express.Router()              true       true
    express() sub-app             FALSE      true    <- false negative
    express.json() / static / fn  false      false
    Object.assign(fn,{stack:[]})  TRUE       false   <- false positive

A sub-app keeps its layers under `._router`, which does not exist at all until its first route
mounts. So the discriminator is `SEALED_METHODS.some(m => typeof value[m] === "function")` —
the question the seal actually needs answered, since sealing IS replacing those methods, and it
needs to know nothing about where express stores layers. #98 left `use` open because sealing it outright refuses the
static handler, the body parsers and the SPA catch-all — correct code — and a guard that fires on
correct code is removed within a week. The rule is therefore narrow: refuse a router, pass
everything else through untouched. — ถ้าผิด: guard ที่ยิงใส่โค้ดที่ถูกต้อง แล้วโดนถอดทิ้งใน
สัปดาห์เดียว = แย่กว่าไม่มี guard

Ruling: `isRouter` is STRUCTURAL, not `instanceof`. Express's Router is a function with a prototype
rather than a class, and a router created by a different copy of express in a nested `node_modules`
would fail an identity check while behaving identically. — ถ้าผิด: bypass ที่เปิดขึ้นเองเมื่อมี
express สองชุดในทรี

Ruling: the argument is BOTH sealed AND refused. TL-2 ruled "seal the argument, then call the
original"; measured, that alone is not enough — seal a router that was populated BEFORE the mount,
mount it, and `POST /api/x/deep` answers **200**, because its routes never crossed a sealed method
and `routeGateSweep` cannot see them. Refusing alone is not enough either: TL-2 drove an EMPTY
router, mounted then filled, to 200 on the #98 SHA, and recursion cannot help because the stack it
would walk is empty at the moment it is read. Both halves are load-bearing and each has a mutation
that names its test. — ถ้าผิด: ปิดได้สองในสามรูปทรง แล้วอธิบาย residual ที่เหลือไม่ได้

Ruling: the seal walks nested routers, reading `.stack` OR `._router.stack`, defensively. One level
would leave `outer.use("/in", inner)` as the next bypass. Here `.stack` is legitimate — it is not
being used to decide WHAT something is, only to find children of something already known to be
sealable.

Ruling: the sealed sub-router gets `.route` as well as `SEALED_METHODS`. #98 closed
`.route(p).post()` because `.route()` hands out a fresh Route the seal never wrapped; a sub-router
without it is the identical hole one level down (TL-2's F9).

Ruling: `ROUTE_MOUNT_GUARD=off` disables the recursion too. An escape hatch that switches off only
the top layer leaves a deployment that set the flag to get moving still throwing from a sealed
sub-router, in a way nothing in the message explains.

Ruling: `get`/`head` stay unsealed, unchanged from #98. `index.js` legitimately mounts
`app.get("/robots.txt")`, `app.get("/manifest.json")` and `app.use("/")` after the seal point.
Verified by booting the real app in `NODE_ENV=production` — it boots, with the static handler and
the SPA catch-all mounted.

## The two inverted assertions

Ruling: `routeMountGuard.test.js`'s two RESIDUAL tests asserted these mounts SUCCEED. #98 wrote them
that way deliberately — "if someone later closes this hole, they go red and force a deliberate
decision instead of leaving a stale claim about coverage lying around". One is inverted here, and
the inversion is the record of the decision. The other stays.

## QA-2 round 2: `app` is a facade, `app._router` is the object

QA-2 rejected `c44b059d3`. Reproduced exactly: with only the facade sealed,
`app._router.post`, `.all`, `.route().post` and `.use(subRouter)` all mounted with no throw, and a
handler forced on that way answered over HTTP with its own marker.

Ruling: `_router` is sealed from INSIDE `sealRoutes`, not by adding it to the call site. No caller
should have to know express keeps a second object, and a target whose `_router` does not exist yet
(express creates it lazily on the first route) is skipped rather than crashing boot. — ถ้าผิด:
call site ต้องรู้เรื่องภายในของ express และ app ที่ยังไม่มี route จะ boot ไม่ขึ้น

Ruling: `_router.route()` is KEPT and hands back a SEALED Route, instead of being refused like
`app.route()` is. TL-2 measured, and so did I, that the one-line
`sealRoutes(app, app._router, apiRouter)` breaks the app: `app.get` is implemented as
`this._router.route(path).get(...)`, so refusing `_router.route` refuses every read mount —
`robots.txt`, `manifest.json` and the SPA catch-all (`index.js:171,175`, all after the seal) all
throw. Reads mount; `_router.route("/x").post(h)` does not. — ถ้าผิด: guard ที่ทำให้ production ไม่ boot

Ruling: probe `_router` only, never `target.router`. Express 4 defines `app.router` as a getter that
THROWS a deprecation error the moment it is read (`application.js:131`) — measured: every seal test
failed with that error until the probe was narrowed. — ถ้าผิด: guard พังตอน boot ด้วย error ที่ไม่
เกี่ยวกับ guard เลย

## Residual, still open and still asserted as such

**`param()` is not sealed**, on the app or on a router. It registers a callback for a route
parameter — it mounts no route and adds no verb, so it cannot make an ungated endpoint reachable.
Left alone rather than swept in for symmetry, with a test asserting it still mounts, so the claim
inverts if anyone closes it.

**A router captured BEFORE the seal, and never handed to `use` again, keeps an unsealed handle.**
The seal holds references; a router grabbed earlier is outside it, and there is no moment at which
to seal it. Closing it means sealing at CONSTRUCTION, a different change. It takes two deliberate
steps — hold a reference across boot, then add a route — and no module in the tree does either,
unlike the three shapes above, which ordinary code reaches by accident. Its test still asserts the
current behaviour, so it inverts too if anyone closes it.

TL-2 flagged a LARGER residual than the one #98 recorded — the empty-router-filled-afterwards
shape, which is neither "captured before seal" (it is created after) nor reachable by recursion.
That one is CLOSED here, by sealing the object rather than walking its stack. F3 is its fixture.

## Evidence

`routeMountGuard.test.js` **44 passed**. With `routeGateSweep.test.js`: **77 passed**.

RED against the seal as #98 shipped it: **8 failed**, each named —
`a sub-router use()d after boot is refused`, `DEPTH: a router mounted onto a router mounted after
boot is sealed too`, `a router built and populated BEFORE being use()d is refused as a whole`,
`F2: an express() SUB-APP is refused too, though it has no .stack`, `F3: a router mounted EMPTY and
filled afterwards is refused at both moments`, `F9: .route() on a refused sub-router is sealed too`,
`F7: nesting is sealed at depth, through a router that was ALREADY populated`, `F4: none of the
refused shapes ANSWERS over HTTP`. The first three are #98's own "these DO mount" assertions,
inverted in this commit (TL-2's F8). The middleware tests passed before the change too, which is the
point: they pin behaviour that must not change.

**F4's first oracle was wrong and was replaced.** It asserted `status !== 200`; measured,
`POST /api/never-mounted-at-all/deep` also answers 200, because `index.js` mounts a terminal
`app.all("*")` before the seal — so the assertion passed for a route that does not exist and for one
that does. It now asserts on a marker only each handler can produce, plus a control proving the
marker discriminates.

Real app boots under `NODE_ENV=production` with 16 top-level layers.

### Mutations — each named at the test it takes red (§7.9f)

| mutation | tests that go red |
|---|---|
| discriminate by `Array.isArray(value.stack)` again (the version TL-2 rejected) | `F2: an express() SUB-APP is refused too, though it has no .stack`, `F4: none of the refused shapes ANSWERS over HTTP` |
| seal the argument but do NOT refuse the mount (TL-2's ruling taken literally) | 8 red, incl. `F3`, `F4`, `F7`, `F9` and all three inverted #98 assertions |
| refuse the mount but do NOT seal the argument | 6 red, incl. `F3: a router mounted EMPTY and filled afterwards is refused at both moments`, `F9`, `F7`, `F4` |
| drop the nested walk (seal only the argument handed to `use`) | `F7: nesting is sealed at depth, through a router that was ALREADY populated` |
| leave the recursion armed when `ROUTE_MOUNT_GUARD=off` | `ROUTE_MOUNT_GUARD=off leaves a use()d sub-router mountable AND writable` |
| do not seal `_router` at all (= `c44b059d3`, QA-2's finding) | `the four shapes QA-2 mounted are all refused`, `HTTP: a route forced onto _router does not answer with its own marker`, `a Route from the sealed factory takes reads and refuses writes` |
| seal `_router` the ORDINARY way, refusing `.route()` (TL-2's rejected one-liner) | `production boots, and READ routes stay mountable on the real app afterwards`, `a READ route added after boot still works, on the real app`, `index.js's own post-boot mounts still work on the real app`, `read-only mounts are unaffected, since index.js depends on them`, `the legitimate post-boot mounts index.js makes all still work`, `a Route from the sealed factory takes reads and refuses writes` |
| the sealed factory returns an UNSEALED Route | `the four shapes QA-2 mounted are all refused`, `a Route from the sealed factory takes reads and refuses writes` |

The last one first appeared to SURVIVE. It had not run: the edit was applied at the wrong
indentation and silently matched nothing. A mutation that does not change the file is not a
survivor, and "all green" after one is worth exactly nothing — checked by grepping for the deleted
line before trusting the result.

Two of these — seal-only and refuse-only — are the halves of TL-2's proposal and of my first
attempt respectively. Neither is sufficient alone, which is the finding.

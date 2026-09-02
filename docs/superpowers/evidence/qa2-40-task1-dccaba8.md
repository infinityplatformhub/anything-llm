# QA-2 — #40 task 1 `dccaba8` — PASS (superseded: bypass #14 `module.require` found after; next SHA re-probe)

Probe 33/33 · mutation 11/12 caught (1 equivalent) · ไม่รัน full suite (§7.14) · เขียนโดย PMO จากข้อความ QA-2

## ประวัติ
| SHA | ผล |
|---|---|
| `3d29de9` | FAIL — regex single-arity, `/api/v1` ไม่เข้า sweep และไม่เข้า `skipped` |
| `e875cd1` | PASS แต่ถอน — bypass 7 `isApiKeyGuard` property ปลอมได้ |
| `91fbf57` | ไม่ใช่ gate SHA — defineProperty ยังไม่ลง |
| `dccaba8` | PASS (แล้ว hold: bypass #14 `module.require`) |

## bypass 8 ปิดที่ราก
regex หายทั้งหมด — `index.js` export `ENDPOINT_REGISTRATIONS` helper เดิน list ตรง ๆ · probe: helper เดินตัวเดียวกับ production (`toBe`) · ทุก entry callable + มีชื่อ · `developerEndpoints` ต้อง `withApp: true` (bare function → `if (!router) return;` กลืนเงียบ, M2 แดง 9)

## bypass 7 ปิดจริง
`isApiKeyGuard` = `typeof fn === "function" && apiKeyGuards.has(fn)` WeakSet ปัก defineProperty(writable:false, configurable:false) · E1/E2 เขียวเองโดยไม่แก้เทส · resolver registry ปักเหมือนกัน · org-spoof 7 เคส + CONTROL

## Mutation 12
caught: ลบ developerEndpoints (9) · bare function (9) · ถอด guard 1 route /v1 (1) · scope `"*"` (1) · predicate อ่าน property (7) · guard ไม่ enrol (4) · isOrgResolver เทียบชื่อ (1) · ถอด defineProperty (2) · helper เลิก splice apiRouter.stack (8) · helper กลืน error ของ registration (2, หลังเพิ่มเคส)
equivalent: isOrgResolver ทิ้ง `typeof === "function"` — `WeakSet.has()` คืน false กับ non-object ไม่ throw

## ช่องที่ปิดหลัง mutation รอบแรก
M8 รอด: assert `skipped.filter(≠agentWebsocket) === []` ผ่านด้วย array ว่าง = helper กลืน error ดูเหมือนไม่มีอะไรพัง (รูปเดียวกับ bypass 8) · เพิ่ม: registration ที่ throw ต้องโผล่ใน `skipped` พร้อมชื่อ+error · CONTROL `agentWebsocket` ต้องอยู่ใน `skipped` จริง

## KNOWN DIVERGENCE
`index.js:141` ส่ง `apiRouter` ให้ entry; helper ส่ง `app` แล้ว splice `apiRouter.stack` — middleware บนตัว `apiRouter` (`index.js:101` rate limit `/v1`) ไม่อยู่บน path ที่ sweep เดิน · gate วันนี้ per-route จึงไม่พลาด แต่ router-level `use()` ในอนาคต sweep จะมองไม่เห็น — pin เป็นเทส (ดู #86)

# QA-2 — #40 task 1 `a2bbb0de` — PASS (lane: production router walk; excludes singleUserRouteShapeB — see QA-3 FAIL)

Probe 37/37 · mutation 11/11 · ไม่รัน full suite (§7.14) · เขียนโดย PMO จากข้อความ QA-2

## ดีไซน์: `buildRouter` คืน `app` จริงจาก `index.js` (cache-bust require) + frozen list — ไม่มี sweep แยกที่ drift ได้ ปิดตระกูล bypass 8/14 ทั้งหมด
## ประวัติ: 3d29de9 FAIL · e875cd1 PASS ถอน (bypass 7) · 91fbf57 ไม่ใช่ gate · dccaba8 superseded (bypass 14) · a2bbb0de PASS
## ยิง 37: A app `toBe` production, list frozen, entries callable+named, terminal 404 wildcard เดียวท้ายสุด · B/C `/v1` 60+ routes guard+scope ไม่ใช่ `"*"` + C0 vacuity ≥37 · D/F WeakSet identity, resolver spoof 4 รูป, bucket เดียว · E registry pinned (KNOWN LIMIT `.add()` ยังทำได้) · G R-1..R-6 รวม X1 inline, sub-router, snapshot นิ่งข้าม tick
## Mutation 11/11: ลบ developerEndpoints · bare fn · unfreeze · ถอด guard · scope `"*"` · property predicate · guard ไม่ enrol · isOrgResolver ชื่อ · ถอด pin · helper คืน app เปล่า (13 แดง) · wildcard ตัวสองก่อน terminal
## บั๊ก probe: walk ชั้นบนเห็น 4/309 (R-3 เกิดกับ probe เอง → recursive) · frozen index assign เป็น no-op นอก strict (assert ค่าไม่เปลี่ยน)

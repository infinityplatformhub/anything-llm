# QA-2 — #80 `e1bf4adb` — PASS (lane: invite mail + rate limit)

Probe 21/21 · mutation 5/5 · ไม่รัน full suite (§7.14) · เขียนโดย PMO จากข้อความ QA-2

## FAIL เดิมปิด
`inviteMailRateLimit` mount ที่ `endpoints/admin.js:301` ผ่าน `whenMailing` (`requestControls.js:269-274` อ่าน `request.body?.email` ข้ามเมื่อไม่มี/ว่าง)

## ยิงจริง (7 เคสใหม่)
limit=2 → ครั้งที่ 3 429 · 429 แล้วไม่มีเมลออก · 429 แล้วไม่สร้าง invite row · copy-link 5 ครั้งที่ limit=1 → 200 หมด · `email: ""` ไม่ถูก meter · CONTROL: งบเมลหมดแล้ว copy-link ยัง 200 · assert เชิงโครงสร้างว่า limiter มี call site (mutation จับ inert guard ไม่ได้)

## ส่วนที่เหลือ lane ผ่านเหมือน 719b7eee
`/v1` 400 ไม่มีเมล/ไม่มี row · QP decode ก่อน grep + CONTROL · RCPT เดียว · password ไม่อยู่ในบอดี้ · `user.manage` แยกจาก `invite.create` + control · channel ปิด → 4xx

## Mutation 5/5
ถอด mount · `whenMailing` ข้ามเสมอ · meter copy-link · `""` นับ · ถอดทั้งบรรทัด

## นอก lane (ไม่ได้ตรวจ)
listing mask (`models/invite.js`) และ `endpoints/mailer.js` — ครอบโดย QA-1/QA-3/TL-1/TL-2

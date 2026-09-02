# #50 ledger — delete simple-SSO

Ruling: (a) fix predicate ของ `simpleSSOLoginDisabledMiddleware` (raw isMultiUserMode →
isConfirmedSingleUser) แยกเป็น issue ใหม่ ไม่ทำใน #50 — PMO ruling. #50 ไม่แตะฟังก์ชันนั้น
ถ้าผิด: shape (b) ยัง fail-OPEN ข้าม NO_LOGIN block ต่อไปจนกว่า issue ใหม่จะปิด แต่เป็น
สถานะเดิมก่อน #50 ไม่ใช่ regression ที่ #50 สร้าง

Ruling: (b) `sso.issue` ถูกบังคับที่ route จริง วัด 4 จุด — scopes.js:19 mapping,
validApiKey.js:113 throw ตอน mount ถ้า scope ว่าง, :137 `context.scopes.includes(action)`
ไม่มี wildcard (PR-4c), :147/:160 → 403 ก่อน handler. exit condition ที่ ssoIssuanceLock
เขียนไว้เองครบ ลบได้ ถ้าผิด: #8 (API key ใดๆ impersonate user ใดก็ได้) เปิดกลับ

Ruling: (A) ลบ `GET /v1/users/:id/issue-auth-token` ทั้ง route ไม่ใช่แค่ถอด middleware —
PMO ruling หลังผมรายงาน blocker. เหตุผล: route นี้ mint temp token ที่มีที่แลกเดียวคือ
`/request-token/sso/simple` ซึ่งกำลังถูกลบ เก็บไว้ = endpoint ที่ mint credential โดยไม่มี
ใครแลกได้ + คืน loginPath ชี้ไป 404. ขัด recon §1/§4 เดิม (PMO แก้ recon เอง)
ถ้าผิด: breaking change ของ public API `/v1/**` แต่ route ถูก ssoIssuanceLock ปิดมาตลอด
(SIMPLE_SSO_ISSUE_UNSAFE_ALLOW ไม่เคยตั้ง) = ไม่มี consumer ภายนอกจริง

Ruling: `simpleSSOEnabled.js` ไม่ถูกลบ ลบเฉพาะฟังก์ชัน `simpleSSOEnabled` —
recon §3. `simpleSSOLoginDisabled` + `simpleSSOLoginDisabledMiddleware` ยังถูกใช้ที่
`endpoints/admin.js:39`, `endpoints/invite.js:7`, `system.js:236`
ถ้าผิด: ลบไฟล์ทั้งใบจะเอา protection ของ invite flow ออกไปเงียบๆ

Ruling: `SIMPLE_SSO_ENABLED` / `NO_LOGIN` / `NO_LOGIN_REDIRECT` คงไว้ทั้งใน updateENV
allowlist และ .env.example ทั้งสองไฟล์ — วัดแล้ว `.env.example` แก้ = ศูนย์ ตามที่ recon §3
ทำนายไว้ `SIMPLE_SSO_ISSUE_UNSAFE_ALLOW` ไม่อยู่ใน .env.example ไฟล์ไหนเลย (undocumented
โดยตั้งใจ) ถ้าผิด: diff ที่ลบ env key ที่ยังถูกอ่านอยู่ = สิ่งที่ §3 มีไว้กันพอดี

Ruling: `frontend/src/pages/Login/index.jsx` ต้องแก้ ไม่ใช่แค่ลบ path helper — ไม่อยู่ใน
recon §1. เดิมเมื่อ `enabled && noLogin` และไม่มี noLoginRedirect มันจะ Navigate ไป
`paths.sso.login()` ซึ่งตอนนี้เป็น route ที่ถูกลบ ผลคือหน้าขาว "No token provided."
เปลี่ยนเป็นข้อความบอกตรงๆ ว่า credential login ถูกปิด ถ้าผิด: ผู้ใช้บน instance ที่ตั้ง
NO_LOGIN เจอหน้าตายที่ไม่บอกอะไรเลย

Ruling: count guard 2 ตัวอัปเดตแทนที่จะปิด — `apiRouteAuthSweep` 63→62,
`routeScopes` EXPECTED ถอด 1 บรรทัด. ทั้งคู่เป็นด่านที่ตั้งใจให้แดงเมื่อ route
เปลี่ยนจำนวน การอัปเดตคือการใช้งานตามที่ออกแบบ ไม่ใช่การหลบ ถ้าผิด: ถ้าปิดด่านแทน
route ที่หายไปโดยไม่ตั้งใจครั้งหน้าจะไม่มีใครเห็น

Ruling: swagger regenerate ด้วย `yarn swagger` (PMO ruling c) ผล generated commit มาด้วย
วัดแล้ว diff = 59 deletions / 0 additions ทั้งหมดอยู่ใต้ `"/v1/users/{id}/issue-auth-token"`
ถ้าผิด: diff ที่มี addition แปลว่า generator เปลี่ยนอย่างอื่นไปด้วย ต้องดูก่อน commit

Ruling: `identity.js:138` ใส่ comment ว่าเป็น consumer เดียวที่เหลือของ
`TemporaryAuthToken.validate` และ token ไม่เคยออกนอกฟังก์ชัน (issue+validate ใน request
เดียวกัน) ถ้าผิด: คนอ่านทีหลังนึกว่ายังมี HTTP entry point แล้วออกแบบทับ

## RED
- `issueAuthTokenWiring.test.js` (เขียนใหม่จาก `ssoIssuanceHotfix.test.js`): คืน route +
  scope mapping กลับ → 2 failed / 1 passed. control "sibling routes still register"
  เขียว = การหายไปของ route ไม่ได้มาจาก exception ตอน mount
- `ssoIssueScopeInert.test.js`: key เดิมที่ถือ `sso.issue` + `user.read` ยังเรียก
  `user.read` ได้ 200 และ `sso.issue` เดี่ยวๆ ถูกปฏิเสธ 403 เหมือน scope ที่ไม่มี
  → scope ที่ปลดระวางแล้วเป็น inert ไม่ทำให้ key พัง

## GREEN
`Tests: 1340 passed, 1340 total` / `Test Suites: 132 passed, 132 total` fresh DB

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

## Ruling รอบ 2 (Techlead pre-check → PMO) — commit ที่สอง

Ruling: (1) เก็บ frontend redirect ไม่ทิ้ง — ที่ผมทำใน abf6cae7 (แทนด้วยข้อความ) ผิด
operator ที่ตั้ง NO_LOGIN โดยไม่มี redirect URL จะล็อกเอาต์ตัวเอง. เปลี่ยนเป้า
`paths.sso.login()` → `/api/sso/:provider/login` ของ provider แรกที่ enabled
ต้องเพิ่ม `SSOProviders` ใน `SystemSettings.currentSettings()` เพราะ frontend
ไม่เคยมีทางรู้ว่า provider ไหน enabled (ไม่มี endpoint ไหน expose มาก่อน)
ส่ง id อย่างเดียว ไม่ส่ง issuer/client id เพราะ payload นี้ unauthenticated
ถ้าผิด: หน้า login พาไป provider ที่ปิดอยู่ → 404 แทนที่จะเป็นข้อความบอกสาเหตุ

Ruling: fallback เมื่อไม่มี provider เลย = ข้อความ (ไม่ใช่ redirect ไปไหน) เพราะ
NO_LOGIN + ไม่มี IdP + ไม่มี redirect URL = instance ที่เข้าไม่ได้จริง ๆ ต้องบอกตรง ๆ
ว่าต้อง enable provider หรือ unset NO_LOGIN ถ้าผิด: หน้าขาวแบบเดิม

Ruling: (2) `simpleSSOEnabled.js:66` แก้ใน #50 (ยกเลิก issue แยกตาม ruling (a) เดิม)
→ `!(await isConfirmedSingleUser())` ตาม #58 rulings A/B. ไฟล์ไม่ต้อง require
SystemSettings อีกต่อไป ถ้าผิด: shape (b) ยัง fail-OPEN — ข้าม NO_LOGIN block
บน instance ที่ session layer ถือว่า multi-user = credential login เปิดอยู่ทั้งที่
operator สั่งปิด

Ruling: (3) `sso.issue` ลบผ่าน migration slot ใหม่ 090000 ไม่แก้ 020000/045000
(applied migration = immutable, `_prisma_migrations` เก็บ checksum)
ลำดับใน migration: `role_permissions` ก่อน `permissions` เพราะไม่มี ON DELETE CASCADE
(020000:33-39) ลบสลับลำดับ = orphan rows ถ้าผิด: FK ค้าง ชี้ไป id ที่ไม่มีแล้ว

Ruling: key ที่เหลือ scope ว่างหลัง strip → ปล่อยเป็น `[]` **ไม่ revoke** (PMO ruling)
+ migration RAISE NOTICE บอก count และ keyPrefix ทุกตัวที่กลายเป็น `[]`
ถ้าผิด: revoke = ตัดสินใจแทน operator และย้อนไม่ได้ ส่วน `[]` เห็นได้และแก้ได้

Ruling: (4) property "middleware ที่ปฏิเสธต้องมาก่อน" ย้ายจาก `ssoIssuanceHotfix.test.js`
ไปเป็น sweep ใน `apiRouteAuthSweep.test.js` — assert `mw[0].name === "apiKeyRequired"`
ทุก /v1 route (62 route) เทียบชื่อเพราะ validApiKey เป็น factory คืน named function
expression identity comparison ใช้ไม่ได้ ถ้าผิด: guard อยู่ position 2 = มีอะไรรันก่อนมัน

Ruling: (5) single-use ของ TemporaryAuthToken ผ่าน HTTP ย้ายไป
`identityRoutesHttp.test.js` (OIDC callback) เพราะ `ssoIssuanceLockHttp.test.js`
ที่ถูกลบเป็นที่เดียวในทั้ง tree ที่พิสูจน์ property นี้ผ่าน HTTP และ OIDC พึ่ง property
เดียวกัน ถ้าผิด: property หายไปเงียบ ๆ พร้อม feature ที่บังเอิญเป็นคนถือเทสไว้

Ruling: `t1-authz-migration.test.js:173` แก้ assertion ไม่ใช่แก้ migration —
suite นี้ replay step-7a ของ 020000 **หลัง** `migrate deploy` เพื่อจำลอง legacy state
ซึ่ง re-INSERT vocabulary รวม `sso.issue` ที่ 090000 เพิ่งลบ. บน boot จริง migration
รันตามลำดับและแถวนั้นหายจริง (พิสูจน์ใน ssoIssueRetirement.test.js ที่รัน migrate deploy
ล้วน) จึงเป็น artifact ของการ rewind ไม่ใช่ drift ระหว่าง seed กับ schema
assertion ใหม่ยังตรวจว่า replayed row เป็นความต่างเพียงอย่างเดียว
ถ้าผิด: ถ้าไปแก้ migration แทน จะทำลาย property ที่ 020000 ต้องมี

Ruling: `SIMPLE_SSO_NO_LOGIN_REDIRECT` **ไม่ลบ** ทั้งที่ ruling บอกว่าลบได้ตัวเดียว —
วัดแล้วยังถูกอ่านอยู่ 4 จุด (`systemSettings.js:1160,1163`, `useSimpleSSO.js:25`,
`Login/index.jsx:26-27`) และเป็นทางที่ ruling (1) สั่งให้เก็บไว้ (redirect URL ของ
operator ชนะ provider default) ลบ = ทำลาย ruling (1) เอง เปลี่ยนเป็นแก้ comment
ใน .env.example ทั้งสองไฟล์ให้ตรงความหมายใหม่แทน ถ้าผิด: operator ที่ตั้ง URL ไว้
จะถูกพาไป provider แทน URL ตัวเอง

## RED รอบ 2
- predicate: revert `simpleSSOEnabled.js:66` กลับเป็น raw → 1 failed / 3 passed
  ตัวที่แดงคือ "NO_LOGIN enforced in shape (b)" ส่วน control 3 ตัวเขียว (fixture
  เป็น shape (b) จริง, ไม่ตั้ง flag ต้องผ่าน, ตั้งแค่ ENABLED ต้องผ่าน) — control
  ชุดนี้จำเป็นเพราะ guard ที่เขียนผิดเป็น "block เสมอ" จะผ่านเทสหลักแต่พังทุก login

## GREEN รอบ 2
`Tests: 1351 passed, 1351 total` / `Test Suites: 133 passed, 133 total` fresh DB
migration 090000 + full migrate deploy

## Ruling รอบ 3 (PMO ack)

Ruling: `SIMPLE_SSO_NO_LOGIN_REDIRECT` เก็บ (PMO ยืนยันตามที่ผมเสนอ) — มันคือ
operator override ของ ruling (1) แก้ comment ใน .env.example พอ

Ruling: assertion ใน `t1-authz-migration.test.js` ถูกต้องแล้ว (artifact ของ replay)
comment อธิบายเหตุผลอยู่ที่ assertion แล้วตั้งแต่รอบ 2

Ruling: เพิ่มเทสยืนยันว่า `SSOProviders` payload ไม่มี issuer/clientId/secret —
`GET /setup-complete` เป็น unauthenticated endpoint ที่หน้า login อ่านก่อนใครจะ sign in
ดังนั้น field นี้ส่งได้แค่ provider id. เทสยืนยันการ**ไม่มี**อยู่ เพราะการแก้ในอนาคตแบบ
"ใส่ issuer ไปด้วย มันก็ public อยู่แล้ว" คือทางที่ข้อมูลนี้รั่วจริง ๆ
+ เทสว่ารายการ truthy spelling ตรงกับ `providerConfig()` ใน endpoints/identity.js
(ถ้าไม่ตรง หน้า login จะเสนอ provider ที่ route ปฏิเสธ หรือซ่อนตัวที่ใช้ได้)
ถ้าผิด: internal issuer URL และ client id หลุดให้คนที่ยังไม่ได้ login เห็น

RED: เปลี่ยน `ssoEnabledProviders()` ให้คืน `{id, issuer}` → 3 failed / 1 passed
ตัวที่แดงรวม "carries no issuer" ตัวที่เขียวคือ provider ที่ปิดอยู่ (ยังไม่ควรโผล่)

GREEN: `Tests: 1355 passed, 1355 total` / `Test Suites: 134 passed, 134 total`

## Gate fixes (§7.3a + §5.1)

Ruling: §7.3a — describe/test title ขึ้นต้น `#` เปลี่ยนเป็น "issue 50:" 6 จุด
(5 ไฟล์) commented-code gate อ่าน `#` บนบรรทัดที่ลงท้าย `{` เป็นคอมเมนต์
เหลือ 3 จุดใน tree ที่ขึ้นต้นด้วยข้อความอื่นแล้วมี `#` กลางประโยค
(`hypervisor.test.js:99`, `MCP/index.test.js:125`, `chat/index.test.js:321`)
ไฟล์เก่าที่ผมไม่ได้แตะ ไม่อยู่ใน diff นี้ ไม่แก้

Ruling: §5.1 model imports — สาเหตุจริงไม่ใช่ "ไม่มี require" อย่างที่ report บอก
`check-model-imports.sh:30` grep หาชื่อ model **บนบรรทัดเดียวกับ** `require(`
destructure หลายบรรทัดทำให้ `= require(...)` อยู่คนละบรรทัดกับ `SystemSettings`
gate เลยมองไม่เห็น แก้เป็น single-line require 2 ไฟล์ (`noLoginShapeB.test.js`,
`ssoProvidersPayload.test.js` — ตัวหลัง report ไม่ได้ระบุ เจอตอนรัน gate เอง)
**ไม่ย้ายไป top-level** เพราะ §7.10: `jest.resetModules()` รันใน beforeAll
top-level require จะ bind prisma singleton กับ database ผิดก่อน test DB จะมีตัวตน
ใส่ comment ที่ require บอกทั้งสองเหตุผล ถ้าผิด: ย้ายขึ้น top-level = suite เขียว
แต่เขียนลง database ที่ใช้ร่วมกัน (บั๊กเดียวกับที่ QA-1 เจอใน #31)

GREEN: `bash scripts/check-local.sh` → all checks passed
`Tests: 1355 passed, 1355 total` / `Test Suites: 134 passed, 134 total`

## Rebase ทับ #43 (SAML)

Ruling: `ssoEnabledProviders()` ไม่ต้องแก้หลัง #43 register SAML — วัดแล้วด้วย probe จริง
(`SSO_SAML_ENABLED=1` → `["saml"]`, ทั้งคู่ → `["oidc","saml"]`) เพราะ helper derive
จาก registry + convention `SSO_<ID>_ENABLED` ซึ่งตรงกับ `samlEnabled()` ใน
`endpoints/identity/saml.js:86-90` พอดี เพิ่มเทสตรึงไว้แทนการเชื่อ
ถ้าผิด: หน้า login ส่งคนไป providers[0] — list ที่ว่างเปล่าเงียบ ๆ = คนเข้าไม่ได้

Ruling: worktree s50 ต้อง `yarn install` ใหม่หลัง rebase — #43 เพิ่ม `xml-crypto`
และ `@xmldom/xmldom` ใน package.json แต่ node_modules ของ worktree ไม่ได้ตามมา
เจอตอน probe: `systemSettings.js` → registry → SamlIdentityProvider → xml-crypto
พังทั้ง chain ไม่ใช่แค่ SAML ถ้าผิด: gate ที่รันบน worktree ที่ deps ไม่ครบจะ
แดงด้วยเหตุผลที่ไม่เกี่ยวกับ diff เลย

GREEN หลัง rebase: `Tests: 1546 passed, 1546 total` / 150 suites + check-local ผ่าน

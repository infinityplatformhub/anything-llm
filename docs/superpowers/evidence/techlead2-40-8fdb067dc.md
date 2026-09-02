# Techlead-2 — #40 task 1 `8fdb067dc` (merge onto main): **PASS**

รีวิว merge commit `8fdb067dc` (parents `4899db017` = main-at-merge-base, `6038e1179` = branch tip)
บน worktree แยก `/tmp/tl2-40r` — ไม่แตะ checkout หลักและไม่แตะ worktree ของ dev คนไหน

```
git worktree add --detach /tmp/tl2-40r 8fdb067dc
cp -al /tmp/qa2-84b/server/node_modules /tmp/tl2-40r/server/node_modules   # donor ที่มี ldapts + prom-client
cd /tmp/tl2-40r/server && npx prisma generate
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" STORAGE_DIR=$(mktemp -d) \
       SIG_KEY=$(openssl rand -hex 32) SIG_SALT=b API_KEY_PEPPER=$(openssl rand -hex 32) \
       JWT_SECRET=test-jwt-secret-at-least-12-chars \
       DATABASE_URL="postgresql://postgres:pw@127.0.0.1:55472/t5"
npx jest __tests__/security/authorization/routeGateSweep.test.js \
         __tests__/endpoints/apiRouteAuthSweep.test.js \
         __tests__/security/authorization/singleUserRouteShapeB.test.js \
         __tests__/security/authorization/workspaceCapabilities.test.js --runInBand
```

**baseline: 4/4 suites, 88/88 tests, 0 failed, 0 runtime error** (วัดซ้ำหลัง mutation ครบ — ยัง 88/88)

---

## (ก) inventory diff — 8 route ใหม่คือ mailer/ldap/metrics/chats-search จริง ไม่มีอย่างอื่นปน

ผมไม่อ่าน diff แล้วเชื่อ — เดิน `app._router.stack` แบบ recursive บนแต่ละ SHA เอง
(สคริปต์เดียวกันทั้ง 4 ต้นไม้ ต่างกันแค่ path ของ `index.js`) แล้ว diff รายการ
`METHOD path` ที่ sort แล้ว:

| SHA | บทบาท | layer |
|---|---|---|
| `4899db017` | merge-base (main ตอนแตก) | **316** |
| `95710cb56` | main ตอนนี้ | **316** |
| `6038e1179` | branch tip ก่อน merge | **309** |
| `8fdb067dc` | merge result | **316** |

diff ที่วัดได้:

- **`4899db017` vs `95710cb56` → IDENTICAL** — main ไม่ได้ขยับ route ระหว่างนี้ ดังนั้น merge-base
  ใช้แทน main ได้ตรง ๆ
- **`8fdb067dc` vs `95710cb56` → IDENTICAL (316/316)** — nailed. route ทั้งหมดที่ merge ให้
  เท่ากับ main ทุกเส้น ไม่มีเส้นใหม่ที่ branch แอบพาเข้ามา ไม่มีเส้นเก่าที่หายไป
- **`6038e1179` (309) vs `8fdb067dc` (316) → เพิ่ม 7 บรรทัดเป๊ะ ไม่มีบรรทัดหาย**:

```
> GET  /mailer/settings
> GET  /metrics
> GET  /sso/ldap/enabled
> GET  /workspace/:slug/chats/search
> POST /mailer/settings
> POST /mailer/test
> POST /sso/ldap/login
```

**หมายเหตุที่ต่างจากที่แจ้งมา**: PMO บอก "8 route ใหม่ … invite/new +whenMailing"
ตัวเลขที่วัดได้คือ **7 layer** ไม่ใช่ 8 — `POST /admin/invite/new` (และคู่ `/v1`) มีอยู่แล้วทั้งบน
branch tip และบน main ทั้งคู่ layer เดิม ไม่ใช่ route ใหม่ ที่เปลี่ยนคือ *handler* ของมัน
(`whenMailing`) ซึ่ง route inventory มองไม่เห็นและไม่ควรเห็น 316 − 309 = 7 ตรงกับรายการข้างบน
ไม่ขาดไม่เกิน ข้อสรุปเชิงความปลอดภัยไม่เปลี่ยน (ยังคือ mailer/ldap/metrics/chats-search เท่านั้น)
แต่คำอธิบายควรเขียน 7 ไม่ใช่ 8 เพื่อไม่ให้คนอ่านทีหลังไปหา route ที่แปดที่ไม่มีอยู่

**gate shape ของเส้นใหม่ (อ่านจาก source ที่ merge แล้ว)**:

| route | middleware |
|---|---|
| `GET /mailer/settings` | `[validatedRequest, requirePermission("system.write", orgResource)]` |
| `POST /mailer/settings` | `[validatedRequest, requirePermission("system.write", orgResource)]` |
| `POST /mailer/test` | `[validatedRequest, requirePermission("system.write", orgResource), mailerTestRateLimit]` |
| `POST /sso/ldap/login` | `[inviteRateLimit, loginAccountRateLimit]` — allowlist ใหม่ |
| `GET /sso/ldap/enabled` | ไม่มี array (GET, non-mutating) |

allowlist entry เดียวที่ merge เพิ่มคือ `["POST /sso/ldap/login", "unauthenticated LDAP login ingress"]`
พร้อมเหตุผลเขียนไว้ 3 บรรทัด (ไม่มี principal ก่อน authenticate) — ถูกตามรูปแบบของ
`INTENTIONAL_NON_PERMISSION_MUTATIONS` และเป็นเส้น login ingress จริง เทียบระดับเดียวกับ
`POST /request-token` และ `POST /sso/saml/acs` ที่อยู่ในรายการอยู่แล้ว

delta ทั้งหมดที่ merge commit ทำกับไฟล์เทสนี้คือ **+6 −2**: allowlist 1 entry (+ comment 3 บรรทัด)
กับ re-pin 309→316 ไม่มีการผ่อนเงื่อนไขอื่นแฝงมา (ตรวจด้วย `git diff 6038e1179 8fdb067dc --`
เฉพาะไฟล์นั้น)

---

## (ข) R6 / X1 ยังแดง — ยิงเอง ไม่ใช่อ่านรายงาน

inject 1 บรรทัดเหนือ `const ENDPOINT_REGISTRATIONS = Object.freeze([` โดย require
`validatedRequest` แบบเต็ม path เพราะมันไม่อยู่ใน scope ของ `index.js` (§7.9l) และ
**ยืนยัน grep ว่า inject ติดจริงก่อนรันทุกครั้ง**

| attack | shape | ผล |
|---|---|---|
| **X1** | `apiRouter.post("/x1-inline-probe", [validatedRequest], …)` — ไม่มี import ไม่มี registrar ไม่มี `./endpoints/` literal | **6 failed** (สองสวีท × 3) |
| **R6** | เหมือนกัน แต่ mount บน `app` แทน `apiRouter` | **6 failed** |

เทสที่แดงเป็นชุดเดียวกันทั้งสองครั้ง และเป็นชุดที่ถูก:
`the sweep actually mounted the router (guards the guard)` (317 ≠ 316),
`every mounted mutating route has identity-verified authorization`,
`no mutating route carries validatedRequest alone` — สามชั้นตอบคนละคำถาม
ชั้นแรกบอก "router เปลี่ยน" ชั้นที่สองบอก "ที่เปลี่ยนไม่มี gate" ชั้นที่สามบอก
"`validatedRequest` ไม่นับเป็น gate" ถ้ามีชั้นเดียวจะอ่อนกว่านี้มาก

---

## (ค) mutation — pin ใหม่ (316) ถือคำตัดสินจริงไหม

นี่คือคำถามที่สำคัญกว่า "เทสเขียว" เพราะสิ่งที่ merge นี้แก้คือตัวเลข ถ้าตัวเลขไม่มีฟัน
การ re-pin ก็คือการปิดปากเทส

| # | mutation | ผล |
|---|---|---|
| M1 | ลบ `["POST /sso/ldap/login", …]` ออกจาก allowlist | **2 failed** — `identity-verified authorization` แดงทั้งสองสวีท |
| M2 | เปลี่ยน `toHaveLength(316)` → `toBeGreaterThan(1)` | **33/33 เขียว** ✅ pin คือสิ่งเดียวที่จับ M3/M4 ได้ |
| M3 | เพิ่ม route ใหม่ที่ **gate ถูกต้องครบ** (`validatedRequest + requirePermission(system.write, orgResource)`) | **1 failed** — pin จับ 317 ≠ 316 |
| M4 | ลบ `GET /mailer/settings` ออกจาก `endpoints/mailer.js` | **1 failed** — pin จับ 315 ≠ 316 |
| M5 | ถอด `requirePermission` ออกจาก mailer 2 เส้น เหลือ `[validatedRequest]` | **6 failed** |
| M6 | fake gate: `Object.assign(function permissionRequired(){}, {action, resolveResource: orgResource})` | **4 failed** |

**M3 คือตัวที่ตอบคำถามของ merge นี้โดยตรง** — route ที่ gate ถูกทุกอย่าง ยังทำให้เทสแดง
เพราะ pin เห็นว่า router โตขึ้น แปลว่า 316 ไม่ใช่ "ตัวเลขที่ปรับให้เขียว" แต่เป็น snapshot
ที่บังคับให้คนเพิ่ม route ต้องมาแก้ตัวเลขและอธิบาย — ซึ่งคือสิ่งที่ merge นี้ทำพอดี
M2 ยืนยันอีกด้าน: ถ้าผ่อน pin เป็น `toBeGreaterThan(1)` ทั้ง M3 และ M4 หลุดเงียบ

**M6 ยังจับได้** — WeakSet identity registry ยังทำงานหลัง merge ไม่ได้ถูก resolve ทับจนกลายเป็น
name/shape check M6 แดง 4 เทส (มากกว่า route ที่ไม่มี gate เลยในบางมิติ) เป็นลายเซ็นที่ถูก
เพราะโดนทั้ง gate check และ resolver-identity check

**M4 สำคัญในอีกทาง** — pin จับ "route หายไป" ด้วย ไม่ใช่แค่ "route เพิ่ม" ดังนั้นการ merge ที่
กลืน route ของ main ทิ้งโดยไม่ตั้งใจ (สิ่งที่ rebase ชนมักทำ) จะแดง ไม่ใช่เขียว

หลัง mutation ครบ restore ไฟล์ทั้ง 3 ตัว (`index.js`, `endpoints/mailer.js`,
`routeGateSweep.test.js`) แล้ว `diff` ยืนยัน byte-identical + `git status --short` สะอาด
และรัน baseline ซ้ำได้ **88/88** เท่าเดิม

---

## Verdict

**PASS** — สามข้อที่ขอมาวัดได้ครบ:

1. route ที่เพิ่ม **7 เส้น** (ไม่ใช่ 8) คือ mailer 3 / ldap 2 / metrics 1 / chats-search 1 เท่านั้น
   และ inventory ของ merge result **identical กับ main 316/316** ไม่มีอะไรปนมา
2. R6 และ X1 ยังแดงจริง วัดเอง 6 failed ทั้งคู่ ชุดเทสที่แดงตรงกับที่ควรแดง
3. pin 316 ใหม่ไม่ใช่การปิดปากเทส — M3 (route ที่ gate ถูก) ยังแดง, M2 (ผ่อน pin) ทำให้ M3/M4 หลุด

## หมายเหตุ (ไม่ block)

- **นับ 7 ไม่ใช่ 8** — ขอให้แก้ในคำอธิบาย/ledger `POST /admin/invite/new` เป็น route เดิม
  เปลี่ยนแค่ handler คนอ่านทีหลังจะได้ไม่ตามหา route ที่แปด
- **`node_modules` donor ต้องมี `ldapts`** — donor เก่า (`/tmp/qa1-40`, `/tmp/base91`) ไม่มี
  `index.js` โยน `Cannot find module 'ldapts'` ตั้งแต่ import ซึ่งอ่านเหมือน "เทสพัง" ไม่ใช่
  "ขาด dependency" ใครรีวิว SHA นี้ต่อให้ใช้ donor หลัง #60 เช่น `/tmp/qa2-84b`
- **`GET /metrics` เข้ามาใน 316 แล้ว** — ตอนรีวิว #90 ผมตั้งข้อสังเกตว่า counter ทั้งห้ายังไม่มี
  call site เรียก `observe()` ประเด็นนั้นยังค้างอยู่และไม่เกี่ยวกับ merge นี้ แต่ตอนนี้ route
  อยู่ใน snapshot แล้ว การ wire ทีหลังจะไม่ขยับตัวเลข (แก้ handler ไม่ใช่ route) จึงไม่ชนกัน

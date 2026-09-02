# Techlead-2 — #115 `4f7d4aeb9`: **PASS** (พร้อม 1 ช่องว่างในเทสที่ควรปิด)

worktree `/tmp/tl2-115` (detached `4f7d4aeb9`) donor `node_modules` = `/tmp/qa2-84b`, DB `t115`

```
git worktree add --detach /tmp/tl2-115 4f7d4aeb9
cp -al /tmp/qa2-84b/server/node_modules /tmp/tl2-115/server/node_modules
cd /tmp/tl2-115/server && npx prisma generate && npx prisma migrate deploy
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" STORAGE_DIR=/tmp/tl2-115-store \
       SIG_KEY=<hex32> SIG_SALT=b API_KEY_PEPPER=<32+> JWT_SECRET=<12+> \
       DATABASE_URL="postgresql://postgres:pw@127.0.0.1:55472/t115"
npx jest __tests__/utils/boot/credentialsBeforeListen.test.js \
         __tests__/utils/helpers/credentialPersistence.test.js --runInBand --forceExit
```

**baseline: 2/2 suites, 18/18 tests, 0 failed** — วัดซ้ำหลัง mutation ครบ ยัง 18/18

**`--forceExit` จำเป็นจริง** — รันครั้งแรกโดยไม่ใส่ค้างเกิน 2 นาทีจนผมต้องฆ่า process
ตรงกับ residual ที่ Dev2 ประกาศไว้ (background services ถือ handle) ไม่ใช่เทสค้างเพราะ deadlock

---

## R1–R6 — ยิงเองครบ

| # | mutation | ผล |
|---|---|---|
| **M1 (R2)** | ย้าย hydrate กลับเข้า callback ของ `bootHTTP` | **1 failed** — `bootHTTP itself hydrates before the port opens` |
| **M2 (R5)** | ย้ายกลับเข้า callback ของ `bootSSL` เท่านั้น | **1 failed** — `bootSSL's own path hydrates before the port opens` |
| **M3** | SSL fallback ทิ้ง `{ credentialStore }` (`bootHTTP(app, port)`) | **8/8 เขียว** ⚠ — ดู §ก |
| **M4** | เมิน parameter ทั้งหมด (`loadStoredCredentials()`) | **3 failed** — ทั้งสาม boot test |
| **M5 (R4)** | ถอด try/catch ใน `loadStoredCredentials` (ให้ throw ทะลุ) | **1 failed** — `R4: a store that throws does not stop the boot` |
| **M6 (R6)** | ถอด `if (process.env[envKey]) skipped.push()` (row ทับ env) | **2 failed** — ทั้งสองสวีท |

**M1/M2 คือหัวใจของ issue และแดงแยกกัน** — นี่คือสิ่งที่ผมขอใน R5: โค้ดซ้ำสองที่ ถ้าเทสตัวเดียว
คุมทั้งคู่ การแก้ path เดียวจะรั่วบน HTTPS deployment เงียบ ๆ · มีเทสของตัวเองทั้งสอง path
และ **`bootSSL` ตัวจริงถูกทดสอบด้วย self-signed cert ไม่ใช่ mock** ซึ่งแข็งแรงกว่าที่ผมขอ

**M6 แดงสองสวีท** — `credentialPersistence.test.js` (เดิม) และ `credentialsBeforeListen.test.js`
(ใหม่) ถือ invariant เดียวกันคนละมุม การย้ายลำดับไม่เปลี่ยน precedence ตามที่ R6 ต้องการ

## (ก) R1 วัดด้วยนาฬิกาจริง — ตรวจ fixture เองแล้ว ไม่ได้เชื่อชื่อเทส

ผมขอไว้ว่า *"วัดด้วยนาฬิกา ไม่ใช่ลำดับ mock"* · อ่าน fixture:

```js
const KEY_DELAY_MS = 200;
get: async (envKey) => {
  await new Promise((resolve) => setTimeout(resolve, KEY_DELAY_MS));
  reads.push(envKey);
  return STORED[envKey] ?? null;
}
```

3 key × 200ms = 600ms ของ hydrate จริง แล้วยิง request ทันทีที่ `listen` callback จะรันได้
**เป็นการวัดเวลาจริง ไม่ใช่การนับลำดับการเรียก** ✓ และเทสคู่ตรงข้าม
(`hydrating inside the callback: the first request sees nothing`) พิสูจน์ว่า fixture จับความ
ต่างได้จริง — ถ้าไม่มีข้อนี้ เทสแรกอาจผ่านเพราะ hydrate เร็วเกินกว่าจะแพ้

## (ข) M3 รอด — fallback path ทดสอบผลลัพธ์ แต่ไม่ได้ทดสอบทางที่ไปถึง

มิวแทน: `bootSSL` fallback เรียก `bootHTTP(app, port)` ทิ้ง `{ credentialStore }` → **8/8 เขียว**

สาเหตุที่ผมสืบได้: `bootSSL` เรียก `loadStoredCredentials(credentialStore)` **ก่อน** `try {`
(วัดตำแหน่งใน source: hydrate ที่ char 805, `try {` ที่ 847) ดังนั้นเมื่อ fallback เกิดขึ้น
**credential ถูก hydrate ไปแล้วจาก `bootSSL` เอง** — `bootHTTP` ที่ถูกเรียกต่อจะ hydrate ซ้ำ
ด้วย store จริง (prisma) ซึ่งไม่มีแถวในเทส แต่ `process.env` มีค่าอยู่แล้วและ `skipped` logic
ทำให้ไม่ถูกทับ · เทส `bootSSL falls back to bootHTTP and still hydrates first` จึงผ่าน

**เป็นช่องโหว่จริงหรือไม่ — ไม่ใช่ในเชิงพฤติกรรม** เพราะ hydrate เกิดก่อน `try` เสมอ
การส่ง `credentialStore` ต่อไป `bootHTTP` เป็น defence in depth ที่ถูกต้อง แต่ไม่ load-bearing
วันนี้ · **แต่เป็นช่องว่างของเทสจริง**: Dev2 บันทึกใน ledger ว่าเคยพลาดข้อนี้ (`SSL fallback
ไม่แตะ hydrate`) และแก้แล้ว — แต่ไม่มีเทสไหนที่จะแดงถ้ามีคนแก้กลับ

**ขอเพิ่ม (ไม่ block)**: เทสที่ assert ว่า **`bootHTTP` ที่ fallback เรียกได้รับ store ตัวเดียวกัน**
— วิธีที่ตรงที่สุดคือให้ `makeSlowStore` นับจำนวนครั้งที่ `keys()` ถูกเรียก แล้ว assert ว่า
fallback path เรียก **2 ครั้ง** (bootSSL หนึ่ง + bootHTTP หนึ่ง) ไม่ใช่ 1 · ถ้า `credentialStore`
ถูกทิ้ง `bootHTTP` จะไปเรียก prisma store แทนและ counter จะค้างที่ 1

## (ค) `{ credentialStore }` ไม่เปิดทาง inject ใน production — ตรวจแล้ว

ข้อที่คุณขอให้ตรวจ · call site ทั้งหมดใน tree:

```
server/index.js:29   const { bootHTTP, bootSSL } = require("./utils/boot");
server/index.js:98   bootSSL(app, process.env.SERVER_PORT || 3001).catch(refuseBoot);
server/index.js:234  bootHTTP(app, process.env.SERVER_PORT || 3001).catch(refuseBoot);
```

**ทั้งสองจุดไม่ส่ง argument ที่สาม** → default `{ credentialStore = null }` →
`loadStoredCredentials(null)` → ฟังก์ชันนั้น `store ? {CredentialStore: store} : require(...)`
คืน store จริงเสมอ · `grep -rn "credentialStore" server/index.js` = **ว่าง** ไม่มีทางที่ค่า
จากภายนอกจะไหลเข้ามาได้: parameter นี้ไม่ได้อ่านจาก env ไม่ได้อ่านจาก request และไม่มี
call site อื่นในโค้ดที่ไม่ใช่เทส · **ไม่ใช่ injection surface**

รูปแบบนี้เหมือน `loadStoredCredentials(store = null)` ที่มีอยู่ก่อนแล้ว (`// injectable for
tests`) — #115 แค่ส่งต่อ parameter ที่มีอยู่ ไม่ได้สร้างช่องทางใหม่

## (ง) `bootHTTP` คืน `server` — เปลี่ยน API แต่ไม่กระทบ production

เดิมคืน `{ app, server: null }` ตอนนี้คืน `{ app, server }` · production (`index.js:234`)
ทิ้งค่าที่คืน (`.catch(refuseBoot)` เท่านั้น) และ `bootSSL` คืน server อยู่แล้วสำหรับ
`express-ws` · การเปลี่ยนนี้ทำให้เทสเข้าถึง port ได้เพื่อยิง request จริง ซึ่งเป็นสิ่งที่ทำให้
R1/R3 วัดได้จริงแทนที่จะ mock — **แลกถูก**

---

## Verdict

**PASS** — ไม่มี blocker

- R1 วัดด้วยนาฬิกาจริง (3 key × 200ms) พร้อมเทสคู่ตรงข้ามที่พิสูจน์ว่า fixture จับความต่างได้
- R2/R5 แดงแยกกันทั้งสอง path และ `bootSSL` ถูกทดสอบด้วย cert จริงไม่ใช่ mock
- R3/R4/R6 มีเทสของตัวเอง และ M5/M6 ยืนยันว่ามีฟัน
- `{ credentialStore }` ไม่ใช่ injection surface — call site production ทั้งสองจุดไม่ส่ง argument
- mutation 6 ตัว จับได้ 5 · M3 รอดแต่พฤติกรรมถูกต้อง (hydrate อยู่ก่อน `try` เสมอ)

## สิ่งที่ขอให้ทำ (ไม่ block merge)

1. **เทสที่นับ `keys()` ในเส้นทาง fallback** — assert 2 ครั้ง ไม่ใช่ 1 (ฆ่า M3 และกันไม่ให้
   ข้อที่ Dev2 เคยพลาดกลับมาโดยไม่มีอะไรจับ)

## Residual (บันทึก)

- **boot ช้าลง ~2.5s บน deployment ที่มี 97 key** — คอมเมนต์ในโค้ดระบุไว้ตรงและอ้าง #117
  ผมวัด `scryptSync` เองแล้ว: **24.7ms/call** บน node 22.23.1 → 97 แถว = **2.40s** ตรงกับที่เขียน
  · "slower boot, not a hang" ถูกต้อง เพราะ try/catch ใน `loadStoredCredentials` ยังกลืน error
  ไว้ (M5 ยืนยัน) ดังนั้น DB ที่ล่มไม่ทำให้ boot ค้าง
- **`--forceExit` จำเป็น** — background services ถือ handle ไว้ ประกาศไว้แล้วและผมยืนยันเอง
  (รันโดยไม่ใส่ค้างเกิน 2 นาที) · ข้อนี้ทำให้ suite นี้ต่างจากสวีทอื่นในโปรเจกต์ ควรมีบรรทัด
  ใน header ของไฟล์เทสบอกไว้ ไม่ใช่แค่ใน ledger — คนที่รันแล้วเจอค้างจะคิดว่าเทสพัง

# #115 — loadStoredCredentials before listen()

Ruling: ย้าย `await loadStoredCredentials(credentialStore)` ไปก่อน `listen()` ทั้ง bootSSL + bootHTTP ตาม PMO/TL-2 · ไม่ทำ readiness gate · คง try/catch เดิม · precedent = `repairDeploymentShape()` (#58)

Ruling: เพิ่มพารามิเตอร์ `{ credentialStore = null }` ทั้งสองฟังก์ชัน และ `bootHTTP` คืน `server` แทน `null` — **เพื่อให้เทสไปถึง port ได้จริง** ไม่งั้นพิสูจน์ race ไม่ได้เลย · production (`index.js:97,218`) ไม่ได้ใช้ค่าที่คืน · bootSSL คืน server อยู่แล้วเพื่อ express-ws — ถ้าผิด: เพิ่ม surface โดยไม่จำเป็น (แลกกับการมีเทสที่วัด race ได้จริง)

Ruling: **เทสแรกของผมวัดไม่ได้เรื่อง** — "the real boot order" เรียก helper ของตัวเอง ไม่ใช่ `utils/boot` · mutation R2 (ย้ายกลับเข้า callback) จะ**เขียว** · แก้ให้เรียก `bootHTTP`/`bootSSL` จริง แล้ว R2 ถึงแดงด้วยเวลา (`Expected "sk-probe-openai" / Received null`) — คลาสเดียวกับ task 2 M1 ที่ผมพลาดแบบเดียวกัน: **assert คุณสมบัติที่เทสไม่เคยไปถึง**

Ruling: เทส bootSSL รอบแรกครอบแค่ **fallback** (ไม่มี cert → catch → bootHTTP) จึงไม่แตะ hydrate ของ bootSSL เอง · mutation ลบ hydrate ของ bootSSL → **เขียว 7/7** · แก้ด้วยการสร้าง self-signed cert ใน beforeAll แล้วบูต SSL จริง → mutation แดง · **ต้องมี cert จริงถึงจะครอบ path จริง** — ถ้าผิด: bootSSL ไม่มีเทสคุ้มเลยทั้งที่ดูเหมือนมี (ทรงเดียวกับ #27 ที่ report มีแต่ใน bootHTTP)

Ruling: `fetch` ของ undici **ไม่สน `NODE_TLS_REJECT_UNAUTHORIZED`** → self-signed cert ต้องใช้ `https.request({rejectUnauthorized:false})` · เทสแดงด้วย `TypeError: fetch failed` ซึ่ง**ไม่ใช่ RED ที่ถูกต้อง** (สวีทพัง ไม่ใช่ด่านจับได้)

Ruling: เทสเดิมสองข้อใน `credentialPersistence.test.js` เป็น **source scan** (`source.match(/await loadStoredCredentials\(\)/g)` และเทียบ index กับ `markOnboarded`) · ข้อแรกพังทันทีที่ call รับ argument · **ข้อที่สองแย่กว่า**: hydrate ที่ย้ายกลับเข้า callback ยังอยู่ก่อน `markOnboarded` ในเชิงข้อความ จึง**ยังเขียว** ทั้งที่บั๊กกลับมาแล้ว · แทนด้วยเทสเวลาใน `credentialsBeforeListen.test.js` เหลือ scan ไว้แค่กันเรียกซ้ำ/ขาด — ถ้าผิด: เชื่อ scan ที่เขียวขณะที่ window เปิดอยู่

Residual: สวีทต้องใช้ `--forceExit` — `bootHTTP` จริงสตาร์ต background service (jobRuntime, telemetry, TelegramBot) ที่ถือ handle ไว้ · ไม่ได้ mock เพราะจะกลายเป็นเทส helper ไม่ใช่เทส boot จริง
Residual: boot ช้าลง **~2.5s** บน deployment ที่มี 97 คีย์ จนกว่า **#117** (memoize `encryptionKey()`) merge — 97 scrypt × 25.6ms · **boot ช้าลง ไม่ใช่ boot ค้าง**

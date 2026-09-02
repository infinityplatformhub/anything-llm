# Techlead-2 — #49 `2c9ae1f0f`: **PASS** (พร้อม 2 ข้อสังเกตที่ต้องบันทึก)

worktree `/tmp/tl2-49` (detached `2c9ae1f0f`) + `/tmp/tl2-49base` (`4d8e16d90`) donor
`node_modules` = `/tmp/qa2-84b`, DB `t49` ของผมเองบน `:55472` — ไม่แตะ checkout หลัก
ไม่แตะ worktree ของ dev คนไหน

```
git worktree add --detach /tmp/tl2-49 2c9ae1f0f
cp -al /tmp/qa2-84b/server/node_modules /tmp/tl2-49/server/node_modules
cd /tmp/tl2-49/server && npx prisma generate
DATABASE_URL=".../t49" npx prisma migrate deploy
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" STORAGE_DIR=/tmp/tl2-49-store \
       SIG_KEY=<hex32> SIG_SALT=b API_KEY_PEPPER=<32+> JWT_SECRET=<12+> \
       DATABASE_URL="postgresql://postgres:pw@127.0.0.1:55472/t49"
npx jest __tests__/utils/middleware/embedTokenPayload.test.js \
         __tests__/utils/middleware/embedSessionToken.test.js \
         __tests__/utils/middleware/embedSessionOwnership.test.js \
         __tests__/security/embedServerMintedSession.test.js \
         __tests__/security/embedSessionFlagAndLimit.test.js \
         __tests__/embedSessionTokenOracleHttp.test.js \
         __tests__/security/authorization/routeGateSweep.test.js --runInBand
```

**baseline: 7/7 suites, 110/110 tests, 0 failed** — วัดซ้ำหลัง mutation ครบ ยัง 110/110

> **บันทึกความผิดพลาดของผมเอง (§7.9l)**: รอบแรกผมพิมพ์ path
> `__tests__/security/embedSessionTokenOracleHttp.test.js` ผิด (ไฟล์จริงอยู่ที่
> `__tests__/embedSessionTokenOracleHttp.test.js`) jest รายงาน **4/4 suites 76/76 เขียว**
> โดยไม่บ่นว่า path ที่ห้ามีไม่มีอยู่ ถ้าผมหยุดตรงนั้น ผมจะรายงานว่าเทส oracle ผ่านทั้งที่
> ไม่เคยรัน — รูปแบบเดียวกับ `Tests: 0 total` ใน #40 ตรวจ `ls` แล้วรันใหม่ได้ 7/7 110/110

---

## (ก) inventory diff — route ใหม่ 1 เส้น ไม่มีอย่างอื่นปน

เดิน `app._router.stack` recursive บนทั้งสอง SHA แล้ว diff รายการที่ sort แล้ว:

| SHA | layer |
|---|---|
| `4d8e16d90` (merge-base) | **316** |
| `2c9ae1f0f` | **317** |

diff คือ **บรรทัดเดียว ไม่มีบรรทัดหาย**:

```
> POST /embed/:embedId/session
```

ตรงกับที่ประกาศไว้เป๊ะ และ pin ในเทสขยับ 316→317 พร้อมคอมเมนต์ที่บอกว่า pin นี้เองคือสิ่งที่
บังคับให้ต้องมาประกาศ exemption

**ข้อความเหตุผลใน allowlist ซื่อสัตย์ไหม — ตรวจทีละข้ออ้าง ไม่ได้อ่านผ่าน**

> `"unauthenticated session-open ingress; embedSessionOpen enforces enabled + origin allowlist, embedHistoryRateLimit bounds it, and it persists nothing"`

| ข้ออ้าง | ตรวจอย่างไร | ผล |
|---|---|---|
| `embedSessionOpen` บังคับ `enabled` | อ่าน `embedMiddleware.js` — `if (!embed.enabled) → 503` | **จริง** |
| บังคับ origin allowlist | `allowedHosts === null && "EMBED_REQUIRE_ALLOWLIST" in process.env` หรือ `!allowedHosts.includes(host)` → 401 | **จริง** และเป็นกฎเดียวกับ `canRespond`/`embedHistoryAccess` (F-12a: allowlist ว่าง = ปฏิเสธ ไม่ใช่อนุญาต) |
| `embedHistoryRateLimit` คุม | อ่าน route array ใน `endpoints/embed/index.js` — เป็น middleware ตัวแรก | **จริง** |
| "persists nothing" | `openSession` เรียกแค่ `crypto.randomUUID()` + `mintSessionToken` ไม่มี prisma call เลย และ `require("../prisma")` ถูก **ลบ** ออกจากไฟล์ทั้งไฟล์ | **จริง** |

ทั้งสี่ข้ออ้างพิสูจน์ได้ ไม่มีข้อไหนเป็นคำโฆษณา — และข้อสุดท้ายแข็งแรงกว่าที่เขียน เพราะ
prisma ถูกถอด import ออกทั้งโมดูล ไม่ใช่แค่ "ไม่ได้เรียกในฟังก์ชันนี้"

## (ข) F1 collision — ยืนยันด้วยการรันเอง

```
sign("A|B", "C", 1) === sign("A", "B|C", 1)     // main format: payload 'A|B|C|1' ทั้งคู่ → HMAC เท่ากัน
JSON.stringify(["A|B","C",1]) !== JSON.stringify(["A","B|C",1])   // ปิดแล้ว
```

**T2 — ย้อน `payloadOf` กลับเป็น pipe-join** → **4 failed** และเป็นชุดที่ถูก:
`shifting a separator between two fields does not produce the same signature`,
`a token for one field split is not accepted for the other`,
`a stamp of four hundred nines is refused, not treated as Infinity`,
`an unparseable firstIssuedAt is refused too`

## (ค) mutation ทั้งชุด

| # | mutation | ผล |
|---|---|---|
| **T2** | `payloadOf` → pipe-join | **4 failed** |
| **T4** | ถอด `issuedAt > now + CLOCK_SKEW_MS` | **110/110 เขียว** ⚠ |
| **T4b** | ถอด `firstIssuedAt > now + CLOCK_SKEW_MS` | **110/110 เขียว** ⚠ |
| **T4c** | ถอด **ทั้งสอง** | **2 failed** (`a token stamped far in the future is refused`, `just beyond the allowed skew`) |
| **T5** | F2 รายงาน `"expired"` แทน `"malformed"` | **110/110 เขียว** (equivalent — พิสูจน์แล้ว §ง) |
| **T-abs** | ถอดเพดาน `SESSION_ABSOLUTE_MAX_MS` | **1 failed** (`a token whose session opened over the maximum ago is refused, however fresh its stamp`) |
| **T-rot** | rotation รีเซ็ต `firstIssuedAt` (ไม่ส่งต่อของเดิม) | **1 failed** (`rotation carries the ORIGINAL firstIssuedAt, it does not restart it`) |
| **T7** | `openSession` รับ `sessionId` จาก body | **1 failed** (`an id supplied in the BODY is ignored, not honoured`) |
| **T8** | `embedSessionOpen` ถอด origin allowlist | **1 failed** (`a disallowed origin cannot open a session`) |
| **T9** | `EMBED_REQUIRE_ALLOWLIST` presence → `=== "true"` | **110/110 เขียว** (ไม่ใช่ของ issue นี้ — ดู §จ) |
| **T9b** | `EMBED_REQUIRE_SESSION_TOKEN` presence → `=== "true"` | **2 failed** (`the string "false" ENABLES enforcement`, `an empty value also enables it`) |
| **T10** | `timingSafeEqual` → `!==` | **1 failed** (`the comparison uses timingSafeEqual, not === or a byte loop`) |
| **T11** | ลบ allowlist entry ของ route ใหม่ออกจาก sweep | **1 failed** (`every mounted mutating route has identity-verified authorization`) |

**T-abs และ T-rot คือคู่ที่สำคัญที่สุด** เพราะเป็นสิ่งที่ผมขอไว้ตอน pre-read (residual
"rotation ไม่มี absolute cap") ทั้งคู่แดง แปลว่าเพดาน 7 วันไม่ใช่คอมเมนต์ — มันมีเทสสองตัว
ที่ถือคนละครึ่งของกลไก: T-abs ถามว่า "เพดานมีอยู่ไหม" T-rot ถามว่า "rotation ทำให้เพดาน
เลื่อนหนีไหม" ถ้ามีแค่ตัวแรก การรีเซ็ต `firstIssuedAt` ทุกรอบจะผ่านและเพดานจะกลายเป็น
rolling window เงียบ ๆ ซึ่งคือรูเดิมที่ทาสีใหม่

**T10** จับได้ด้วย source assert ตามที่ Dev4 รายงาน — ผมยอมรับวิธีนี้ที่นี่ เพราะการวัด
timing จริงบน HMAC 43 ไบต์บนเครื่อง dev ให้สัญญาณที่ noisy เกินกว่าจะเป็นเทสที่เชื่อถือได้
(จะกลายเป็นเทส flaky ที่คนปิดทิ้งภายในเดือนเดียว) source assert ตรงไปตรงมากว่าและพังเมื่อ
มีคนเปลี่ยนจริง

## (ง) T5 เป็น equivalent mutant — พิสูจน์ด้วยการรัน ไม่ใช่ด้วยการเถียง

`verifySessionToken` คืน `reason` แต่ **ผู้บริโภคเดียวใน tree** คือ
`embedMiddleware.js:329`:

```js
const status = verdict.reason === "mismatch" ? 403 : 401;
```

รันจริงทั้งสามกรณี:

```
future         {"valid":false,"reason":"malformed"} -> HTTP 401
expired        {"valid":false,"reason":"expired"}   -> HTTP 401
wrongsession   {"valid":false,"reason":"mismatch"}  -> HTTP 403
```

`malformed` และ `expired` ยุบเป็น 401 เหมือนกันที่ขอบ HTTP ดังนั้นการสลับสองค่านี้
**สังเกตจากภายนอกไม่ได้เลย** — เป็น equivalent mutant จริง ไม่ใช่ช่องโหว่ของเทส
ที่สำคัญกว่า: การยุบนี้คือสิ่งที่ *ต้องการ* เพราะการแยก 401 ออกเป็นสองแบบจะบอก attacker ว่า
timestamp ที่เดามาเคยจริงหรือไม่ คอมเมนต์ในโค้ดเขียนเหตุผลนี้ไว้แล้วและถูกต้อง

**สิ่งที่ควรเพิ่ม (ไม่ block)**: ไม่มีเทสไหน pin ว่า `reason` ทั้งสามค่า map ไป status ตัวไหน
ถ้าวันหนึ่งมีคนเปลี่ยนบรรทัด 329 เป็น `verdict.reason === "expired" ? 410 : 401` เพื่อ
"ช่วย debug" จะไม่มีอะไรแดง และนั่นคือ oracle ที่ #32 ปิดไปแล้วกลับมา — ขอเทสหนึ่งตัวที่
assert ว่า **`malformed` กับ `expired` ให้ status และ body เดียวกันเป๊ะ**

## (จ) T4/T4b — mutation คู่ที่กลบกันเอง (ข้อสังเกตหลัก)

ถอด skew bound ตัวใดตัวหนึ่งเทสยังเขียวหมด ถอดทั้งคู่ถึงแดง ผมจึงตรวจว่าตัวที่รอดเป็น
ช่องโหว่จริงหรือไม่ ด้วยการรัน token รูปร่าง rotation (`issuedAt` อนาคต 1 ปี แต่
`firstIssuedAt` ปกติ) บนโค้ดที่ถอด bound ของ `issuedAt` ออก:

```
issuedAt=+1y firstIssuedAt=now   -> {"valid":true}      ← ยอมรับ
same token 300 วันถัดมา          -> {"valid":false,"reason":"expired"}   ← เพดาน 7 วันจับได้
```

**สรุป: ไม่ใช่ช่องโหว่ที่ใช้ประโยชน์ได้** เพราะเพดาน `SESSION_ABSOLUTE_MAX_MS` ที่นับจาก
`firstIssuedAt` ปิดผลกระทบระยะยาวไว้แล้ว — token ที่ stamp อนาคตอยู่ได้อย่างมาก 7 วันจาก
`firstIssuedAt` เท่าเดิม ไม่ใช่ 1 ปี และการจะได้ token แบบนี้ต้องมี `SIG_KEY` อยู่แล้ว
(ทุกกรณีข้างบนผม mint เอง) ซึ่งถ้ามีก็จบเกมไปนานแล้ว

แต่ **เทสยังบกพร่องจริง** และควรบันทึก: เทสสองตัวที่มีอยู่ (`far in the future`,
`just beyond the allowed skew`) ใช้ `mintSessionToken({issuedAt: ...})` ซึ่ง default
`firstIssuedAt = issuedAt` **ทั้งสองสนามจึงเป็นอนาคตพร้อมกันเสมอ** เทสจึงพิสูจน์ได้แค่ว่า
"มี bound อย่างน้อยหนึ่งตัว" ไม่ใช่ "มีทั้งสองตัว" — ซึ่งเป็นรูปแบบเดียวกับที่ Dev4 เอง
บันทึกไว้เรื่อง `isSafeInteger` (redundant กับ skew bound)

**ขอเพิ่มเทสหนึ่งตัว**: mint ด้วย `issuedAt` และ `firstIssuedAt` ที่**ต่างกัน** —
ตัวหนึ่งอนาคต อีกตัวปกติ — แล้ว assert ว่าปฏิเสธ ทั้งสองทิศ นี่คือรูปร่าง rotation จริง
(`mintIfEntitled` ส่ง `firstIssuedAt` เก่ามากับ `issuedAt` ใหม่ สองค่าต่างกันเสมอ)
ดังนั้นเทสที่ทั้งสองค่าเท่ากันตลอด ไม่เคยทดสอบรูปร่างที่โค้ดจริงผลิต

**หมายเหตุเรื่อง `isSafeInteger`**: Dev4 บันทึกว่า redundant และไม่เขียนเทสเฉพาะให้ —
ผมเห็นด้วยกับการตัดสินใจและกับเหตุผลที่เขียนไว้ (เทสที่เขียนเพื่อบรรทัดเดียวคือการ assert
implementation detail) แต่ข้อสังเกต T4/T4b ข้างบนทำให้คำว่า "redundant กับ skew bound"
มีน้ำหนักน้อยลง เพราะ skew bound เองก็ยังไม่ถูกทดสอบครบทั้งสองสนาม ถ้าเพิ่มเทสตามที่ขอ
คำอ้างว่า redundant จะกลายเป็นจริงที่พิสูจน์ได้ ไม่ใช่จริงโดยบังเอิญ

## (ฉ) T9 — `EMBED_REQUIRE_ALLOWLIST` ไม่มีเทสคุ้ม (นอกขอบเขต แต่ควรรู้)

เปลี่ยน presence-check เป็น `=== "true"` ทั้งสามจุด → **110/110 เขียว** ต่างจาก
`EMBED_REQUIRE_SESSION_TOKEN` (T9b) ที่มีเทสสามตัวคุ้มครบ

นี่ **ไม่ใช่ regression ของ #49** — `EMBED_REQUIRE_ALLOWLIST` มีอยู่ก่อนแล้วและ #49 แค่
ใช้กฎเดิมใน `embedSessionOpen` แต่ผลคือ: `EMBED_REQUIRE_ALLOWLIST=false` ในไฟล์ .env วันนี้
**เปิด** การบังคับ (ตามที่ตั้งใจ) และไม่มีเทสไหนจับได้ถ้ามีคน "แก้" ให้เป็น boolean parse
ซึ่งจะ **ปิด** gate เงียบ ๆ บน instance ที่ operator เขียน `=false` เพราะเข้าใจว่าปิด
— fail-open ที่มองไม่เห็น ตรงข้ามกับเจตนาที่คอมเมนต์ของ #49 เขียนไว้

ขอให้ยกเป็น issue แยก: เทสสามตัวแบบเดียวกับ Q1 แต่สำหรับ `EMBED_REQUIRE_ALLOWLIST`

## (ช) oracle — วัดเอง ไม่ได้เชื่อ assertion ในเทส

`openSession` 200 ครั้ง:

```
body JSON lengths seen: [ 134 ]      ← ค่าเดียว ไม่มีการกระจาย
sessionId lengths:      [ 36 ]       ← UUID v4 คงที่
token parts: 3  sig len: 43  stamp==origin: true
cross-embed accepted: false
```

ความยาว body คงที่ 134 ทุกครั้ง แปลว่าไม่มี length oracle จาก response ของ route นี้
และ `sig len: 43` ยืนยันสิ่งที่ผมบอกไว้ตอน pre-read: base64url ของ HMAC-SHA256 ยาวคงที่
ไม่ขึ้นกับ payload ดังนั้นการเปลี่ยน payload format ไม่กระทบการเทียบความยาวก่อน
`timingSafeEqual` — early return บนความยาวไม่รั่วอะไร เพราะ 43 เป็นค่าคงที่สาธารณะ

เทส `two opens are identical in shape regardless of what the caller knows` เทียบ
`{status, sorted keys, header presence}` เป็นก้อน ไม่ใช่ทีละ field — เป็นวิธีที่ถูก
(บทเรียน S-25) และครอบคลุมกว่าที่ผมวัดเอง

## (ซ) #32 oracle 2 เทสกลับทิศ — ตรวจว่าเป็นการกลับทิศที่ซื่อสัตย์

เทส `a genuinely NEW session still gets its token` เดิม assert ว่า header **มี** token
ตอนนี้เป็น `a session with no rows yet gets NOTHING` assert ว่า **`toBeUndefined()`**

นี่คือรูปร่างเดียวกับการแก้เทสให้เขียว ผมจึงตรวจสามชั้น:

1. **positive control ยังมีอยู่** — คอมเมนต์อ้างว่าย้ายไป `embedServerMintedSession.test.js`
   ผมตรวจแล้ว: `POST /embed/:embedId/session returns a server-generated id with its token`
   มีจริงและผ่าน ดังนั้น "fix ที่ผ่านโดยไม่ mint อะไรเลย" ยังเป็นไปไม่ได้
2. **การกลับทิศคือสาระของ issue** ไม่ใช่ผลข้างเคียง — #32 ให้ free mint เมื่อไม่มี row,
   #49 ลบ free mint ทิ้ง เทสที่ยัง assert ทิศเดิมจะเป็นเทสที่ pin รูที่กำลังปิด
3. **มิวแทนยืนยัน** — T7 (`openSession` รับ id จาก body) แดง แปลว่าเส้นทาง server-minted
   ยังมีฟัน ไม่ได้เขียวเพราะไม่มีอะไรถูกทดสอบ

เทสตัวที่สอง (`Access-Control-Expose-Headers appends`) เปลี่ยนจากขับด้วย new session
เป็นขับด้วย rotation — logic ที่ทดสอบไม่เปลี่ยน เปลี่ยนแค่วิธีไปถึงมัน ยอมรับได้

---

## Verdict

**PASS** — ไม่มี blocker

- inventory: route ใหม่ **1 เส้นเป๊ะ** (`POST /embed/:embedId/session`) ไม่มีอย่างอื่นปน
  ไม่มีเส้นเก่าหาย · ข้อความ exemption ตรวจครบทั้ง 4 ข้ออ้าง **ซื่อสัตย์ทั้งหมด**
- F1 collision ปิดจริง (ยืนยันด้วยการรันทั้งสองรูปแบบ) · T2 แดง 4
- **residual ที่ผมยกไว้ตอน pre-read ถูกปิดในรอบเดียวกันตามที่เสนอ** — `firstIssuedAt`
  เป็น element ที่ 4 พร้อมเพดาน 7 วัน และมีเทสสองตัวถือคนละครึ่ง (T-abs, T-rot แดงทั้งคู่)
- mutation 13 ตัว: จับได้ 10 · **T5 พิสูจน์แล้วว่าเป็น equivalent mutant** (รันจริง ไม่ได้เถียง)
  · T4/T4b รอดเพราะกลบกันเอง แต่ไม่ใช่ช่องโหว่ที่ใช้ประโยชน์ได้ (พิสูจน์ด้วยการรัน)
  · T9 อยู่นอกขอบเขต issue นี้

## สิ่งที่ขอให้ทำ (ไม่ block merge)

1. **เทสหนึ่งตัวที่ `issuedAt` กับ `firstIssuedAt` ต่างกัน** — ตัวหนึ่งอนาคต อีกตัวปกติ
   ทั้งสองทิศ เทสปัจจุบันตั้งสองค่าเท่ากันเสมอ จึงไม่เคยทดสอบรูปร่างที่ `mintIfEntitled`
   ผลิตจริง และทำให้ T4/T4b รอด
2. **เทสว่า `malformed` กับ `expired` ให้ status + body เดียวกันเป๊ะ** — ปัจจุบันไม่มีอะไร
   pin บรรทัด `verdict.reason === "mismatch" ? 403 : 401` ไว้
3. **issue แยกสำหรับ `EMBED_REQUIRE_ALLOWLIST`** — presence-check ไม่มีเทสคุ้ม ต่างจาก
   `EMBED_REQUIRE_SESSION_TOKEN` ที่มีสามตัว

## Residual ที่ยังอยู่ (บันทึก ไม่ใช่ข้อเรียกร้อง)

- **DEPLOY NOTE พึ่งคนอ่าน** — token เก่าทั้งหมด invalid และไม่มี dual-verify (ถูกแล้ว
  ตามที่ผม ruling ไว้: dual-verify = คง collision ไว้ตลอด transition) แต่คำสั่ง "flip
  `EMBED_REQUIRE_SESSION_TOKEN` off ก่อน deploy แล้วเปิดกลับ" อยู่ในคอมเมนต์เท่านั้น
  ไม่มีอะไรบังคับ ถ้ามี deployment ที่เปิด flag อยู่และ deploy ตรง ๆ visitor จะโดน 401
  จนกว่าจะเปิด session ใหม่ — recoverable แต่มองเห็นได้ทันที (ตรงกับที่ ruling ยอมรับ)
- **`firstIssuedAtOf` parse ไม่ authenticate** — คอมเมนต์เขียนไว้ชัดและ call site เดียว
  เรียกหลัง `verdict.valid` แล้ว ปลอดภัยวันนี้ แต่เป็นฟังก์ชันที่ชื่อไม่ได้บอกอันตราย
  ถ้ามีคนเรียกที่อื่นจะไม่มีอะไรเตือน

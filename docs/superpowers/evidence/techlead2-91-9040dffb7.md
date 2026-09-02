# Techlead-2 — #91 `9040dffb7` (unknown-key refusal): **PASS**

worktree `/tmp/tl2-91` (detached `9040dffb7`), donor `node_modules` = `/tmp/qa2-84b`,
`prisma generate` + `migrate deploy` ลง DB ของผมเอง `t91` บน `:55472` — ไม่แตะ checkout หลัก
ไม่แตะ worktree ของ dev คนไหน

```
git worktree add --detach /tmp/tl2-91 9040dffb7
cp -al /tmp/qa2-84b/server/node_modules /tmp/tl2-91/server/node_modules
cd /tmp/tl2-91/server && npx prisma generate
DATABASE_URL="postgresql://postgres:pw@127.0.0.1:55472/t91" npx prisma migrate deploy
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" STORAGE_DIR=/tmp/tl2-91-store \
       SIG_KEY=<hex32> SIG_SALT=b API_KEY_PEPPER=<32+ bytes> \
       JWT_SECRET=test-jwt-secret-at-least-12-chars \
       DATABASE_URL="postgresql://postgres:pw@127.0.0.1:55472/t91"
npx jest __tests__/api/updateEnvUnknownKeysHttp.test.js \
         __tests__/api/updateEnvGateHttp.test.js \
         __tests__/api/credentialClearHttp.test.js --runInBand
```

**baseline: 3/3 suites, 50/50 tests, 0 failed** — วัดซ้ำหลัง mutation ครบ ยัง 50/50

---

## (1) ลำดับ check ก่อน preUpdate — วัดได้จริง และเทสจับได้จริง

นี่คือข้อที่ผมกังวลที่สุดตอน pre-read เพราะถ้าเทสดูแค่ status code ลำดับจะ green
ทั้งสองแบบ (§7.9) ผมจึงยิงสองมิวแทนต่างกัน:

**M1 — ย้ายทั้งบล็อกไปหลังลูป (ก่อน `logChangesToEventLog`)**
→ **6 failed** แต่เป็น `Expected 400, Received 500` ทั้งหมด **ไม่ใช่หลักฐานที่ผมต้องการ**
เพราะ key ที่ไม่รู้จักหลุดเข้าลูปแล้วไปตายที่ `KEY_MAPPING[key]` เป็น undefined → throw →
catch ของ route ตอบ 500 มิวแทนตาย*ก่อน*จะพิสูจน์เรื่องลำดับ นับว่า "แดง" ได้ แต่แดงด้วยเหตุผลผิด

**M1b — มิวแทนที่คมกว่า: ตรวจเจอ unknown เหมือนเดิม แต่ *เขียนของจริงก่อน* แล้วค่อยคืน
refusal ตอนท้าย** (คง `validKeys.includes(key)` ใน `ENV_KEYS` ไว้เพื่อไม่ให้ throw)
นี่คือรูปร่างของบั๊กที่ ruling "all-or-nothing ไม่ต้อง rollback" ตั้งใจกัน — response 400
เหมือนเดิมทุกประการ ต่างกันแค่ side effect

→ **3 failed** และเป็นชุดที่ถูก:

| เทส | ที่แดง |
|---|---|
| `admin route rejects mixed keys without writing valid values` | `CredentialStore.get("OPEN_AI_KEY")` = `"sk-must-never-be-persisted"` ไม่ใช่ `"sk-stored-before-the-refusal"` |
| `v1 route rejects mixed keys …` | เหมือนกัน |
| `checks unknown keys before preUpdate hooks` | `Telemetry.sendTelemetry` ถูกเรียก 1 ครั้ง (`"telemetry_disabled"`) ทั้งที่ควรเป็น 0 |

**สองเทสนี้อ่าน durable state กลับมาจริง** — `CredentialStore.get` คือ row ในที่เก็บ
ไม่ใช่ `process.env` ซึ่งเป็น in-memory คอมเมนต์ในเทสเขียนเหตุผลไว้ตรงตัวว่าทำไมต้องอ่าน
row ไม่ใช่ env และเทส `before preUpdate hooks` จับ side effect ของ hook (telemetry call)
ไม่ใช่ status code ทั้งสองแบบตอบคำถาม "เขียนไปแล้วหรือยัง" ไม่ใช่ "ตอบอะไรกลับมา"

**สรุปข้อ 1: ผ่าน** ลำดับ check-ก่อน-preUpdate วัดได้ และเทสที่ Dev1 เขียนถือคำตัดสินนั้นจริง
ไม่ใช่เทสที่เขียวเพราะ status code

## (2) 400/500 pin แยกกัน

| mutation | ผล |
|---|---|
| **M2** ยุบ 400 ทิ้ง (`result.error ? 500 : 200`) | **6 failed** — เทส unknown-key ทั้งชุดแดง `Expected 400, Received 500` |
| **M3** คืน 200-on-error (`code === "unknown_keys" ? 400 : 200`) | **3 failed** — `admin/v1 route maps a validation error to 500` + `credentialClearHttp :: the validator refuses ''` |

สองมิวแทนนี้แดง**คนละชุดไม่ทับกันเลย** ซึ่งเป็นสิ่งที่ต้องเห็น: ถ้า pin เดียวคุมทั้งสอง
สถานะ การยุบ 400 กับการคืน 200 จะแดงชุดเดียวกันและเราจะแยกไม่ออกว่าเทสตัวไหนคุมอะไร
M2 พิสูจน์ว่า 400 มีฟันของตัวเอง M3 พิสูจน์ว่า 500 มีฟันของตัวเอง

## (3) เพดานการสะท้อน key กลับ

| mutation | ผล |
|---|---|
| **M4** สะท้อนทุก key ไม่จำกัด (ตัด `.slice(0,50)` และการตัด 64) | **1 failed** — `caps reflected keys and truncates by Unicode code points` |
| **M5** ตัดด้วย `key.slice(0,64)` (UTF-16) แทน `[...key]` (code point) | **1 failed** — เทสเดียวกัน |

M5 คือตัวที่มีค่า: มิวแทนนี้ "ดูถูกต้อง" ในสายตาคนอ่าน diff — ยังตัดที่ 64 เหมือนกัน
ต่างกันแค่หน่วย เทสจับได้แปลว่ามันทดสอบ surrogate pair จริง ไม่ใช่แค่นับความยาว

## (4) permission gate

| mutation | ผล |
|---|---|
| **M6** ถอดการตรวจ unknown ออกทั้งหมด คืน `validKeys.includes` เข้าไปใน `ENV_KEYS` (พฤติกรรมเดิม: กลืนเงียบ) | **6 failed** |
| **M7** คืน `system.write` → `settings.write` ทั้งสองเส้น | **3 failed** — `updateEnvGateHttp` ทั้ง 3 เทส (manager secret write / non-secret write / clearing a stored credential) |

M7 สำคัญเพราะเป็นการเปลี่ยน gate ที่ไม่ได้อยู่ในหัวข้อของ issue — คอมเมนต์อ้าง #84 และให้เหตุผล
ว่า `INSTANCE_AUTH_KEYS` กัน AUTH_TOKEN/JWT_SECRET แค่ 2 จาก 92 secret keys เหลืออีก 90 ตัว
ที่ล้างได้ภายใต้ gate ที่อ่อนกว่า เทส `updateEnvGateHttp.test.js` (269 บรรทัดใหม่) ถือคำตัดสินนี้
โดยตรงและแดงเมื่อ revert — ไม่ใช่คอมเมนต์ลอย

## (5) frontend 3 จุด — ตรวจ source เอง

`System.updateSystem` (`frontend/src/models/system.js:269`) เรียก `res.json()` **โดยไม่ดู
`res.ok` เลย** ดังนั้น body ของ 400/500 ถูก parse ปกติและ `.error` เป็น string ที่มีเนื้อหา
ทั้งสามจุด destructure `const { error } = await System.updateSystem(...)` แล้วเช็ค `if (error)`:

| ไฟล์ | บรรทัด | รูปแบบ |
|---|---|---|
| `LLMPreference/index.jsx` | 470 | `const { error } = …` → `if (error) showToast(…, "error")` |
| `VectorDatabase/index.jsx` | 145 | เหมือนกัน + `setHasChanges(true)` |
| `EmbeddingPreference/index.jsx` | 199 | เหมือนกัน + `setHasChanges(true)` |

ความกังวลที่ผมยกไว้ตอน pre-read (`if (res.error)` ที่ error เป็น `""` ตอนสำเร็จ จะเงียบ)
**ไม่เกิด** เพราะ path สำเร็จคืน `error: false` ไม่ใช่ `""` (`error?.length > 0 ? error : false`)
และทั้งสามจุดอ่าน `.error` ไม่ได้อ่าน `.code`/`.unknownKeys` ดังนั้นการเพิ่ม field ใหม่
ไม่ทำให้จุดไหน regress — สัญญา `{newValues, error}` ที่ ruling สั่งให้คงไว้ ทำหน้าที่ตรงนี้พอดี

**LLMPreference ต่างจากอีกสองจุดเล็กน้อย**: `setHasChanges(!!error)` (บรรทัด 479) แทน
`setHasChanges(true/false)` ในบล็อก ผลลัพธ์เหมือนกัน ไม่ใช่บั๊ก แค่บันทึกไว้ว่ารูปแบบไม่เหมือนกัน
ทั้งสามจุด

---

## นอกสเปก: `credentialClearHttp.test.js` premise guard 200→500 — **ยอมรับ ไม่ใช่การแก้เทสให้เขียว**

นี่คือจุดที่ต้องระวังที่สุดในรีวิวนี้ เพราะ "dev แก้ assertion ในเทสที่มีอยู่แล้วให้ตรงกับ
พฤติกรรมใหม่" คือรูปร่างเดียวกับการปิดปากเทส ผมจึงตรวจสามชั้น:

1. **เทสนี้ทดสอบอะไรจริง ๆ** — ชื่อคือ `"the validator refuses '' before the delete branch
   is reachable"` และคอมเมนต์เดิมเขียนว่าเป็น "the premise of the whole issue, asserted
   rather than assumed" สิ่งที่มันคุ้มครองคือ **การปฏิเสธ** และ **row ที่ยังอยู่**
   (`expect(await CredentialStore.get(ENV_KEY)).toBe(SECRET)`) ไม่ใช่ตัวเลข status
2. **assertion อีกสองบรรทัดไม่ถูกแตะ** — `expect(response.body.error).toMatch(/empty/i)`
   และ `CredentialStore.get(ENV_KEY) === SECRET` ยังอยู่ครบ diff คือ **+4 −1**: เปลี่ยน
   `200` เป็น `500` และเพิ่มคอมเมนต์ 3 บรรทัดอธิบายว่าทำไม
3. **มิวแทน M3 ยืนยันว่ามันยังมีฟัน** — คืน 200-on-error แล้วเทสนี้ **แดง** ถ้ามันเป็นการแก้
   ให้เขียวเฉย ๆ มันจะไม่แดงตอน revert

**ที่สำคัญกว่านั้น: 500 คือคำตอบที่ถูกกว่า 200** พฤติกรรมเดิมคือ route ตอบ 200 พร้อม
`{error: "...cannot be empty"}` ใน body — client ที่ดู status อย่างเดียวอ่าน write ที่ถูก
ปฏิเสธว่า "สำเร็จ" ซึ่งเป็นบั๊กในตัวมันเอง เทสเดิมจึง pin พฤติกรรมที่ผิดไว้โดยไม่ตั้งใจ
การแก้ 200→500 คือการหยุด pin บั๊ก ไม่ใช่การหลบเทส

**verdict นอกสเปก: PASS** — อยู่ในขอบเขตที่สมเหตุสมผลของ issue (route เดียวกัน ตัวแปรเดียวกัน)
และไม่ได้ลดกำลังการตรวจของเทสลงเลย

---

## Verdict

**PASS** — ทั้งสามข้อที่ผมขอไว้ตอน pre-read ทำครบและวัดได้:

1. durable-state test อ่าน `CredentialStore.get` กลับจริง — M1b (เขียนก่อนแล้วค่อยปฏิเสธ)
   ยังแดง 3 เทส ทั้งที่ response 400 เหมือนเดิมทุกประการ
2. 400/500 pin แยกกันจริง — M2 และ M3 แดงคนละชุด ไม่ทับกัน
3. frontend 3 จุด destructure `{error}` เท่านั้น สัญญา `{newValues,error}` ยังครบ
   ไม่มีจุดไหน regress จาก field ใหม่

mutation 7 ตัว (M1, M1b, M2, M3, M4, M5, M6, M7) **จับได้ทุกตัว** และแดงคนละชุดตามที่ควร
restore ครบ — `diff` ยืนยัน byte-identical ทั้ง 3 ไฟล์ production, `git status --short` สะอาด,
baseline ซ้ำได้ 50/50

## หมายเหตุ (ไม่ block)

- **M1 (ย้ายทั้งบล็อก) แดงด้วยเหตุผลผิด** — 500 จาก `KEY_MAPPING[undefined]` throw ไม่ใช่จาก
  การตรวจลำดับ ใครใช้มิวแทนนี้เป็นหลักฐานเรื่องลำดับในอนาคตควรใช้ M1b แทน (คง
  `validKeys.includes` ไว้ใน `ENV_KEYS` เพื่อไม่ให้ throw บังหน้า) บันทึกไว้เพราะเป็นกับดัก
  §7.9 รูปแบบเดียวกับที่ผมเคยพลาดใน #40 (`Tests: 0 total`)
- **`ENV_KEYS` ไม่มี `validKeys.includes` แล้ว** — ปลอดภัยเพราะการ return ก่อนหน้าคุมไว้
  แต่แปลว่าฟังก์ชันนี้พึ่ง early-return เป็นเงื่อนไขความถูกต้อง ไม่ใช่ defence in depth
  ถ้ามีใครเพิ่ม path ที่ข้ามการตรวจนั้นในอนาคต `KEY_MAPPING[key]` จะ throw ทันที
  (fail-closed ไม่ใช่ fail-open) จึงไม่ใช่รู แต่ควรมีคอมเมนต์บอกว่าสองบรรทัดนี้ผูกกัน
- **`unknownKeyCount` สะท้อนจำนวนจริง แต่ `unknownKeys` ตัดที่ 50** — ตั้งใจและมีเทสคุม
  ผู้เรียกที่เทียบ `unknownKeys.length` กับ `unknownKeyCount` จะเห็นไม่เท่ากันเมื่อเกิน 50
  ซึ่งคือพฤติกรรมที่ต้องการ (บอกว่ามีเท่าไร โดยไม่สะท้อนทั้งหมดกลับ)

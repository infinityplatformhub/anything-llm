# Techlead-2 — #125 `44a761a1f`: **PASS**

worktree `/tmp/tl2-125` (detached `44a761a1f`) donor `/tmp/qa2-84b`, DB `t125`

**baseline: 1/1 suite, 25/25 tests, 0 failed** — วัดซ้ำหลัง mutation ครบ ยัง 25/25

---

## จุดตรวจ 6 ข้อที่ขอมา

### (1) cache keyed on exact `material` `===` — **M1 แดง 2 ตัว ยืนยัน**

มิวแทน `if (keyCache) return keyCache.key;` (ทิ้งการเทียบ material) →
**2 failed**: `a value stored under a different SIG_KEY does not decrypt` และ
`rotating SIG_KEY mid-process re-derives instead of reusing the old key`

ตัวแรกสำคัญกว่าที่ชื่อบอก — เป็นเทสที่มีอยู่**ก่อน** #125 (อยู่ในกลุ่ม `tampering is detected`)
ดังนั้น memoize ที่ทำผิดจะทำลาย invariant เดิมของ credential store ไม่ใช่แค่ทำให้เทสใหม่แดง

**`===` แทน `timingSafeEqual` — ถูก และคอมเมนต์ให้เหตุผลถูก** *"both sides are the same local
value and neither is attacker-supplied. A constant-time primitive here would tell the next
reader that one side can be chosen by someone else, which is not true."* · ตรงกับที่ผมยกไว้ตอน
pre-read: นี่คือ cache invalidation key ไม่ใช่ secret comparison

### (2) "guard ใต้ cache เป็น equivalent mutation" — **พิสูจน์ด้วยการรัน ไม่ใช่การเถียง**

Dev5 อ้างว่าย้าย guard ไปใต้ cache read เป็น equivalent เพราะ cache เก็บเฉพาะ material ที่
validate แล้ว · **ผมยิงมิวแทนจริงและได้ 25/25 เขียว** ซึ่งสอดคล้องกับข้ออ้าง แต่เขียวอย่างเดียว
ไม่พิสูจน์ equivalence — มันอาจแปลว่าเทสไม่ครอบ · จึงรัน**พฤติกรรมจริง**บนมิวแทน โดยเรียก
`CredentialStore.set()` (ซึ่งเรียก `encryptionKey()`) ผ่านสถานะ SIG_KEY ห้าแบบ หลังอุ่น cache แล้ว:

```
valid 64-char (warms cache)    ACCEPTED
SIG_KEY deleted                REFUSED: SIG_KEY must be set and at least 32 characters…
SIG_KEY 31 chars               REFUSED
SIG_KEY 40 spaces              REFUSED
SIG_KEY empty                  REFUSED
valid again                    ACCEPTED
```

**ทั้งห้ากรณีให้ผลเหมือนเดิมทุกประการ** เหตุผลเชิงโครงสร้าง: `material` ถูกอ่านจาก
`process.env.SIG_KEY` ก่อนทั้งสองอย่าง ดังนั้นเมื่อ material ไม่ผ่าน guard มันก็ไม่ตรงกับ
`keyCache.material` ที่เคยผ่าน guard มาแล้วเช่นกัน → cache miss → ตกลงมาถึง guard อยู่ดี ·
**equivalence จริง** พิสูจน์โดยการรัน ไม่ใช่โดยการอ่าน

**แต่ลำดับที่ใช้จริง (guard ก่อน cache) ยังดีกว่า** และคอมเมนต์ระบุเงื่อนไขไว้ตรง:
*"A cache that outlives its material is a credential store that keeps working after its key
has been taken away"* — equivalence วันนี้ขึ้นกับข้อเท็จจริงที่ว่า cache key คือ material
ถ้าวันหนึ่ง cache key เปลี่ยน (เช่น keyed by `KEY_VERSION`) ลำดับจะกลายเป็นสำคัญทันที ·
ลำดับปัจจุบันไม่พึ่งข้อเท็จจริงนั้น

### (3) reachability test assert บน value ไม่ใช่ชื่อ — **ยืนยัน และมีฟัน**

เทสวน `Object.entries(CredentialStore)` แล้ว assert `typeof === "function"` และ
`Buffer.isBuffer(value) === false` พร้อมคอมเมนต์อธิบายว่าทำไมไม่ใช้ name-based rule
(*"a name-based rule would flag `keys()` while missing a Buffer stored under an innocuous name"*)

**M4** (เพิ่ม `_keyCache: () => keyCache` เป็น method) → **เขียว** — ถูกต้อง เพราะเป็น function
ที่ไม่ leak ค่าเมื่อ inspect · **M4b** (เพิ่ม `CredentialStore.derivedKey = key` คือ Buffer จริง)
→ **แดง 1** (`the derived key is not reachable from the exported object`) · มิวแทนคู่นี้แสดงว่า
เทสแยก "method ใหม่" ออกจาก "ค่าที่รั่ว" ได้ถูกต้อง ไม่ได้ห้ามทุกอย่าง

### (4) cross-process test นับ `DERIVATIONS=` marker — **ยืนยัน และ ledger บันทึกความพยายามที่ผิดสองครั้ง**

เทสสร้าง child process, patch `crypto.scryptSync` เพื่อนับ, เรียก `CredentialStore.set()`
**สองครั้ง** แล้ว assert count === 1 · parse จาก marker เพราะ Prisma log pool size ทำให้
`Number(stdout)` เป็น NaN

**คอมเมนต์ในเทสระบุเวอร์ชันที่ผิดสองแบบไว้เอง** — (ก) เรียก `get()` บนแถวที่ไม่มี ซึ่ง return
ก่อน derive จึงนับได้ 0 และผ่านด้วยเหตุผลผิด (ข) นับ `scryptSync` ที่เทสเรียกเอง ไม่ได้แตะ
CredentialStore เลย · **นี่คือรูปแบบ §7.9 ที่บันทึกไว้เองก่อนที่ผมจะต้องหา** — assert `=== 1`
บังคับทั้งสองด้าน: cache เริ่มเย็น (จึง derive) และทำงาน (จึงไม่ derive ซ้ำ)

### (5) 31-char + whitespace-40 แตะ `trim()` — **M3 แดง**

มิวแทน `material.trim().length` → `material.length` → **1 failed**
(`a SIG_KEY of only whitespace is refused, however long`) · ขา 31 ตัวไม่แดงเพราะ 31 < 32 อยู่แล้ว
ทั้งสองแบบ — ถูกต้อง เทสสองตัวถือคนละขาของ guard ตามที่ผมขอตอน pre-read

### (6) side-channel 29.5 → 0.9 ms — **เทสวัดจริง และรายงานตัวเลขเมื่อล้ม**

เทสวัด present/absent อย่างละ 5 sample เอา min แล้ว assert `delta < 5ms` · **วิธี assert
ฉลาด**: เขียนเป็น `expect(actualString).toBe(cond ? actualString : "delta below 5ms")` ซึ่งทำให้
ข้อความ failure **มีตัวเลขจริงติดมาด้วย** แทนที่จะเป็น `expected true, got false` — คนที่เจอ
บนเครื่องช้ากว่าไม่ต้องไปทำซ้ำเอง

เทส 97 แถววัดด้วย `Date.now()` ไม่ใช่ spy count พร้อมคอมเมนต์ที่ตอบข้อ (ช) ที่ผมยกไว้ตรงตัว:
*"a spy proves the cache is consulted, a clock proves it saves something"*

---

## mutation ทั้งหมด

| # | mutation | ผล |
|---|---|---|
| **M1** | cache ไม่เทียบ material | **2 failed** |
| **M2** | ย้าย guard ไปใต้ cache read | **25/25 เขียว** — equivalent จริง (พิสูจน์ด้วยการรัน §2) |
| **M3** | ถอด `.trim()` ออกจาก guard | **1 failed** |
| **M4** | เพิ่ม method ที่คืน cache | **เขียว** — ถูก (function ไม่ leak ค่า) |
| **M4b** | เพิ่ม Buffer ของ key ลงบน object | **1 failed** |
| **M5** | ปิด memo ทั้งหมด | **5 failed** — `N reads derive ONCE`, `cold cache derives exactly once`, `fresh process starts with a cold cache`, `present and absent cost the same`, `reading 97 credentials costs about one derivation` |

**M5 แดง 5 ตัวคือหลักฐานที่แข็งที่สุด** — ครอบทั้งสามคุณสมบัติที่ issue อ้าง: จำนวนการ derive
(spy), เวลา (clock), และการปิด side channel · ถ้าเทสชุดนี้พึ่ง spy อย่างเดียว M5 จะแดงแค่สองตัว
และ "เร็วขึ้นจริงไหม" จะไม่มีอะไรตอบ

---

## Verdict

**PASS** — ไม่มี blocker · **ไม่มี REQUIRED RED FIXTURE ที่ยังขาด**

จุดตรวจทั้ง 6 ข้อผ่านครบ และสามข้อทำเกินที่ผมขอตอน pre-read:
- (จ) oracle test ที่ผมขอ — มีจริง วัด present/absent หลัง cache อุ่น และ**รายงานตัวเลขในข้อความ
  failure** ซึ่งผมไม่ได้ขอ
- (ช) วัดด้วยนาฬิกาไม่ใช่ spy — ทำ และเขียนเหตุผลไว้ตรงกับที่ผมยก
- (ฉ) module-scope `let` — ทำ และเทส assert บน **value** ซึ่งแข็งกว่า `Object.keys` ที่ผมเสนอ

**ข้อสังเกตที่ควรบันทึกใน ledger (ไม่ block)**: equivalence ของ M2 **ขึ้นกับข้อเท็จจริงที่ว่า
cache key คือ material** ไม่ใช่คุณสมบัติของโค้ดโดยทั่วไป · ถ้าวันหนึ่งมีคนเปลี่ยน cache key
(เช่น เพิ่ม `KEY_VERSION` เข้าไปด้วย หรือ cache หลาย entry) ลำดับ guard-ก่อน-cache จะกลายเป็น
สำคัญทันทีและไม่มีเทสไหนจับได้ · คอมเมนต์ปัจจุบันเขียนเหตุผล**ว่าทำไมลำดับนี้ถูก** แล้ว —
ขอเพิ่มบรรทัดเดียวว่า **มิวแทนสลับลำดับเป็น equivalent วันนี้ เพราะ cache key คือ material เอง**
เพื่อให้คนที่เปลี่ยน cache key ในอนาคตเห็นว่าตัวเองกำลังทำลายเงื่อนไขอะไร

## Residual (บันทึก)

- **memo เป็น per-process** — เทส `a fresh process starts with a cold cache` ยืนยันและคอมเมนต์
  ระบุว่าเป็นการกันไม่ให้ถูกเข้าใจว่าเป็นอะไรที่ durable · หมายความว่า boot ทุกครั้งยังจ่าย
  หนึ่ง derivation (~28ms) ซึ่งเป็นราคาที่ถูกและตั้งใจ
- **oracle ปิดเฉพาะหลัง derivation แรก** — คำขอแรกสุดของ process ยังต่างกัน 28ms · ในทางปฏิบัติ
  ไม่ถึงเพราะ `loadStoredCredentials` (#115) อุ่น cache ก่อน `listen()` แต่ถ้ามีใครย้ายมันกลับ
  เข้า callback รูจะกลับมาที่คำขอแรก · **#115 กับ #125 ผูกกันในเรื่องนี้** และไม่มีเทสไหนที่
  ถือความผูกพันนั้นไว้

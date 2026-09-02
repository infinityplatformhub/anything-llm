# Techlead-2 — #122 `67a57ae17`: **PASS** (พร้อม 2 ช่องว่างในเทสที่ควรปิด)

worktree `/tmp/tl2-122` (detached `67a57ae17`) donor `/tmp/qa2-84b`, DB `t122`

**baseline: 2/2 suites, 13/13 tests, 0 failed** — วัดซ้ำหลัง mutation ครบ ยัง 13/13

---

## RF ที่ผมให้ไว้ — ตรวจว่าทำจริงไหม ไม่ใช่เชื่อรายงาน

### RF-1 holder ต้องยืนยันด้วย `pg_stat_activity` — **ทำถูกทุกข้อ**

อ่าน fixture เอง:

```js
async function backendCount(counter) {
  const { rows } = await counter.query(
    `SELECT count(*)::int AS n
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()`);
  return rows[0].n;
}
async function withCounter(fn) {
  const counter = new Client({ connectionString: forPostgresClient(...) });
  await counter.connect();
  await counter.query("SELECT 1");   // ← ข้อที่ผมยืนยันว่าต้องมี
  ...
}
```

ครบทั้งสามข้อที่ผมขอ: `pg_stat_activity`, `pid <> pg_backend_pid()`, และ **`SELECT 1` ก่อนนับ**
· คอมเมนต์ในโค้ดเขียนเหตุผลไว้ตรงตัว: *"a `pg.Client` that has connected but issued no
statement may not yet appear as a backend"* — ตรงกับที่ผมยกมาและเป็นเหตุผลที่ถูก

**และเทสวัดของจริง**: 40 query ขนานบน `connection_limit=3` → `used <= 6` (ให้ slack สำหรับ
connection ที่กำลังปิด แต่ *"not 37 of it"*) และ `used > 0` — ขาหลังคือ positive control
ที่กันไม่ให้เทสผ่านเพราะไม่มี connection เลย

### RF-2 negative control — **แข็งแรงกว่าที่ผมขอ และ Dev5 แก้ข้อที่ผมสั่งไม่ครบ**

ผมขอ *"มิวแทนที่ทำให้ reconnect ไม่เกิด → แดง"* · Dev5 ลองแบบนั้นก่อน (client ที่ปิดแล้วต้อง
ใช้ไม่ได้) แล้วพบว่า **PrismaClient reconnect ตัวเองเสมอ** ดังนั้น control รูปนั้นเป็น vacuous —
มันผ่านไม่ว่า singleton จะมีคุณสมบัตินั้นหรือไม่

สิ่งที่ใช้แทนคือ **round trip ไป port ที่ไม่มีใครฟัง**:
```js
const dead = new PrismaClient({ datasourceUrl: "postgresql://nobody@127.0.0.1:1/none" });
await expect(dead.$queryRaw`SELECT 1`).rejects.toThrow();
```
ซึ่งพิสูจน์ว่า reconnect เป็น round trip จริงไม่ใช่คำตอบจาก cache — เป็น control ที่ตอบคำถามได้
ส่วน control ที่ผมเสนอตอบไม่ได้

**และมีอีกครึ่งที่ผมไม่ได้ขอ**: `releases its backends when disconnected` — วัดว่า
`$disconnect` **คืน backend จริง** (`during > before`, แล้วหลัง disconnect `<= before`)
คอมเมนต์เขียนเหตุผลถูก: *"reconnecting is only useful if disconnecting actually frees
something"* — ถ้าไม่มีข้อนี้ "reconnect ได้" อาจเป็นจริงกับ client ที่ไม่เคยปล่อยอะไรเลย

### RF-3 ลำดับสวีท — **ทำในรูปที่ถูกกว่าที่ผมเสนอ**

ผมเสนอให้บังคับลำดับสวีทข้ามไฟล์ · Dev5 ใช้ **สองเทสในไฟล์เดียว** พร้อมเหตุผลที่ผมยอมรับ:
*"jest guarantees order within a file and does not guarantee it between them — a two-file
version would be a test whose premise is unenforced"* · ถูกต้อง — RF ที่ผมเสนอจะเป็นเทสที่
สมมติฐานของมันเองไม่มีอะไรรับประกัน

### RF-4 / RF-5 — รับรายงาน (ไม่ได้รันเอง)

memo test ของ #96 ผ่านใต้ cap และ full run 2980/3017 เป็นตัวเลขที่ผมไม่ได้วัดเอง —
บันทึกว่าเป็นรายงานของ Dev5/gate ไม่ใช่การวัดของผม (§7.14: ผมไม่รัน full suite)

---

## mutation

| # | mutation | ผล |
|---|---|---|
| **M1** | `forPrismaTest` กลับไป `delete("connection_limit")` (บั๊กเดิม) | **3 failed** — `preserves an explicit connection_limit`, `supplies a default cap`, `keeps the pool cap when deriving an isolated Prisma schema` |
| **M2** | ถอด `setupFilesAfterEnv` ออกจาก `jest.config.js` | **13/13 เขียว** ⚠ |
| **M3** | ทำ `afterAll` ใน `disconnectPrisma.js` ให้เป็น no-op | **13/13 เขียว** ⚠ |
| **M4** | `DEFAULT_TEST_CONNECTION_LIMIT` = `"100"` | **13/13 เขียว** ⚠ |

**M1 แดง 3 ตัวข้ามสองไฟล์** — เป็นข้อที่สำคัญที่สุดของ issue นี้ (การลบ `connection_limit`
คือสิ่งที่ทำให้ fix ดูเหมือนครบทั้งที่สามสวีทยังไม่ถูก cap) และมีเทสถือไว้ทั้งใน
`connectionBudget` และ `postgresUrl`

## (ก) M2/M3 รอด — การ disconnect กลางไม่มีเทสที่แดงเมื่อถอดออก

ถอด setup file ทิ้ง หรือทำ hook เป็น no-op → **13/13 เขียวทั้งคู่**

สาเหตุ: เทส RF-3 (`first: uses prisma, then disconnects it` / `second: uses prisma again`)
เรียก `prisma.$disconnect()` **ในตัวเทสเอง** ไม่ได้พึ่ง hook กลาง · เทสจึงพิสูจน์ว่า
*"singleton ทนการ disconnect ได้"* ซึ่งเป็นคุณสมบัติที่ทำให้ hook **ปลอดภัย** — แต่ไม่ได้
พิสูจน์ว่า hook **มีอยู่และทำงาน**

**เป็นช่องโหว่จริงหรือไม่ — ไม่ใช่ในเชิงพฤติกรรมวันนี้** โค้ดถูกต้อง (`jest.config.js` ชี้ไป
ไฟล์นั้นจริง, hook เรียก `$disconnect` จริง) และ M1 ยังคุ้มครองครึ่งที่เป็น cap · แต่
**สิ่งที่ issue นี้แก้มีสองครึ่ง** (cap + disconnect) และครึ่งที่สองไม่มีอะไรจับได้ถ้าหายไป —
ซึ่งคือ failure mode ที่ #122 มีอยู่เพื่อป้องกันพอดี: 28 จาก 55 สวีทที่ลืม disconnect

**ขอเพิ่ม (ไม่ block)**: เทสที่พิสูจน์ว่า hook ถูกติดตั้งจริง สองทางที่ทำได้:
1. **assert บน config** — อ่าน `jest.config.js` แล้วยืนยันว่า `setupFilesAfterEnv` มีไฟล์นั้น
   (อ่อน แต่ฆ่า M2)
2. **assert เชิงพฤติกรรม** — ในไฟล์เทสที่ไม่เรียก `$disconnect` เอง วัด backend count
   ใน `afterAll` ของตัวเองที่ลงทะเบียน**หลัง** hook กลาง (jest รัน afterAll แบบ LIFO
   ภายในไฟล์เดียว แต่ setup file ลงทะเบียนก่อน จึงรันหลัง) — ซับซ้อนกว่าและอาจเปราะ

ข้อ 1 พอสำหรับเจตนา: มันเปลี่ยน "หายไปแล้วเงียบ" เป็น "หายไปแล้ว CI แดง"

## (ข) M4 รอด — ค่า default ไม่ถูก pin

`DEFAULT_TEST_CONNECTION_LIMIT = "100"` → เขียวหมด เพราะเทสเขียนว่า
`expect(url).toContain(\`connection_limit=${DEFAULT_TEST_CONNECTION_LIMIT}\`)` — **assert
เทียบกับตัวมันเอง** ซึ่งเป็น tautology รูปเดียวกับที่ JSDoc ของ #114 เตือนไว้พอดี
(*"A rule applied to the same object it is checked against can never fail"*)

**ไม่ใช่ช่องโหว่ที่ใช้ประโยชน์ได้** — เป็นค่าคงที่ในเทสฮาร์เนส ไม่ใช่ production · และเทสวัดจริง
(`holds far fewer backends`) ใช้ `connection_limit=3` ที่เขียนตรง ๆ ไม่ได้ผ่านค่านี้ ดังนั้น
คุณสมบัติ "cap ทำงาน" ยังถูกพิสูจน์ · แต่ **ค่า 5 เองไม่มีอะไรยึด** ถ้าใครแก้เป็น 100
เพื่อ "แก้ปัญหา timeout" จะไม่มีอะไรบอกว่าเพิ่งยกเลิกจุดประสงค์ของ issue ไป

**ขอเพิ่ม (ไม่ block)**: `expect(Number(DEFAULT_TEST_CONNECTION_LIMIT)).toBeLessThanOrEqual(10)`
พร้อมคอมเมนต์ว่าทำไม — เปลี่ยนจาก tautology เป็นเพดานที่ตัดสินใจไว้

---

## Verdict

**PASS** — ไม่มี blocker

- RF-1 ทำครบทั้งสามข้อที่ผมยืนยัน (`pg_stat_activity` + `pid <> pg_backend_pid()` +
  `SELECT 1` ก่อนนับ) และวัดของจริง 40 query บน cap 3
- **RF-2 Dev5 แก้ข้อที่ผมสั่งไม่ครบ** — control ที่ผมเสนอ (closed client ต้องพัง) เป็น vacuous
  เพราะ PrismaClient reconnect เอง · ที่ใช้แทน (round trip ไป dead port) ตอบคำถามได้จริง
  และเพิ่ม `releases its backends` ซึ่งผมไม่ได้ขอแต่เป็นอีกครึ่งที่จำเป็น
- **RF-3 Dev5 ทำในรูปที่ถูกกว่าที่ผมเสนอ** — สองเทสในไฟล์เดียว เพราะ jest ไม่รับประกัน
  ลำดับข้ามไฟล์ · RF ที่ผมเสนอจะมีสมมติฐานที่ไม่มีอะไรบังคับ
- M1 แดง 3 ข้ามสองไฟล์ · M2/M3/M4 รอด แต่เป็นช่องว่างของเทส ไม่ใช่ของโค้ด (ตรวจ source
  ยืนยันว่าพฤติกรรมวันนี้ถูกทั้งหมด)

## สิ่งที่ขอให้ทำ (ไม่ block merge)

1. **assert ว่า `setupFilesAfterEnv` มี `disconnectPrisma.js`** — ฆ่า M2 และเปลี่ยนครึ่งที่สอง
   ของ issue จาก "หายไปเงียบ" เป็น "CI แดง"
2. **pin เพดานของ `DEFAULT_TEST_CONNECTION_LIMIT`** (`<= 10`) แทน assert ที่เทียบกับตัวมันเอง

## หมายเหตุ

- **RF-4/RF-5 ผมไม่ได้รันเอง** — memo test ใต้ cap และ full run 2980/3017 เป็นรายงานของ
  Dev5/gate ตาม §7.14 (Techlead ไม่รัน full suite) บันทึกไว้เพื่อไม่ให้ evidence นี้ถูกอ่านว่า
  ผมยืนยันตัวเลขนั้นเอง
- **เรื่องที่ผมเจอใน #114 อาจเกี่ยวกัน**: ระหว่างรีวิว #114 ผมเจอการรันหนึ่งครั้งที่ route
  ตอบ 500 แล้วทำซ้ำไม่ได้ 5 รอบ (ไฟล์ byte-identical, git สะอาด) สมมติฐานคือ connection
  ค้างจากรอบก่อน · ถ้าสมมติฐานนั้นถูก #122 คือสิ่งที่ปิดมัน — แต่ผมพิสูจน์ไม่ได้ทั้งสองทาง

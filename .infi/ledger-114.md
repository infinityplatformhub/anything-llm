# ledger #114 — GET /setup-complete

Ruling: TL-2 pre-read ผิดที่ premise — ไม่ใช่ "ตัด 72 ฟิลด์ที่ frontend ไม่อ่าน" frontend อ่าน ~200 ฟิลด์ เพราะ 8 หน้าโยนทั้ง object เข้า provider option component ยกขึ้น PMO ก่อนเขียน ถ้าผิด: จะพัง 8 หน้า settings + onboarding
Ruling (PMO/TL-2): shape (b) สามสาขา — unauth+มี user → 6 ฟิลด์ · pre-user → key ครบ endpoint = `""` · authed → เต็มเหมือนเดิม ถ้าผิด: admin settings 8 หน้าที่อ่าน ~200 ฟิลด์จะพัง
Ruling (PMO/TL-2): `""` ไม่ใช่ `null`/undefined — `JSON.stringify` ทิ้ง key ที่เป็น undefined ทำให้ controlled input พลิกเป็น uncontrolled กลางการพิมพ์ ถ้าผิด: ผู้ใช้พิมพ์ค่าแล้วหายตอน re-render
Ruling: `MASKED_ENDPOINT_FIELDS` เขียนชื่อออกมาตรง ๆ ไม่ derive จาก regex — กฎที่ตรวจกับ object เดียวกับที่มันกรอง ไม่มีวันแดง (§7.9f) drift test เทียบลิสต์กับ pattern แทน ถ้าผิด: ฟิลด์ใหม่จะถูก mask เงียบ ๆ โดยไม่มีใครตัดสิน
Ruling: `StorageDir` อยู่ในลิสต์ทั้งที่ชื่อไม่ลงท้ายด้วย suffix ไหนเลย — เป็น path บนเครื่อง host ซึ่งเป็นการเปิดเผยชนิดเดียวกันคนละสะกด drift test ยกเว้นมันตรง ๆ ถ้าผิด: ต้องเลือกระหว่างลิสต์ที่ derive ไม่ได้ กับการไม่ mask path
Ruling: `callerHasSession` **รัน** `validatedRequest` ไม่ใช่เขียนเช็คใหม่ — คอมเมนต์ของ middleware เองอธิบายไว้ว่าคำตอบสองชุดสำหรับ "single-user ไหม" คือที่มาของ #46 ถ้าผิด: passthrough branch / รูปแบบ encrypted `p` / การแก้ครั้งหน้า จะไม่ถูกสะท้อนในสำเนา
Ruling: session ชนะ pre-user เมื่อทั้งสองเป็นจริงพร้อมกัน — operator token ของ single-user install อยู่ในสถานะ pre-user เสมอ (ไม่มี row) ถ้า mask ทับ operator จะเห็น `""` แทนค่าที่ตัวเองตั้ง ถ้าผิด: single-user install จะแก้ config ของตัวเองไม่ได้
Ruling: R10 assert เป็น**การเปรียบเทียบ**กับ render ที่มีค่าครบ ไม่ใช่ "ไม่มี warning เลย" — component พวกนี้ warn อยู่แล้วบน main (`OllamaLLMOptions` ใส่ทั้ง `value` และ `defaultValue` บน input เดียวกัน) เทสที่เรียกร้อง 0 จะแดงบน main ด้วยเหตุที่ไม่เกี่ยวกับ #114 ถ้าผิด: ต้องแก้ component ที่ issue นี้ไม่ได้แตะ

## Mutations

| mutation | ผล |
|---|---|
| ตัด branch authenticated | 2 failed — `returns the provider fields…`, `the single-user operator token…` |
| pre-user ดูแค่ setting ไม่ดู user rows (R9) | 1 failed — `a user row with multi-user mode still off also closes it` |
| ส่ง `null` แทน `""` (R8) | 3 failed — `empties every endpoint field…`, `a bad operator token…`, `StorageDir is masked…` |
| ลบ `QdrantEndpoint` ออกจากลิสต์ (drift) | 2 failed — `scans the pre-user body too…`, `every field whose name ends…` |
| เพิ่ม `OllamaLLMBasePath` เข้า public allowlist (R1) | 5 failed |

แดงคนละชุดกันทั้งห้า

## ที่วัดเอง ไม่ได้เชื่อรายงาน

- field count ขึ้นกับ env: Dev1 **229** · QA-3 **135** · issue **92** → เทส derive ไม่ hardcode
- onboarding mount **37** option component อ่าน **128** ฟิลด์ ตอนยังไม่มี user
- endpoint-shaped ทั้งหมด **32** ฟิลด์ + `StorageDir` = 33 ในลิสต์
- ยิง probe host เข้า env ทีละตัวแล้วอ่าน `currentSettings()` กลับ: **32 จาก 33 คืนค่าดิบ**
  มีตัวเดียวที่ booleanise อยู่แล้วคือ `PGVectorConnectionString`

## แก้คำที่เคยพูดผิด

รอบ recon ผมรายงาน PMO ว่า `PGVectorConnectionString` รั่ว DSN เต็ม — **ผิด** มันถูก
booleanise อยู่แล้ว จับได้ตอนเทสแดงด้วย `Received: true` ไม่ใช่ตอนอ่านโค้ด ยังคงไว้ในลิสต์
เพราะถ้าวันหน้ามีคนเปลี่ยนกลับเป็น passthrough (ซึ่งเป็นรูปแบบที่เพื่อนบ้านทุกตัวเป็น)
มันจะไม่เริ่มเผยแพร่ DSN เงียบ ๆ ราคาคือ boolean ตัวหนึ่งที่ฟอร์ม pre-user ไม่ได้อ่าน

## กับดักที่เจอเอง

รันชุด related แล้วเห็น `persistCredentialFailureHttp.test.js` รายงาน **0 failed / 0 passed**
— ไฟล์นั้นอยู่ใน worktree pr104 ไม่ใช่ pr114 jest ไม่บ่นเรื่อง path ที่ไม่มีอยู่จริง
ตรงกับที่ PMO เตือนเรื่อง `0 total` เป๊ะ ๆ ตรวจทุกครั้งว่าจำนวนขยับ

`describe("#114 …")` ทำให้ด่าน commented-code แดง (§7.3a) เปลี่ยนเป็น `"issue 114 …"`

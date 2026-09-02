# ledger #91 — updateENV refuses unknown keys

Ruling: unknown-key check runs before the preUpdate/write loop, not inside the filter — a filter that skips unknown keys still applies every valid key in the same body, which is the silent-partial-write defect itself. ถ้าผิด: caller ที่ส่ง typo ปนของจริงจะเขียนบางส่วนโดยไม่รู้ตัว
Ruling: response คง `{newValues, error}` และเพิ่ม `code`/`unknownKeys`/`unknownKeyCount` แทนการเปลี่ยนรูป — frontend `System.updateSystem` อ่าน `res.json().error` ตัวเดียวและไม่ดู status เลย (3 จุดตัวอย่าง: LLMPreference/index.jsx:470, VectorDatabase/index.jsx:145, EmbeddingPreference/index.jsx:199). ถ้าผิด: ทุกหน้า settings จะรายงานสำเร็จทั้งที่ถูกปฏิเสธ
Ruling: 400 สำหรับ unknown_keys, 500 สำหรับ error อื่น, 200 เมื่อสะอาด — แยกกันเพราะ mutation ที่ยุบ 400 เข้า 500 ต้องแดง ถ้ายุบได้เงียบ ๆ แปลว่าเทสวัดแค่ "ไม่ใช่ 200"
Ruling: แก้ premise guard ใน credentialClearHttp.test.js จาก 200 เป็น 500 — ตัว 200 นั้นคือบั๊ก "200 ทั้งที่ error" ที่ issue นี้สั่งให้แก้ ไม่ใช่ contract ที่ต้องรักษา; ตัวเทสยังยืนยันข้อความ refusal และ credential row ที่รอดเหมือนเดิม ถ้าผิด: เราจะ merge การแก้ที่ทำให้เทสเดิมโกหก
Ruling: มิกซ์บอดี้ต้องอ่าน CredentialStore กลับ ไม่ใช่ดูแค่ 400 + process.env — 400 อย่างเดียวแยกไม่ออกระหว่างปฏิเสธก่อนเขียนกับปฏิเสธหลังเขียน (TL-2). ถ้าผิด: refusal ที่วางหลัง loop จะผ่านเทสทั้งที่เขียน credential ไปแล้ว

## Mutations

| mutation | ผล |
|---|---|
| revert impl (filter เดิม) | 6 failed / 13 |
| ย้าย check ไปหลัง loop, ไม่ re-filter | 6 failed |
| ย้าย check ไปหลัง loop + loop re-filter validKeys | 3 failed — จุดแรกที่แดงคือ `CredentialStore.get` (:157) ไม่ใช่ status |
| v1 route status = 200 เสมอ | 3 failed (v1 เท่านั้น) |
| admin route status = 200 เสมอ | 5 failed (admin เท่านั้น) |
| ยุบ 400 เข้า 500 | 6 failed |
| ตัด cap 50 | 1 failed |
| truncate ด้วย UTF-16 units | 1 failed |
| ส่ง req body ทั้งก้อนเข้า update-password | 1 failed (branch-presence) |
| ถอด system.write gate จาก /system/update-env | 1 failed (manager refusal) |

## หมายเหตุ

`__tests__/jobs/providerDocIdCallSites.test.js` แดง 3 ข้อใน `--findRelatedTests` ครั้งแรก
(beforeAll timeout 5000ms) รันเดี่ยวเขียว 20/20 และรันซ้ำทั้งชุดเขียว — flake ที่ไม่แตะ
updateENV เลย (grep updateENV/update-env = 0) เกี่ยวข้องกับ #97 ที่ PMO เปิดค้างไว้

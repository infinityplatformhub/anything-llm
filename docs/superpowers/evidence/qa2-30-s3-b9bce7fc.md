# QA-2 — #30 slice 3 `b9bce7fc` (ledger f7743372) — PASS

Probe 24/24 · mutation 11/11 caught · ไม่รัน full suite (§7.14) · เขียนโดย PMO จากข้อความ QA-2

## S-25 cardinality
- `vector-count`: org-wide = instance total; bound key = scope ตัวเอง; bound ไป ws ที่ creator ไม่มี grant → 0 (`workspaceIds` = ceiling∩binding จาก `narrowToKeyBinding` ไม่มี check ซ้ำ)
- shape `["vectorCount"]` เท่านั้น ไม่มี `partial`
- cap: >50 throw `CardinalityScopeTooLargeError` → 500; พอดี 50 นับได้ (จับ mutant `>=`)
- `scopedNamespaceCount` refuse ก่อนแตะ store: out-of-scope และ slug ไม่มี → `null`, `namespaceCount` ไม่ถูกเรียก (assert ด้วย flag) — mutant ย้าย store query ขึ้นก่อน scope จับ 2 เทส
- `vector-search` byte-identical 3 states: status + body + content-type + **content-length**; ไม่มี key `message`

## S-22 rehydration
- `fillSourceWindow` ใช้ `isRowAllowed` ตัวเดียวกับ vector row
- revoked/cross-ws/cross-org ไม่กลับ (assert `contextTexts` และ `sources`); pre-1a unlabelled = unprovable ตัด; flag เปิด admit แต่ deny ยังชนะ; `aclFilter` หาย → throw
- ORDERING: `isRowAllowed` ตัวแรกใน filter ก่อน slot loop (`nDocs:2` + denied 1 + readable 2 → ได้ 2) — mutant ย้าย ACL ไปท้าย จับ 6 เทส
- `apiChatHandler` 2 จุด (sync+stream) ส่ง `aclFilter` ทั้งคู่

## Mutation 11/11
ignore scope · cap ตัดแทน throw · off-by-one · scope check หาย · store ก่อน scope · matchNone นับ · `message` กลับ · `isRowAllowed` หาย · ACL หลัง loop · `aclFilter` optional
M6 บทเรียน: `{matchNone:true}` เปล่า ๆ sum ว่าง = 0 อยู่แล้ว ไม่พิสูจน์ early return → ต้องใส่ `workspaceIds:["7","8"]`

## cardinalityHttp hang
root cause `/v1/` แทน `/api/v1/` (§7.15) — ครั้งที่สองที่ trap นี้กินเวลา · 5 รอบบน b9bce7fce ไม่ค้าง

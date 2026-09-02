# QA-2 — #40 task 1 `e875cd1` — **PASS** (lane router / v1) — SHA later withdrawn by Dev2 (bypass 7: spoofable `isApiKeyGuard` property); probe results carry to next SHA

(เนื้อหาส่งโดย QA-2 anything-llm-e6 read-only, PMO commit) · Probe 11/11 · mutation 5/5 · ไม่รัน full suite (§7.14)

## รอบก่อน (3d29de9) FAIL
regex `^[a-zA-Z]+\(apiRouter\);$` match เฉพาะอาร์กิวเมนต์เดียว → `developerEndpoints(app, apiRouter)` ไม่ mount ไม่เข้า skipped

## รอบนี้
regex `^[a-zA-Z]+\((?:app, )?apiRouter\);$` + เรียกด้วย arity ตรง (`register(app, app)`)

## Probe 11/11
A2 ทุกฟังก์ชันที่เรียกด้วย apiRouter ถูก sweep ✓ · A3 ที่พลาดไม่หายเงียบ ✓ · เพิ่ม: single-arity ยังไม่หลุด (systemEndpoints + developerEndpoints, >30) ✓
B1–B3 `/v1/auth`, `/v1/workspaces`, `/v1/documents`, `/v1/openai/models`, `/v1/openai/chat/completions` ✓ · เพิ่ม: /v1 ≥ 60 (วัดได้ 62) ✓
**C0 (ชี้ขาด)** mutating /v1 ≥ 37 ให้ตรวจจริง ✓ · C1 ทุก mutating /v1 มี isApiKeyGuard ✓ · C2 scope ประกาศชัด ไม่ใช่ `"*"` ✓ · C3 GET /v1 ก็มี guard ✓

## Mutation 5/5
| mutant | ผล | จับโดย |
|---|---|---|
| ลบ developerEndpoints จาก index.js | CAUGHT 7 | B1–B3, C0 |
| ถอด validApiKey จาก `/v1/openai/chat/completions` | CAUGHT 1 | C1 |
| ย้อน regex single-arity | CAUGHT 9 | A2 A3 B* C0 |
| helper เรียก `register(app)` กับรูป 2-arg → `if (!router) return;` เงียบ | CAUGHT 6 | B1–B3 เท่านั้น |
| scope `"*"` | CAUGHT 1 | C2 |

## เปิดอยู่ (นอก task 1)
`developerEndpoints` `if (!router) return;` กลืน failure เงียบ — ควร throw

# QA-2 — #40 task 1 `3d29de9` — **FAIL** (lane: router / v1)

(เนื้อหาส่งโดย QA-2 anything-llm-e6 read-only, PMO commit) · SHA ถอนแล้ว ใช้เป็น baseline สำหรับ SHA ถัดไป

Probe 8 เคส: 3 ผ่าน / 5 แดง — รากเดียว. ไม่ยิง mutation เพราะ probe แดงจาก defect จริง

## Finding — `/api/v1` ทั้งชุดมองไม่เห็นโดย sweep และไม่อยู่ใน `skipped`
`server/utils/test/routeGateSweepHelper.js`: `indexSource.match(/^[a-zA-Z]+\(apiRouter\);$/gm)` match เฉพาะอาร์กิวเมนต์เดียว แต่ `server/index.js:119` คือ `developerEndpoints(app, apiRouter);` → ไม่ match → ไม่ mount → **ไม่เข้า loop จึงไม่เข้า `skipped`**
`developerEndpoints` mount ทั้ง `/api/v1`: auth, admin, system, workspace, document, workspaceThread, userManagement, openai-compatible, embed

### วัดจริง
- `paths.filter(p => p.startsWith("/v1/"))` ใน app ที่ sweep สร้าง → `[]`
- `developerEndpoints(app, app)` ตรงๆ → mount ปกติ 62 routes

## ทำไมสำคัญ
`expect(registrations).toHaveLength(31)` และ `skipped` ว่าง **เขียวทั้งคู่** — 31 คือที่ regex เห็น ไม่ใช่ที่มีจริง; "skipped ว่าง" = ทุกตัวที่ regex เห็น mount ได้ ไม่ใช่ mount ครบ · capability sweep + "no mutating route carries validatedRequest alone" เงียบเรื่อง `/v1` — 62 routes พื้นผิว API key ไม่เคยถูกตรวจ ถอด `validApiKey` ออก sweep ยังเขียว

## ทางแก้ (ruling PMO → Dev2)
`index.js` export รายการ registration ตรง (ไม่ใช้ regex) + assert route `/v1/` ≥ 60 และ `/v1/openai/chat/completions` อยู่ใน app + mutating `/v1` ทุกตัวมี `validApiKey` + RED case ลบ developerEndpoints → แดง

## Probe 8 เคส
| # | เคส | ผล |
|---|---|---|
| A1 | regex คือฐานเดียวของ registrations | ผ่าน |
| A2 | ทุกฟังก์ชันที่เรียกด้วย apiRouter ถูก sweep ไม่ว่า arity | **แดง** developerEndpoints |
| A3 | router ที่ regex ไม่เห็นต้องไม่หายเงียบจาก skipped | **แดง** |
| B1 | มี route `/v1/` ใน app | **แดง** `[]` |
| B2 | `/v1/openai/chat/completions` อยู่ใน app | **แดง** |
| B3 | route ตัวแทนจากทุก sub-router `/v1` | **แดง** หายทั้ง 4 |
| C1 | mutating `/v1` ต้องมี api-key guard | ผ่านแบบว่างเปล่า |
| C2 | ทุก `/v1` guard ประกาศ scope | ผ่านแบบว่างเปล่า |
C1/C2 ต้องเปลี่ยนจาก vacuous เป็นมีค่าจริงใน SHA ถัดไป

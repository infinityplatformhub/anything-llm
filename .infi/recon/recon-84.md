# Recon #84 — `POST /system/update-env` เขียน secret ได้ด้วย `settings.write`

ทุกตัวเลข**รันจริง** ไม่ใช่ grep (บทเรียนจาก #78: `grep -c` วัดการสะกด ไม่ใช่พฤติกรรม)

## โค้ดปัจจุบัน

`endpoints/system.js:729-731`
```js
app.post(
  "/system/update-env",
  [validatedRequest, requirePermission("settings.write", orgResource)],
```
handler ส่ง `reqBody(request)` เข้า `updateENV(body, false, userId)` ตรง ๆ ไม่กรองอะไรเลย

## ตัวเลขที่นับจากโมดูลจริง

```
KEY_MAPPING entries: 213
secret: true:        91
non-secret:         122
```

`updateENV` ไม่มี narrowing ตาม actor เลย — grep `system.write|managerAllowed|actor` ได้ 0 บรรทัด
มันรู้จัก `secret` เฉพาะตอน persist (`:1649`), mask ค่าที่ตอบกลับ (`:1688`) และ lookup (`:1886`) — ไม่เคยใช้ตัดสินสิทธิ์

## ทำไมเป็นบั๊ก ไม่ใช่ดีไซน์

`setup_admin` มี `settings.write` แต่ไม่มี `system.write` (query policy store ของ seed สดยืนยันแล้วสองรอบ)
จึงเขียน `OPEN_AI_KEY`, `ANTHROPIC_API_KEY`, `AZURE_OPENAI_KEY` และ credential อีก 88 ตัวได้

**หลักฐานที่แข็งที่สุดว่าเป็นความพลาด: คู่แฝดฝั่ง API key เข้มกว่า**
`scopes.js:77` → `"POST /v1/system/update-env": "system.write"`
ปฏิบัติการเดียวกันเป๊ะ แต่ session surface ขอ `settings.write` ส่วน API-key surface ขอ `system.write`
คนที่เขียน scope table ตอบคำถามเดียวกันแล้วตอบว่า `system.write`

## caller ของ `updateENV` — 4 จุด แก้ที่ route เดียว

| call site | route | guard |
|---|---|---|
| `system.js:735` | `POST /system/update-env` | `settings.write` ← **รูรั่ว** |
| `system.js:~722` | `POST /system/update-password` | `validatedRequest` (single-user path ไม่มี actor) |
| `system.js:~790` | `POST /system/enable-multi-user` | `system.write` (#78 ยกให้แล้ว) |
| `api/system/index.js:147` | `POST /v1/system/update-env` | `validApiKey` + `system.write` scope |

**ห้ามใส่ narrowing ใน `updateENV`** — จะกระทบ caller ที่ไม่ได้เป็นปัญหา และ `update-password` โหมด single-user ไม่มี actor ให้ authorize จะพังทันที

## frontend — ไม่มีหน้าไหนของ manager เรียก route นี้

`System.updateSystem` (`frontend/src/models/system.js:269`) ถูกเรียกจาก 10 หน้า ตรวจ route guard ครบแล้ว:
EmbeddingPreference · TranscriptionPreference · AudioPreference (stt+tts) · ImageGenerationPreference ·
VectorDatabase · LLMPreference · ModelRouters · Admin/Agents · OnboardingFlow
**ทุกหน้าเป็น `AdminRoute`** — ไม่มี `ManagerRoute` สักหน้า แปลว่าการยก gate **ไม่กระทบ UI ของใครเลย** ผู้ใช้ที่เข้าหน้าพวกนี้ได้ถือ role ที่มี `system.write` อยู่แล้ว

## จุดที่จะเปลี่ยน

`system.js:731` บรรทัดเดียว — `requirePermission("settings.write", …)` → ตัดสินตาม ruling
ทางเลือกที่ ruling บอก: **`secret: true` ต้อง `system.write`** (per-key) ไม่ใช่ยกทั้ง route
per-key แม่นกว่าและรักษาความสามารถของ `setup_admin` ในการตั้งค่าที่ไม่ใช่ credential (122 คีย์)

## evidence contract (ร่าง)

**premise guard ก่อนทุก assertion**: actor ต้องมี `settings.write` allowed + `system.write` denied จาก engine จริง
(`setup_admin` เป็น org role เดียวที่เข้าเงื่อนไข — ยืนยันด้วย query seed ของ pr84 เอง)

- RED: `setup_admin` POST `{OpenAiKey:"sk-canary"}` วันนี้ได้ 200 และเขียนจริง → ต้องถูกปฏิเสธ และอ่านกลับว่า `process.env.OPEN_AI_KEY` กับ row ที่เก็บไม่เปลี่ยน
- **positive control**: actor ที่มี `system.write` ส่ง body เดียวกัน ยังสำเร็จและเขียนจริง — ไม่งั้น route ที่ปฏิเสธทุกคนจะผ่านเทส
- **cross-check**: `setup_admin` ส่ง **non-secret** key ยังสำเร็จ — พิสูจน์ว่าการปฏิเสธมาจากความอ่อนไหวของคีย์ ไม่ใช่การล็อกทั้ง route
- secret set **derive จาก `KEY_MAPPING` ตอนรัน** ห้าม enumerate ชื่อ ห้าม assert จำนวน (provider เพิ่มบ่อย และเลข 91 ของ issue เองเคยผิดมาแล้วเพราะนับด้วย grep)
- body ที่ปฏิเสธต้องไม่ enumerate secret key ตัวอื่น
- **เทสต้องยิง runtime จริง ไม่ใช่คำนวณสูตรเดียวกับที่ตรวจ** (§7.9f — drift test ของ #78 แดงไม่ได้เพราะ derive expectation จากแหล่งเดียวกับที่มันตรวจ)

## นอก scope

- `assertDeploymentShape.js` และ path ตอน boot — ไม่มี actor
- `/v1/system/update-env` — เข้มอยู่แล้ว

## ruling ของ PMO (2026-09-02)

Ruling: **(ข) ยกทั้ง route เป็น `system.write`** — บั๊กคือ session surface หลวมกว่า `/v1` (`scopes.js:77`) สำหรับปฏิบัติการเดียวกัน (ข) ปิดตรงนั้นพอดี และไม่มีหน้า manager พึ่งพา route นี้เลย (ตรวจครบ 10 หน้า ทุกหน้า `AdminRoute`)

ถ้าผิดจะเสีย: `setup_admin` หมดความสามารถตั้ง 122 คีย์ non-secret — ซึ่งวันนี้ไม่มี UI ให้ทำอยู่แล้ว **ยอมรับผลนี้โดยตั้งใจ** บันทึกลง residual ว่าถ้าอนาคตต้องการให้ manager ตั้ง provider ได้ ให้เปิด issue per-key ตอนนั้น ไม่ใช่ปล่อยรูไว้เผื่อ

Ruling: เทสต้องมี manager → 403 **ทั้ง secret และ non-secret** (สุ่มอย่างละ 1 ตัว derive จาก `KEY_MAPPING`) · admin → 200 พร้อม control · assert ความสัมพันธ์กับ `scopes.js` ว่า `/v1` ยังเป็น `system.write`

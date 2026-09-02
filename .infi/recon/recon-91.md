# Recon #91 — `updateENV` ทิ้ง key ที่ไม่รู้จักเงียบแล้วตอบสำเร็จ

ทุกตัวเลข**รันจริง** (บทเรียน #78/#84: grep วัดการสะกด ไม่ใช่พฤติกรรม)

## โค้ดปัจจุบัน

`utils/helpers/updateENV.js:1622-1625`
```js
const validKeys = Object.keys(KEY_MAPPING);
const ENV_KEYS = Object.keys(newENVs).filter(
  (key) => validKeys.includes(key) && !/^\*+$/.test(newENVs[key])
);
```
key ที่ไม่อยู่ใน `KEY_MAPPING` หายที่นี่ ไม่มีใครรู้ ไม่มี log

## baseline ที่พิสูจน์เองแล้ว

```
updateENV({not_a_real_env_key:"x"})                       -> {"newValues":{},"error":false}
updateENV({not_a_real_env_key:"x", LLMProvider:"openai"}) -> {"newValues":{"LLMProvider":"openai"},"error":false}
```

สองอาการเดียวกับ #72 หนึ่งชั้นล่าง: (ก) พิมพ์ชื่อผิด → ตอบสำเร็จ ไม่มีอะไรถูกเขียน (ข) body ผสม → เขียนบางส่วน ผู้เรียกไม่มีทางรู้ว่าครึ่งไหนลง

`error` เป็น `""` ตอนเริ่ม (`:1620`) และสะสมเฉพาะจาก validation ของ key ที่**ผ่าน** filter แล้ว (`:1644`, `:1656`) — key ที่ถูกทิ้งไม่เคยแตะตัวแปรนี้เลย

## route ที่กระทบ (2)

| route | ไฟล์ | วันนี้ |
|---|---|---|
| `POST /system/update-env` | `system.js:735` | `response.status(200).json({newValues, error})` — 200 เสมอ |
| `POST /v1/system/update-env` | `api/system/index.js:190` | เหมือนกันเป๊ะ |

ทั้งคู่ตอบ 200 ไม่ว่า `error` จะมีค่าหรือไม่ — นั่นเป็นบั๊กแยกอีกตัวที่ต้องตัดสินว่าจะรวมไหม

## frontend อ่าน `error` จริง

`System.updateSystem` ถูกเรียก 10 หน้า อย่างน้อย 3 หน้าอ่าน `.error` ตรง ๆ:
`AudioPreference/stt.jsx:85`, `EmbeddingPreference/index.jsx:199`, `TranscriptionPreference/index.jsx:62`
แปลว่าถ้าคืน `error` เป็นข้อความ frontend จะแสดงได้ทันทีโดยไม่ต้องแก้ — แต่ต้องตรวจว่าหน้าอื่นที่**ไม่**อ่านจะเงียบต่อไปไหม

## ต่างจาก #72 อย่างไร

#72 แก้ `SystemSettings.updateSettings` (ตาราง `system_settings`) ส่วนนี่คือ `updateENV` (ไฟล์ `.env` + credential store) คนละ storage คนละ validation คนละ shape ของ return (`{newValues, error}` ไม่ใช่ `{success, error, code}`)

`updateENV` มี **4 caller** — สองตัวข้างบน บวก `system.js:776` (`update-password`) และ `:844` (`enable-multi-user`) สองตัวหลังส่ง key ตายตัวที่ตัวเองสร้าง จึงไม่มีทางส่ง unknown key แต่**ต้องยืนยันด้วยเทส ไม่ใช่ด้วยการอ่าน**

## คำถามที่ต้องได้ ruling ก่อนลงมือ

1. **all-or-nothing เหมือน #72 หรือรายงานอย่างเดียว** — #72 เลือก all-or-nothing เพราะ "ครึ่งเดียว" เป็น state ที่ผู้เรียกใช้เหตุผลต่อไม่ได้ เหตุผลเดียวกันใช้ที่นี่ได้ แต่ที่นี่ต้นทุนสูงกว่า: `updateENV` มี `preUpdate`/`postUpdate` hook และเขียนไฟล์จริง การ rollback ไม่ฟรี
2. **shape ของ return** — `{newValues, error}` ไม่มีที่ให้ `code` ถ้าจะ typed ต้องเพิ่มฟิลด์ ซึ่งกระทบ 4 caller และ frontend 10 จุด
3. **status code** — route ตอบ 200 เสมอแม้ `error` มีค่า ถ้าจะให้ unknown key เป็น 400 ต้องแก้ทั้งสอง route และนั่นเปลี่ยน contract ของ `/v1` (breaking เหมือน #72)
4. **`update-password` / `enable-multi-user`** รวมด้วยไหม (คีย์ตายตัว น่าจะไม่ต้อง แต่ต้องมีเทสยืนยัน)

## evidence contract (ร่าง — รอ ruling ข้อ 1-3)

- RED: `{not_a_real_env_key:"x"}` วันนี้ได้ 200 `{"newValues":{},"error":false}` → ต้องเปลี่ยนตาม ruling
- **mixed body คือ RED หลัก** — วันนี้เขียน `LLMProvider` ลงจริง ต้องพิสูจน์ว่าหลังแก้ไม่เขียน (ถ้าเลือก all-or-nothing) โดยอ่าน `process.env` กลับ
- **positive control**: body ที่ถูกต้องล้วนยังสำเร็จและเขียนจริง
- **masked placeholder ยังทำงาน** (`****` ไม่ถือเป็น unknown key ไม่ทับค่าเดิม) — #84 เพิ่งเพิ่มเทสนี้ ต้องไม่พัง
- unknown key set **derive จาก `KEY_MAPPING`** ห้าม enumerate ห้าม assert count (ตารางโตจาก 213→214 ระหว่าง #84 ทำอยู่)
- เทสยิง runtime จริง ห้าม derive expectation จากแหล่งเดียวกับที่ตรวจ (§7.9f)

## ruling ของ PMO (2026-09-02)

Ruling: **all-or-nothing เหมือน #72** และ **ตรวจ unknown key ก่อน `preUpdate`/ก่อนเขียนไฟล์** — ปฏิเสธก่อนแตะอะไรทั้งสิ้น จึงไม่ต้อง rollback ข้อกังวลเรื่องต้นทุน rollback ที่ผมยกมาหายไปเพราะลำดับ ไม่ใช่เพราะยอมรับความเสี่ยง

Ruling: **shape** — เพิ่ม `code`, `unknownKeys`, `unknownKeyCount` (cap 50 คีย์ / 64 code point เหมือน #72) โดย**คง `{newValues, error}` เดิมไว้** `error` ยังเป็น string frontend 3 จุดที่อ่าน `.error` (`stt.jsx:85`, `EmbeddingPreference:199`, `TranscriptionPreference:62`) จึงทำงานต่อโดยไม่ต้องแก้

Ruling: **status** — ทั้งสอง route ตอบ **400** เมื่อ `code === "unknown_keys"` (breaking `/v1` แบบเดียวกับ #72 → ต้องมี swagger note + `updated` บน issue) และ**แก้บั๊กแยก "200 ทั้งที่มี error" → 500** เมื่อ `error` ไม่ใช่ unknown_keys รวมใน #91 เพราะเป็น path เดียวกัน

Ruling: **`update-password` / `enable-multi-user` ไม่แตะ** พิสูจน์ด้วยเทส branch-presence ว่าทั้งคู่ส่ง key ตายตัวที่ตัวเองสร้าง ไม่ใช่ body ของผู้เรียก

## เทสที่ต้องมี

- manager ไม่ถึง path นี้เลย (โดน 403 จาก #84 ก่อน) — ยืนยันว่า #84 ยังทำงาน
- admin + unknown key ล้วน → **400** เขียน 0 ครั้ง
- admin + **mixed body** → **400** และคีย์ที่ถูกต้องต้องไม่ถูกเขียน (RED หลัก: วันนี้ `LLMProvider` ลงจริง)
- admin + body ถูกต้องล้วน → **200** และเขียนจริง (positive control)
- masked placeholder `****` ยังไม่ถือเป็น unknown key และไม่ทับค่าเดิม (#84 เพิ่งเพิ่ม ต้องไม่พัง)
- `error` ที่ไม่ใช่ unknown_keys → **500** ไม่ใช่ 200

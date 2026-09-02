# recon #114 — GET /setup-complete, ไม่มี middleware

## สรุปสั้น
TL-2 pre-read ผิดที่ premise: ไม่ใช่ "ตัด 72 ตัวที่ frontend ไม่อ่าน" — frontend อ่าน
**~200 ฟิลด์** และ **onboarding ต้องการ 128 ฟิลด์ตอนยังไม่มี user** ซึ่งฆ่า pre-user
window แบบ #112 ในฐานะทางแยกที่สะอาด ทุกตัวเลขข้างล่างวัดเอง ไม่ได้อ่านโค้ดแล้วเดา

## field count ขึ้นกับ env — ห้าม hardcode
เครื่อง Dev1 **229** · QA-3 **135** · issue เขียน **92** — ต่างกันเพราะ env ที่ตั้งไว้
เทสต้อง derive จาก allowlist/ผลจริง ไม่ใช่ยืนยันจำนวน

## ทำไม TL-2 นับได้ 19
grep เจอเฉพาะ `settings?.X` ที่อ่านตรง ๆ แต่ **8 หน้าโยนทั้ง object ต่อ**:
```
setSettings(_settings)                              ← ทั้งก้อนเข้า state
  → options: (settings) => <OpenAiOptions settings={settings} />
      → settings?.OpenAiKey / settings?.OpenAiModelPref / settings?.credentialsOnly
```

## mapping หน้า → จำนวนฟิลด์ (วัดโดยไล่ตาม option component ที่แต่ละหน้า mount จริง)

| ฟิลด์ | option components | หน้า | guard |
|---:|---:|---|---|
| 136 | 39 | `GeneralSettings/LLMPreference` | `AdminRoute` (main.jsx:70) |
| **128** | **37** | **`OnboardingFlow/Steps/LLMPreference`** | **ไม่มี** (main.jsx:337) |
| 44 | 14 | `GeneralSettings/EmbeddingPreference` | `AdminRoute` |
| 34 | 5 | `GeneralSettings/ImageGenerationPreference` | `AdminRoute` |
| 22 | 9 | `GeneralSettings/VectorDatabase` | `AdminRoute` |
| 6 | 0 | `Admin/Agents` (spread `{..._settings}`) | `AdminRoute` |
| 1 | 3 | `GeneralSettings/TranscriptionPreference` | `AdminRoute` |
| 0 | 2 | `GeneralSettings/AudioPreference` | `AdminRoute` |

guard ทั้งหมดเป็น client-side เท่านั้น ระดับ HTTP ไม่มีอะไรกันเลย

## สิ่งที่รั่วจริง — วัดด้วยการตั้ง env host จริงแล้ว scan body ทั้งก้อน
ตั้ง 7 ค่า ได้ **6 รั่ว**:
```
AZURE_OPENAI_ENDPOINT       https://internal-azure.corp.local
OLLAMA_BASE_PATH            http://ollama.internal:11434
LMSTUDIO_BASE_PATH          http://lmstudio.internal:1234
EMBEDDING_BASE_PATH         http://embed.internal:8080
STORAGE_DIR                 /Users/…/server/storage
AGENT_SEARXNG_API_URL       http://searxng.internal:8888
```

## credential ถูก booleanise แล้ว endpoint ไม่ถูก
```
OpenAiKey            false      (boolean)   ← ปลอดภัย
AnthropicApiKey      false      (boolean)
LlmmanAuthToken      false      (boolean)
AzureOpenAiEndpoint  undefined  (raw passthrough)  ← ตัวนี้คือปัญหา
OllamaLLMBasePath    undefined  (raw passthrough)
EmbeddingBasePath    undefined  (raw passthrough)
```
ในบรรดา 128 ฟิลด์ที่ onboarding ต้องการ **74 ตัวเป็นชื่อทรงเครดิเชียล/endpoint** แต่ครึ่งหนึ่ง
เป็น boolean แล้ว ตัวที่เหลือคือ `*BasePath` / `*Endpoint` / `*Url` / `ConnectionString`
/ `ProjectId` / `Region` / `*TokenLimit` — ค่าดิบทั้งหมด

## ผลต่อทางเลือก
onboarding ต้องการ 128 ฟิลด์ก่อนมี user ดังนั้น "pre-user คืนเต็ม + post-user คืน 6"
แบบ #112 จะไม่ทำให้หน้าต่างการรั่วแคบลงในกรณีที่คนโจมตีสนใจจริง: instance ที่ยัง
onboard ไม่เสร็จก็คืนครบ 229 ให้ทุกคนอยู่ดี

ทางที่ยังเหลือ (ยังไม่มี ruling):
- **แยกตามชนิดค่า ไม่ใช่ตามชื่อฟิลด์**: booleanise ทุกฟิลด์ทรง endpoint/path/URL
  ตอน unauth (`!!value`) เหมือนที่ credential ทำอยู่แล้ว — onboarding ยังเห็นว่า
  "ตั้งค่าไว้แล้วหรือยัง" ซึ่งเป็นสิ่งเดียวที่ UI ใช้จริงกับฟิลด์พวกนี้ (ต้องยืนยันทีละตัว)
- pre-user window แบบ #112 — แคบลงน้อยกว่าที่คิด ด้วยเหตุผลข้างบน
- ตัด `StorageDir` ตัวเดียวออกทันที (ไม่มีหน้าไหนอ่าน — ยืนยันแล้ว) เป็น quick win

## ยังไม่ได้ทำ
ยืนยันทีละตัวว่า option component อ่าน `*BasePath` ไปทำอะไร (แสดงค่าเดิมในช่อง input
หรือแค่เช็คว่ามีค่า) — ถ้าเป็นอย่างแรก การ booleanise จะทำให้ค่าเดิมหายจากฟอร์ม
ต้องดูก่อนตัดสิน

# Recon #78 — manager write to a forbidden setting answers 200 and writes nothing

ทุกตัวเลขในเอกสารนี้ **รันจริง** ไม่ได้อ่านโค้ดสรุป

## โค้ดปัจจุบัน

`endpoints/admin.js:589-604` — `POST /admin/system-preferences` ถาม engine ว่า actor ได้ `system.write` ไหม
ถ้าไม่ได้ สร้าง object ใหม่จาก `managerAllowedFields` 5 คีย์ แล้วส่งอันนั้นเข้า model
คีย์อื่น — ทั้งที่รู้จักและไม่รู้จัก — หายไปที่นี่ ไม่ถึง `updateSettings` เลย แล้ว route ตอบเหมือนเขียนสำเร็จ

**มี `managerAllowedFields` สองชุดในไฟล์เดียวกัน** `:465` (ฝั่งอ่าน `/admin/system-preferences-for`) และ `:594` (ฝั่งเขียน)
เนื้อเหมือนกันเป๊ะวันนี้ แต่เป็นคนละ literal — แก้ที่หนึ่งไม่กระทบอีกที่ นี่คือ drift ที่รอเกิด

## เซ็ตที่กระทบ — นับจริงจาก model

```
supportedFields 28 − managerAllowed 5 = forbidden 23
```

```
logo_filename, telemetry_id, text_splitter_chunk_size, text_splitter_chunk_overlap,
agent_search_provider, default_agent_skills, disabled_agent_skills,
disabled_filesystem_skills, disabled_create_files_skills, disabled_gmail_skills,
gmail_agent_config, disabled_google_calendar_skills, google_calendar_agent_config,
disabled_outlook_skills, outlook_agent_config, agent_sql_connections,
agent_clarifying_questions_enabled, agent_clarifying_questions_max_per_turn,
default_system_prompt, experimental_live_file_sync, hub_api_key,
memory_enabled, memory_auto_extraction
```

## เหตุผลของ issue — แก้พรีมิสเดิม

พรีมิสแรกที่ผมเขียนใน #78 ("manager เห็นคีย์พวกนี้ใน UI อยู่แล้ว") **ผิด** ไล่ call site ครบ 9 จุดพร้อม route guard แล้ว
ไม่มีคีย์นอกลิสต์ตัวไหนที่ manager เปิดหน้า UI ถึง — ทุกหน้าที่เขียนคีย์เหล่านั้นเป็น `AdminRoute` หรือถูกกันด้วย `user.role === "admin"`

พรีมิสที่สอง ("ชื่อคีย์อ่อนไหวพอที่จะปิด") **ก็ผิด** — `supportedFields` เป็น literal array ใน repo open-source
เหมือนกันทุก build ใครก็อ่านบน GitHub ได้ ไม่ใช่ข้อมูลของ instance จึงไม่มี oracle ให้ปกป้อง

**เหตุผลจริงคือ: การเขียนที่ถูกปฏิเสธต้องไม่ตอบสำเร็จ** ไม่ขึ้นกับว่าผู้เรียกจะรู้ชื่อคีย์ได้หรือไม่
เป็นบั๊กคลาสเดียวกับ #70 และ #72 ที่ขยับขึ้นมาอีกชั้น

## เคสที่ #78 เปลี่ยนพฤติกรรมจริงวันนี้

`memory_enabled` และ `memory_auto_extraction` ถูกกันด้วย **React context อย่างเดียว**
(`MemoriesContext.jsx:25` — `canToggle = !user || user?.role === "admin"`) client-side check ไม่ใช่ permission
คีย์ที่เหลืออีก 21 ตัวอยู่หลัง `AdminRoute` ซึ่งเป็นการกันฝั่ง client เหมือนกัน แต่สองตัวนี้เป็นตัวที่ยิงถึงได้ง่ายที่สุด

## จุดที่จะเปลี่ยน

1. `admin.js:589-604` — เช็ค forbidden **ก่อน** เรียก `updateSettings` (อำนาจก่อน vocabulary)
2. คืน `403` `code:"forbidden_keys"` + **เฉพาะคีย์ที่ผู้เรียกส่งมา** ห้ามสะท้อน `managerAllowedFields` ทั้งชุด
3. `managerAllowedFields` สองชุด (`:465`, `:594`) — ยกเป็นค่าเดียวที่แชร์กัน

## ตารางคำตอบหลังแก้

| key | actor มี `system.write` | manager |
|---|---|---|
| ไม่อยู่ใน `supportedFields` | 400 `unknown_keys` (#72) | **200 เงียบ** (#72 จงใจ กัน oracle) |
| อยู่ใน `supportedFields` ไม่ manager-allowed | เขียน (หรือ 400 `protected_keys`) | **403 `forbidden_keys`** |
| manager-allowed | เขียน | เขียน |

`hub_api_key` เป็นทั้ง forbidden (#78) และ protected (#72): manager → 403 · admin → 400 `protected_keys`
mixed body `{unknown, forbidden}` จาก manager → **403** (อำนาจตัดสินก่อน) · จาก admin → 400 `unknown_keys`

## evidence contract (ร่าง)

**premise guard ก่อนทุก assertion** — fixture actor ต้องมี `settings.write` **allowed** และ `system.write` **denied**
จาก grant จริง ไม่ใช่ `users.role` string เพราะนั่นคือเงื่อนไขที่ `admin.js:590` แตกกิ่งจริง
query seed แล้วพบว่า **`setup_admin` เป็น org role เดียวที่เข้าเงื่อนไข**:
```
super_admin {"settings.write":"allow","system.write":"allow"}
setup_admin {"settings.write":"allow"}
```

- RED: manager ส่ง `{memory_enabled:"true"}` วันนี้ได้ 200 และเขียน 0 แถว → ต้องเป็น 403 `forbidden_keys` และอ่าน row กลับมายืนยันว่าไม่เปลี่ยน
- **positive control**: manager ส่ง `{support_email}` ยังได้ 200 **และ row ถูกเขียนจริง** ไม่งั้น route ที่ปฏิเสธ manager ทุกคนจะผ่านเทส
- **cross-check**: actor ที่มี `system.write` ส่ง body เดียวกันยังสำเร็จ — พิสูจน์ว่าการปฏิเสธมาจาก **actor** ไม่ใช่จาก key
- body ระบุเฉพาะคีย์ที่ส่งมา — ส่ง 1 คีย์ต้องไม่เห็นอีก 22 หรือ allow-list
- drift: `managerAllowedFields` ทั้งสองชุดต้องเท่ากัน (derive จากตัวแปรเดียวหลังยกออกมา ไม่ hardcode ชื่อ)

## นอก scope (จดไว้ ไม่แก้ที่นี่)

- `default_system_prompt` เขียนผ่าน `/system/default-system-prompt` คนละ route มี guard ของตัวเอง
- `logo_filename`, `telemetry_id` อยู่ใน `supportedFields` แต่ไม่มี caller ไหนส่งผ่าน route นี้
- คำถามว่า non-admin เขียน `memory_enabled` ผ่านทางอื่นได้ไหม เป็นคนละใบ (client-side gate ไม่ใช่ permission)

## ruling ของ PMO (2026-09-02)

Ruling: **`managerAllowedFields` ยกเป็น module-level const ตัวเดียว** ใช้ทั้งฝั่งอ่าน (`admin.js:465`) และฝั่งเขียน (`:594`) วันนี้เป็นคนละ literal ที่บังเอิญเหมือนกัน — แก้ที่หนึ่งไม่กระทบอีกที่ ถ้าผิดจะเสียตรงที่ manager อ่านคีย์ที่เขียนไม่ได้ หรือเขียนคีย์ที่อ่านไม่ได้ โดยไม่มีใครรู้

Ruling: **drift test derive จากตัวแปรนั้น ห้าม copy literal ลงเทส** และต้องพิสูจน์ด้วย RED ก่อน: เพิ่มคีย์เข้าไปใน literal ตัวเดียวแล้วเทสต้องแดง — **ถ้าไม่แดงแปลว่ายังมีสองชุดอยู่** นี่คือ mutation ที่ตรวจว่าการยกค่าออกมาสำเร็จจริง ไม่ใช่แค่ดูโค้ดแล้วเชื่อ

Ruling: option 3 — คีย์ใน `supportedFields` นอก `managerAllowedFields` ทั้ง 23 ตัว → 403 `forbidden_keys`
Ruling: manager check ทำ **ก่อน** `updateSettings` (อำนาจก่อน vocabulary)
Ruling: บอดี้ระบุเฉพาะคีย์ที่ผู้เรียกส่งมา ห้ามสะท้อน allow-list
Ruling: `hub_api_key` — manager 403 `forbidden_keys` · admin 400 `protected_keys`
Ruling: premise guard ใช้ `setup_admin` จาก grant จริง ไม่ใช่ role string

# #126 — renderable capability gates (slice 1: Home)

Ruling (PMO): แบ่งสองสไลซ์ · `SettingsSidebar` มี Dev1 ทำ #121 อยู่ · กฎ "สองคนในไฟล์เดียว = คนหนึ่งรอ" **ไม่มีข้อยกเว้นแม้คนละบรรทัด** — conflict ใน `adminRoute.test.jsx` รอบ task 4 ตัด assertion ของคนอื่นขาดกลางนิพจน์ ถ้า resolve ไม่ระวังจะหายเงียบโดยไฟล์ยัง compile ผ่าน — ถ้าผิด: assertion ของคนอื่นหายไปพร้อม merge ที่ดูสำเร็จ

Ruling: ดราฟต์แรกของผม **ผิด** — ผมเรียก `WorkspaceGate` แล้ว**เขียนเงื่อนไขเดิมซ้ำ**ไว้ข้างนอกด้วย · gate จึงไม่ได้ตัดสินอะไรเลยทั้งที่ดูเหมือนตัดสิน และสองสำเนาจะ drift ออกจากกัน · ดราฟต์ที่สองเปลี่ยนเป็น predicate `deadEndShown()` ซึ่ง**ก็ยังผิด** เพราะ #126 ขอ **render test** (RF-1/RF-2) predicate ทดสอบได้แต่ไม่ใช่การเรนเดอร์ · ตัวจริงคือ component ที่ห่อ children แล้วคืน `fallback` — Home เรียกผ่าน `gate(...)` ทั้งสอง return path — ถ้าผิด: "แตก component" ที่ไม่ได้เปลี่ยนอะไรนอกจากเพิ่มไฟล์

Ruling (RF-3) — **ผมตัดสินผิด QA-3 จับได้**: ผมลบ drift check ของ `Home` โดยอ้างว่า render test ครอบแทนได้ · **ไม่จริง** — "render test ครอบ component" กับ "render test ครอบ call site" เป็นคนละคำอ้าง และจริงแค่ข้อแรก · **ไม่มีเทสไหน import `pages/Main/Home` เลย** เพราะ mount แล้วลากทั้ง chat surface มา ซึ่งเป็นเหตุผลที่แยก component ตั้งแต่แรก · QA-3 พิสูจน์ด้วยการทำให้ `WorkspaceGate` เป็น **dead code** แล้ว **93 เทสยังเขียว** · ผมรันซ้ำเองยืนยันแล้ว · assertion เดิมบน `2286a997e^` จับ N1/N6 ได้ ผมลบเกราะที่ใช้งานได้ทิ้งด้วยเหตุผลที่ฟังดูดี — ถ้าผิด: gate ที่ไม่มีใครเรียกแต่เทสรายงานว่าครอบครบ

Ruling: คืน call-site guard เป็น source assertion (strip `//` ก่อน match ตาม §7.17) ถือ 4 คำอ้างที่ render test **เอื้อมไม่ถึงโดยโครงสร้าง** ไม่ใช่เพราะขี้เกียจ: (N6) Home เรียก gate จริง · (N4) `return` ทั้งสองผ่าน `gate(` · (N1) ไม่มีสำเนาที่สองของเงื่อนไข · (action) `can("workspace.create")` สตริงตรง ซึ่งปิด nit ของ TL-1 ใน slice 1 เลยไม่ต้องรอ slice 2 · **บทเรียน: source assertion ไม่ใช่ของแย่กว่า render test มันตอบคนละคำถาม** — ตัวหนึ่งถามว่า "ตัดสินถูกไหม" อีกตัวถามว่า "มีใครเรียกไหม" · ลบตัวหลังเพราะมีตัวแรกคือความเข้าใจผิดว่าทั้งสองถามเรื่องเดียวกัน

mutation รอบ QA-3 (baseline 10/10): N6 gate ไม่ถูกเรียก → **แดง 1** · N4 ห่อ path เดียว → **แดง 1** · N1 เขียนเงื่อนไขซ้ำ → **แดง 1** · action string ผิด → **แดง 1** · ทั้งสี่แดงคนละเทส

Ruling: เทส loading ต้อง assert **การเปลี่ยนสถานะ** ผ่าน `rerender` ไม่ใช่แค่สถานะเดียว — `loading` กับ `denied` เรนเดอร์เหมือนกันเป๊ะ · ถ้า assert แค่ตอน loading เทสผ่านแม้ gate จะไม่เคยแยกสองอย่างนี้เลย

mutation (baseline 6/6, render ล้วน ไม่มี source assertion):
| mutation | แดง |
|---|---|
| RF-2 คืน role string | 2 |
| RF-5 ตัด `!workspace` | 2 |
| ตัด disjunct single-user | 1 |
| ไม่เช็ค `loading` | 1 |

Residual: สไลซ์ 2 (`SettingsSidebar` → `PrivacyLinkGate`) รอ #121 merge · site อื่นของ task 4 ยังใช้ transcribe+drift อยู่ (นอก scope #126 ตามที่ issue ระบุ)

Ruling (TL-1 nit — known limit ของการแยก component): `canCreate={can("workspace.create")}` ประเมิน**ที่ caller** สตริง action จึงอยู่นอก component ที่ถูกเทส · ผมรันยืนยัน: เปลี่ยนเป็น `can("workspace.write")` → **เขียว 6/6** เทสไม่จับเลย · นี่คือ**ราคาที่จ่ายเพื่อให้ gate render ได้โดยไม่ต้อง mount ทั้งหน้าจอ** ไม่ใช่บั๊กที่ลืม — gate ที่รับ decision เป็น prop ย่อมไม่รู้ว่า prop นั้นมาจากคำถามไหน · slice 2 ต้องมี **caller-side fixture** ที่ครอบสตริง action ด้วย (ระบุใน contract slice 2) — ถ้าผิด: แยก component แล้วเชื่อว่าครอบครบ ทั้งที่ครึ่งหนึ่งของการตัดสิน (ถามด้วย action อะไร) ไม่มีใครตรวจ

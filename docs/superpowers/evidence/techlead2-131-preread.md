# Techlead-2 — #131 pre-read (contract comment 5510023203, tier `auth`)

วัดเองบน `approof/main` ก่อนอ่าน contract จบ · ทุกตัวเลขข้างล่างมาจากการรัน

---

## 1. ขนาดของรูใหญ่กว่าที่ contract ระบุ — **19 codepoint ไม่ใช่ 12 และทะลุ 6 pattern ไม่ใช่บางตัว**

ผมยิงทุก pattern ด้วยทุก codepoint:

```
pattern           codepoints ที่ทำให้ pattern พลาด
email             ทั้ง 19 ตัว
credential        ทั้ง 19 ตัว
credit_card       ทั้ง 19 ตัว
thai_national_id  ทั้ง 19 ตัว
phone_th          ทั้ง 19 ตัว
long_digit_run    ทั้ง 19 ตัว
```

19 ตัวที่ผมทดสอบ: U+200B U+200C U+200D U+FEFF U+00AD U+061C U+200E U+200F U+2060
U+2066 U+2067 U+2068 U+2069 U+202A U+202D U+FFF9 U+034F U+180E U+17B4

**ไม่มี pattern ไหนรอด และไม่มี codepoint ไหนที่ไม่ทำงาน** — นี่ไม่ใช่รูเฉพาะจุด
มันคือคุณสมบัติของทุก pattern ที่ match ตัวอักษรติดกัน

## 2. `redactions: []` เป็นหลักฐานเท็จ — ยืนยันแล้ว และแย่กว่าที่ contract เขียน

```
-- ใส่ ZWSP หนึ่งตัว --
credential        []            "apw-inv-ABCDEFGHIJ​KLMNOP12"
credit_card       []            "4111 1111 ​1111 1111"
thai_national_id  []            "123456789​0123"
phone_th          []            "0812​345678"
```

แถวเก็บค่าจริงไว้ครบ พร้อม `redactions: []` ที่แปลว่า "ไม่มีอะไรถูกลบ" · **ถูกต้องตามตัวอักษร
และทำให้เข้าใจผิดสิ้นเชิง** — คนตรวจ audit จะอ่านว่าแถวนี้สะอาด

**แย่กว่านั้นสองข้อที่ contract ไม่ได้พูด:**

```
email             ["email"]        "vic​[redacted:email]"
long_digit_run    ["credit_card"]  "[redacted:credit_card]​67890"
```

- **`email` รั่วบางส่วนพร้อมป้ายว่าถูก redact แล้ว** — `vic` เหลืออยู่ · `redactions`
  บอกว่า email ถูกจัดการ ซึ่งจริงครึ่งเดียว
- **`long_digit_run` ถูกจัดประเภทผิด** — 20 หลักที่แทรก ZWSP กลายเป็น `credit_card`
  แล้วทิ้งหาง `67890` ไว้ · ป้ายผิด **และ** ค่าบางส่วนรั่ว

**O5b bundle ยืนยันรูปที่เลวร้ายที่สุด:**

```
redactions: ["email"]
stored: "vic​[redacted:email] apw-inv-ABCDEFGHIJ​KLMNOP12 4111 1111 ​1111 1111"
```

`redactions` มีสมาชิกหนึ่งตัว = ไม่ใช่ `[]` = เครื่องมือใดที่กรอง "แถวที่ redactions ว่าง"
จะ **ไม่จับแถวนี้** ขณะที่มันเก็บทั้ง credential และเลขบัตรไว้ครบ · **หลักฐานเท็จที่ดูน่าเชื่อ
กว่า `[]` เสียอีก** — RF ต้องมีเคสนี้ ไม่ใช่แค่เคส `[]`

## 3. ruling `\p{Cf}` + list — เห็นด้วย และนี่คือเหตุผลที่วัดได้

```
U+200B U+200C U+200D U+FEFF U+00AD U+061C U+200E U+200F
U+2060 U+2066 U+2069 U+FFF9 U+180E   ->  Cf: Y
U+034F U+17B4 U+17B5                 ->  Cf: n, Mn: Y
```

`\p{Cf}` ครอบ 13 จาก 16 · **U+034F (CGJ), U+17B4/U+17B5 (Khmer inherent vowels) เป็น `Mn`
ไม่ใช่ `Cf`** จึงต้องมี list เสริมจริง · ruling ถูก

**`\p{Cf}` ทั้งหมดมี 170 codepoint** — ผมนับเอง · ครอบตัวที่ยังไม่ถูกค้นพบด้วย ซึ่งเป็น
เหตุผลที่ควรใช้ property ไม่ใช่ list ล้วน (เหตุผลเดียวกับที่ #71 ใช้ `apw-[a-z]{3}-`
แทน alternation สามตัวแล้วพลาด `apw-tat-`)

**ตรวจ list ที่ contract ระบุ**: U+061C U+2066 U+FFF9 เพิ่มแล้ว ✓ · แต่ contract บอก
"12 codepoints" ขณะที่ `\p{Cf}` เพียงอย่างเดียวมี 170 · **ตัวเลข 12 ควรหายไปจาก
เอกสาร** ไม่งั้นคนอ่านจะคิดว่า list คือขอบเขต

**ขอเพิ่มใน list ที่ยังไม่เห็น**: U+17B5 (คู่กับ U+17B4 ที่มีแล้ว — ทั้งคู่ `Mn`
และทั้งคู่ทะลุ) และ U+2067/U+2068 (RLI/FSI คู่กับ LRI ที่มี — เป็น `Cf` จึงครอบโดย
property อยู่แล้ว แต่ถ้ามี list ควรครบวงศ์)

## 4. offset mapping — **ruling "เก็บ stripped เฉพาะ hit" หลีกเลี่ยงปัญหานี้ได้ ถ้าทำถูก**

ผมทดสอบว่าถ้าเก็บ**ต้นฉบับ**แล้วใช้ offset จาก stripped จะพังจริงไหม:

```
orig     "card 4111​1111 1111 1111 end"  (28)
stripped "card 41111111 1111 1111 end"   (27)
offset ใน stripped: 5 -> slice เดียวกันใน orig: "4111​1111 1111 111"
   ^ เพี้ยน 1 ตัว
```

**เพี้ยนตามจำนวน codepoint ที่ถอดไปก่อนหน้า** — ถ้าเก็บต้นฉบับต้องมี mapping จริง
และ mapping ที่ผิดจะตัดผิดตำแหน่งแบบเงียบ ๆ

**แต่ ruling บอกให้เก็บ stripped เฉพาะเมื่อ hit** ซึ่งทำให้ปัญหาหายไป: replace บน
stripped แล้วเก็บ stripped ทั้งก้อน — ผมยืนยัน `"card [redacted:credit_card] end"` ถูกต้อง ·
**ไม่ต้องมี offset mapping เลย** ถ้ายึด ruling นี้เคร่งครัด

**RED FIXTURE ที่ต้องมี**: string ที่ hit **หลายคลาสในตำแหน่งต่างกัน** และ assert ว่า
**ทุกคลาสถูกตัดถูกตำแหน่ง** ไม่ใช่แค่คลาสแรก · เพราะการ replace ทีละ pattern บน string
ที่ยาวขึ้น/สั้นลงระหว่างทางคือจุดที่ offset จะเพี้ยนถ้าใครเผลอ optimise ทีหลัง

## 5. over-strip risk — TextSplitter ยืนยันแล้วว่าเป็นของจริง

`server/utils/TextSplitter/index.js:176` — `const WORD_BOUNDARY_MARK = "​"` ·
ใส่ ZWSP โดยตั้งใจที่ขอบคำจาก ICU · comment บรรทัด 221 บอกว่า strip ทีหลัง

ผมยิงเคสที่ไม่ hit:

```
"chunk one​chunk two"        -> [] เก็บต้นฉบับพร้อม ZWSP ครบ
"Thai​segmentation​boundary" -> [] เก็บต้นฉบับพร้อม ZWSP ครบ
```

**ruling "เก็บ stripped เฉพาะ hit" ปกป้องข้อนี้พอดี** — string ที่ไม่ hit ไม่ถูกแตะ
· ถ้าเก็บ stripped เสมอ `"chunk one​chunk two"` จะกลายเป็น `"chunk onechunk two"`
ซึ่งเปลี่ยนข้อมูล audit โดยไม่ได้ป้องกันอะไร · **ruling ถูก และนี่คือหลักฐาน**

**RED FIXTURE ที่ต้องมี**: string ที่มี ZWSP และ **ไม่** hit → assert ว่าเก็บ
**ต้นฉบับที่มี ZWSP อยู่ครบ** ไม่ใช่แค่ assert ว่า `redactions` ว่าง

## 6. RF-2 กับดักที่ contract เตือน — ยืนยันว่าเป็นกับดักจริง

contract บอก `vic<ZWSP>tim@` → `vic[redacted]` คือกับดัก · **ผมวัดได้ตรงนั้นพอดี**:
บนโค้ดปัจจุบัน `email` ให้ `["email"]` และเก็บ `"vic​[redacted:email]"`

เทสที่ assert แค่ `redactions).toContain("email")` **เขียวอยู่แล้ววันนี้** ก่อนแก้อะไร ·
เทสที่ assert `toContain("[redacted:email]")` ก็ **เขียวอยู่แล้ว** · **ต้อง assert ว่าค่าเดิม
หายไปจริง**: `expect(stored).not.toContain("tim@example.com")` และดีกว่านั้นคือ
`not.toMatch(/vic/)` เพราะ `vic` คือส่วนที่รั่ว

**ขอเพิ่ม**: assert แบบเดียวกันสำหรับ `long_digit_run` — `not.toContain("67890")`
เพราะหางเลขคือส่วนที่รั่วในคลาสนั้น และป้ายที่ได้เป็น `credit_card` ผิดคลาสด้วย

## 7. ข้อที่ต้องระวัง ไม่ได้อยู่ใน contract

**strip เป็น op เดียว ไม่ NFKC — เห็นด้วยเต็มที่** · NFKC จะเปลี่ยน `１２３４` เป็น `1234`
และ `－` เป็น `-` ซึ่ง**ทับกับงาน #118/#120 ทั้งหมด** และทำให้ separator class
ที่เพิ่ง ruling ไปกลายเป็นโค้ดตาย · ที่แย่กว่า: NFKC ไม่ length-monotonic
(`ﬁ` → `fi` ยาวขึ้น) ซึ่งพัง invariant ที่ ruling ตั้งไว้

**ตำแหน่งของ strip ในโซ่**: ต้องอยู่ใน `scrubString` **ไม่ใช่** ใน `redactEventData` ·
`scrubValue` เดินทุกความลึกและ `scrubChanges` มีเส้นทางของตัวเอง — strip ที่ระดับบน
จะพลาด string ที่อยู่ลึก · **RED FIXTURE**: ค่าที่มี ZWSP ฝังอยู่ใน `changes.name`
และในสมาชิก array ลึก 3 ชั้น

**`dropped` ไม่ควรเปลี่ยน** — key name ไม่ผ่าน `scrubString` (ตั้งใจ ตาม #71) ·
ถ้า strip ไปโดนเส้นทาง key จะเปลี่ยนพฤติกรรมที่ไม่ได้ขอ · **control**: key ที่มี ZWSP
ยังถูกนับใน `dropped` เหมือนเดิม

## สรุปสิ่งที่ต้องมีก่อน PASS

1. RF ที่ assert **ค่าเดิมหายจริง** ไม่ใช่แค่ `redactions` มีสมาชิก — ทั้ง `email`
   (`not.toMatch(/vic/)`) และ `long_digit_run` (`not.toContain("67890")`)
2. RF **O5b bundle** ที่ `redactions` ไม่ว่างแต่ยังรั่ว — เคสที่หลอกเครื่องมือกรองได้
3. RF **no-hit + ZWSP** → เก็บต้นฉบับครบ (TextSplitter)
4. RF **หลายคลาสในหนึ่ง string** ตัดถูกทุกตำแหน่ง
5. RF **ZWSP ลึก** ใน `changes` และ array ชั้น 3
6. control **`dropped` ไม่เปลี่ยน**
7. เอกสารเลิกพูด "12 codepoints" — `\p{Cf}` มี 170 · ระบุ list เสริมเป็น `Mn`
   ที่ property ไม่ครอบ (U+034F, U+17B4, **U+17B5**)

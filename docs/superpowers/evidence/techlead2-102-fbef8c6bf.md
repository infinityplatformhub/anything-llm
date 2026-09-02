# Techlead-2 — #102 O5a-wire `fbef8c6bf`: **PASS** (พร้อม 1 ช่องว่างในเทสที่ควรปิด)

worktree `/tmp/tl2-102` (detached `fbef8c6bf`) + `/tmp/tl2-102base` (`750d438f0`) donor
`node_modules` = `/tmp/qa2-84b`, DB `t102` ของผมเองบน `:55472`

```
git worktree add --detach /tmp/tl2-102 fbef8c6bf
cp -al /tmp/qa2-84b/server/node_modules /tmp/tl2-102/server/node_modules
cd /tmp/tl2-102/server && npx prisma generate
DATABASE_URL=".../t102" npx prisma migrate deploy
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" STORAGE_DIR=/tmp/tl2-102-store \
       SIG_KEY=<hex32> SIG_SALT=b API_KEY_PEPPER=<32+> JWT_SECRET=<12+> \
       DATABASE_URL="postgresql://postgres:pw@127.0.0.1:55472/t102"
npx jest __tests__/utils/metrics/providerLabel.test.js \
         __tests__/utils/metrics/wiring.test.js \
         __tests__/endpoints/metrics.test.js --runInBand
```

**baseline: 3/3 suites, 93/93 tests, 0 failed** — วัดซ้ำหลัง mutation ครบ ยัง 93/93

---

## (ก) finding ทั้ง 5 ข้อจาก pre-read — ตรวจว่าตอบครบไหม

| # | สิ่งที่ผมยกไว้ | ผลตรวจ |
|---|---|---|
| **F-1** | drift test ต้อง scan **สองตัว** ไม่ใช่แค่ `getLLMProvider` (`voyageai` เป็น embedding-only และไม่อยู่ใน allowlist) | **ตอบครบ** — เทส scan ทั้ง `resolveLLMProviderInstance` และ `resolveEmbeddingEngineInstance` แยกกัน มี `it.each` สองชุด |
| **F-2** | ค่าที่ไม่อยู่ใน list ทั้งสอง (operator พิมพ์ผิด) ต้อง → `other` ไม่ throw | **ตอบครบ** — `maps absent and empty values to other rather than throwing` ครอบ `undefined/null/""/"   "` และ `some-provider-invented-tomorrow` |
| **F-3** | `/request-token` มี **9 branch ไม่ใช่ 4** | **ตอบเกินที่ขอ** — ไม่ได้ wire ทีละ branch แต่ใช้ `response.on("finish")` อ่านจาก `statusCode` คอมเมนต์นับได้ 10 จุด (ผมนับ 9; ต่างกันเพราะ success path มีสองทางที่ 200 — ทั้งคู่ถูก) วิธีนี้**ดีกว่า**ที่ผมเสนอ เพราะ branch ที่เพิ่มทีหลังถูกนับอัตโนมัติ ไม่ต้องพึ่งความจำของคนเขียน |
| **F-4** | ห้ามมี label `reason`/`branch` — จะเป็น user-enumeration oracle ผ่าน `/metrics` ที่อ่านได้โดยไม่ต้อง auth | **ตอบครบ และมีเทสชื่อผมอยู่ในนั้น** — `describe("no label may name why a request failed (TL-2 F-4)")` ตรวจ 6 คำต้องห้าม + `toEqual(["provider","outcome"])` + เทสที่เรียก `observe` ด้วย `reason` แล้วต้อง throw |
| **F-5** | `observe()` ไม่รับจำนวน → นับด้วย `.length` จะได้ 1 ไม่ใช่ N; เทสต้องอ่าน counter จริง | **ตอบครบ** — นับใน loop ข้าง `push` ทั้งสองที่ และเทส `counts documents inside the loop, not once from a length` assert `not.toMatch(/documents_total[^)]*length/)` |

**สิ่งที่ Dev5 เจอเองและผมไม่ได้เจอ** (บันทึกไว้เพราะสำคัญกว่าที่ผมยกไป):

- **11 completion call site ใน 5 ไฟล์ ไม่มี base class ร่วม** — recon สมมติว่า "the chat path"
  เป็นที่เดียว มันไม่ใช่ การ wrap ที่ factory แทนที่จะไล่ wire 11 จุด คือคำตอบที่ถูก
  เพราะจุดที่ 12 ที่เพิ่มทีหลังจะถูกนับเอง ไม่ใช่ถูกลืม
- **branch ที่ไม่เข้า array ไหนเลย** (`models/documents.js` — vector write สำเร็จแต่ row ไม่สำเร็จ)
  เอกสารนั้นไม่ใช่ทั้ง `embedded` และ `failedToEmbed` ถ้า wire จาก array สองตัวตามที่ recon
  บอก batch 3 จะรายงาน 2 outcome และตัวที่หายจะดูเหมือน "batch เล็กกว่า" ไม่ใช่ "บางส่วนล้มเหลว"
  — นี่คือ F-5 ในรูปแบบที่ลึกกว่าที่ผมเห็น
- **`getEmbeddingEngineSelection` default arm คืน NativeEmbedder** ดังนั้น label ที่ซื่อสัตย์คือ
  `native` ไม่ใช่ชื่อที่ operator พิมพ์ผิด — "what actually ran, not what was configured"
  ถ้าใช้ `providerLabel(declared)` ตรง ๆ จะรายงานว่า provider หนึ่งคำนวณ embedding ที่มันไม่เคยเห็น

## (ข) inventory diff

`750d438f0` **315** → `fbef8c6bf` **315** · **IDENTICAL** — ไม่มี route ใหม่ ถูกต้อง
(`/metrics` มีอยู่แล้วจาก #90) ยืนยันว่า issue นี้ไม่ได้แอบเพิ่มพื้นผิว

## (ค) mutation

| # | mutation | ผล |
|---|---|---|
| **W1** | `providerLabel` passthrough (`?? key`) | **46 failed** — drift test ทั้งชุดแดง |
| **W3** | `providerLabel` คืน `other` เสมอ | **2 failed** (`case- and whitespace-insensitive`, `labels embeddings from EMBEDDING_ENGINE`) |
| **W4** | call site ส่ง `workspace: workspace.slug` | **93/93 เขียว** ⚠ — ดู §ง |
| **W5** | เพิ่ม `reason` เข้า vocabulary + ค่า 4 ตัว | **1 failed** (`declares no reason or branch label`) |
| **W6** | `chats_total` นับ **ก่อน** completion resolve | **93/93 เขียว** ⚠ |
| **W6b** | นับก่อน resolve **ทั้งสอง** wrapper (chat + embedding) | **1 failed** (`wraps the completion methods rather than the factory call`) |
| **W7** | `safeObserve` ไม่มี try/catch (throw ทะลุ) | **3 failed** |
| **W8** | log `error.message` (ซึ่งมีค่าที่ถูกปฏิเสธ) | **1 failed** (`logs the metric and label NAME, and never the rejected value`) |
| **W9** | `documents_total` นับครั้งเดียวหลัง loop | **2 failed** (`counts the branch that enters NEITHER array`, `counts documents inside the loop`) |
| **W10** | warn-once key = `JSON.stringify(labels)` (unbounded) | **1 failed** (`warns ONCE per metric and label name, not once per rejected value`) |
| **W11** | คืน `operations_total` + `kind` | **2 failed** |
| **W-auth** | ถอด `response.on("finish")` hook | **2 failed** (`covering all nine outcome points`, `counts the suspended branch`) |

**W7 คือ ruling 1 ทั้งข้อ** — ถอด try/catch แล้วแดง 3 เทส แปลว่าข้อกำหนด "observability ต้องไม่
พัง request ที่มันสังเกต" ถูกทดสอบจริง ไม่ใช่คอมเมนต์

**W10 ยืนยัน warn-once key ที่ผมขอ** — key เป็น `(metric, labelNames)` ซึ่ง bounded โดยธรรมชาติ
(2 label × 4 counter) ไม่ต้องมี eviction และไม่เก็บค่าที่ห้าม log ไว้ใน memory เปลี่ยนเป็น
keyed ด้วย value แล้วแดงทันที

## (ง) W4 รอด — แต่ไม่ใช่ช่องโหว่ (พิสูจน์ด้วยการรัน)

W4 คือ mutation ที่ผมคิดว่าสำคัญที่สุด ("call site ส่ง workspace slug เป็น label") และมัน
**ไม่ทำให้เทสแดง** ผมจึงไม่หยุดที่ตัวเลข — รันจริงเพื่อดูว่าเกิดอะไรขึ้น:

```
leaked into scrape? false
counted at all?     no line
log line: [metrics] refused to record "documents_total" with label(s) [outcome,workspace];
          the value is not in the declared vocabulary and is not logged here
value in log?       false
```

**guard กัดจริง**: `observe` throw, `safeObserve` จับไว้, counter ไม่ถูกเพิ่มเลย, slug
**ไม่โผล่ใน scrape** และ **ไม่โผล่ใน log** ด้วย พฤติกรรมถูกต้องทุกข้อ

ที่เทสไม่แดงเพราะ **`wiring.test.js` ทดสอบ guard ผ่าน `observe()` โดยตรง** (`refuses a
workspace slug as a label value` ใน `providerLabel.test.js`) ไม่ได้ทดสอบว่า *call site ที่
ทำผิด* จะถูกจับ — ซึ่งตามการออกแบบก็ถูก เพราะ `safeObserve` มีหน้าที่กลืน มันจึงกลืนได้
สม่ำเสมอไม่ว่าความผิดจะมาจากไหน

**ผลที่ตามมาที่ควรบันทึก**: `safeObserve` ทำให้ call site ที่ส่ง label ผิด **เงียบในเทส
ด้วย** — recon §4 เขียนว่า "the throw still fires in tests, where it is a hard failure"
แต่จริง ๆ แล้วไม่ใช่ เพราะทุก call site เรียกผ่าน `safeObserve` ซึ่ง catch ไว้เสมอ
ไม่มีโหมดไหนที่ throw ทะลุในเทส ดังนั้นถ้ามีคนเพิ่ม call site ที่ส่ง `workspace` วันนี้
CI จะเขียว และจะรู้ก็ต่อเมื่อมีคนสังเกตว่า counter ไม่ขยับ

**ขอเพิ่ม (ไม่ block)**: เทสที่ spy `console.warn` แล้ว assert ว่า **ไม่มี call site ไหนใน
tree เรียก `safeObserve` แล้วโดนปฏิเสธ** — รูปแบบง่ายสุดคือรัน path จริงทั้งสี่ (chat,
embedding, document, auth) แล้ว assert `console.warn` ไม่ถูกเรียกด้วย `[metrics]` เลย
นี่จะเปลี่ยน "call site ผิดแล้วเงียบ" เป็น "call site ผิดแล้ว CI แดง" ซึ่งคือสิ่งที่ recon
เข้าใจว่ามีอยู่แล้ว

## (จ) W6 รอด — ช่องว่างจริงในเทส (ข้อสังเกตหลัก)

พลิกลำดับให้ `chats_total` นับ **ก่อน** completion resolve → **93/93 เขียว**
พลิกทั้งสอง wrapper (W6b) → แดง 1

สาเหตุ: เทส `wraps the completion methods rather than the factory call` ใช้ source assert
`expect(source).toMatch(/const result = await original/)` ซึ่งเป็น **regex ตัวเดียวบนไฟล์
ทั้งไฟล์** ไฟล์มี wrapper สองตัว (chat กับ embedding) ดังนั้นเหลือตัวใดตัวหนึ่งไว้ก็ผ่าน
— pattern ที่เจอ 1 ครั้งพอใจแล้ว

**เป็นช่องโหว่จริงหรือไม่** — รันพิสูจน์บน connector ปลอมที่ throw:

```
before: 0
threw: upstream 429
after failed completion: 1   ← MUTANT นับ completion ที่ไม่เคยเกิด
```

ใช่ ถ้าใครสลับลำดับบรรทัดนี้ `chats_total` จะนับ completion ที่ล้มเหลว — ซึ่งคือ
"counting intentions" ที่คอมเมนต์ในโค้ดเองประกาศว่าจะไม่ทำ และเป็นความผิดพลาดที่
dashboard มองไม่เห็น (ตัวเลขสูงขึ้นดูเหมือน traffic ดี ไม่ใช่ provider ล่ม)

**ขอเพิ่ม (ไม่ block)**: เปลี่ยน source assert เป็นเทสพฤติกรรม — wrap connector ที่
`getChatCompletion` reject แล้ว assert ว่า `chats_total` **ไม่ขยับ** และทำแยกสำหรับ
`embedChunks` ด้วย เทสพฤติกรรมสองตัวนี้จะฆ่าทั้ง W6 และ W6b โดยไม่ต้องพึ่ง regex
(ถ้าจะเก็บ source assert ไว้ด้วย ควรใช้ `toHaveLength(2)` บน `matchAll` แทน `toMatch`)

**หมายเหตุเรื่อง source assert โดยทั่วไป**: ผมยอมรับมันใน #49 (`timingSafeEqual`) เพราะที่นั่น
พฤติกรรมวัดไม่ได้จริง ๆ (timing บนเครื่อง dev = เทส flaky) แต่ที่นี่พฤติกรรมวัดได้ง่ายมาก —
counter อ่านค่าได้ตรง ๆ — จึงไม่มีเหตุผลที่จะพึ่ง regex

---

## Verdict

**PASS** — ไม่มี blocker

- finding ทั้ง 5 ข้อจาก pre-read ตอบครบ และ **F-3 ตอบดีกว่าที่ผมเสนอ** (`finish` hook อ่าน
  status code แทนการ wire ทีละ branch — branch ใหม่ถูกนับเอง)
- inventory identical 315/315 — ไม่มี route ใหม่ ถูกต้อง
- mutation 12 ตัว จับได้ 10 · W4 รอดแต่พฤติกรรมถูกต้องทุกข้อ (พิสูจน์ด้วยการรัน: ไม่ leak
  เข้า scrape ไม่ leak เข้า log ไม่นับ) · W6 รอดเพราะ regex ตัวเดียวครอบสอง wrapper
- `operations_total` ถูกลบพร้อม label `kind` ตาม ruling และ W11 ยืนยันว่ามีเทสถือไว้

## สิ่งที่ขอให้ทำ (ไม่ block merge)

1. **เทสพฤติกรรมแทน source assert สำหรับลำดับการนับ** — connector ที่ reject แล้ว
   `chats_total` ต้องไม่ขยับ; เช่นเดียวกับ `embedChunks` แยกอีกตัว (ฆ่า W6 + W6b)
2. **เทสว่าไม่มี call site ไหนโดน `safeObserve` ปฏิเสธ** — spy `console.warn` แล้วรัน
   4 path จริง assert ไม่มี `[metrics]` (เปลี่ยน W4 จาก "เงียบ" เป็น "CI แดง")
3. **แก้คอมเมนต์ recon §4** ที่เขียนว่า "the throw still fires in tests, where it is a hard
   failure" — ไม่จริง ทุก call site ผ่าน `safeObserve` ซึ่ง catch เสมอ ข้อ 2 คือสิ่งที่ทำให้
   ประโยคนั้นเป็นจริง

## Residual (บันทึก)

- **counter ทั้งสี่ยังอ่านเป็นศูนย์จนกว่าจะมี traffic จริง** — ต่างจาก #90 ตรงที่ตอนนี้มี
  call site แล้ว แต่ dashboard ที่ตั้งขึ้นก่อนมี traffic ยังแยก "ไม่มีคนใช้" กับ "wiring พัง"
  ไม่ออก ข้อ 2 ข้างบนช่วยเรื่องหลังได้บางส่วน
- **`/metrics` ยังไม่ auth** (`ipAllowlist` ว่าง = ปล่อยทุกอย่าง เป็น default) — นอกขอบเขต
  issue นี้ตามที่ recon ระบุ แต่เป็นเหตุผลที่ F-4 สำคัญ และเป็นเหตุผลที่ข้อ 2 ควรทำ:
  vocabulary ที่ปิดคือสิ่งเดียวที่กั้นระหว่าง label กับ scrape สาธารณะ

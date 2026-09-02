# Techlead-2 — #127 `2ba5ca93a`: **PASS** (pre-read + verdict) + 1 finding แคบกว่าเดิม

worktree `/tmp/tl2-127` (detached) donor `/tmp/qa2-84b` + frontend node_modules จาก main
DB `t98b` · 4 ไฟล์: `main.jsx` +7/-1, `mobileConnectionsGuard.test.jsx` +158,
`systemReadGrantDrift.test.js` +76, `ledger-127.md` +86

**baseline**: frontend `mobileConnectionsGuard` **6/6** · server `systemReadGrantDrift` **4/4**

---

## การแก้ตรงกับ ruling — ยืนยันด้วยการวัด ไม่ใช่อ่าน

ผมยิง DB จริง:

```
system.read      ["super_admin:org"]
settings.write   ["setup_admin:org","super_admin:org"]
user.manage      ["setup_admin:org","super_admin:org"]
```

`AdminRoute` ถาม `settings.write` (`PrivateRoute/index.jsx:104`) · `ManagerRoute` ถาม
`user.manage` (`:147`) · route ทั้งสองของหน้านี้ถาม `system.read`
(`endpoints/mobile/index.js:21,86` — ยืนยันเอง) · `legacyRoleGrants.js:23` map
`manager → member` ซึ่งไม่ถือ `system.read` · **premise ของ issue ถูกต้องทุกข้อ**

## mutation — จับได้ทุกตัว แดงคนละชุด

| # | mutation | ผล |
|---|---|---|
| **M1** | ย้อน route กลับเป็น `ManagerRoute` | **1 failed** — `main.jsx pairs /settings/mobile-connections with AdminRoute` |
| **M2** | `INSERT role_permissions` ให้ `member:org` ถือ `system.read` | **1 failed** — `exactly one role holds system.read` |
| **M3** | ให้ `owner:workspace` ถือ `system.read` | **2 failed** — `exactly one role holds…` **และ** `no WORKSPACE-scoped role holds it` |
| **M4** | เปลี่ยน gate ของ mobile routes เป็น `settings.write` | **1 failed** — `the routes this protects still ask for system.read` |

**M2 คือ mutation ที่สำคัญที่สุด** เพราะมันคือทางที่คนจะ "ทำให้ manager ใช้ได้" —
เทสฝั่ง frontend ทั้ง 6 ตัวยังเขียวหมดภายใต้ M2 (ผมตรวจ: มัน mock `fetchMyCapabilities`
ไม่ได้แตะ DB) · **drift test คือสิ่งเดียวที่จับ** ซึ่งตรงกับเหตุผลที่เขียนไว้ใน header

**M3 แดงสองตัวแยกกันจริง** — ยืนยันคำอ้างใน comment ว่า assert สองข้อนี้พังคนละเหตุผล
ไม่ใช่ข้อเดียวเขียนซ้ำ

**M4 พิสูจน์ว่า pairing test ไม่ tautology** — มันอ่าน source ของ `endpoints/mobile/index.js`
จริง และแดงเมื่อ gate เปลี่ยน · ถ้าไม่มีตัวนี้ drift test จะเฝ้า permission ที่ไม่มีใครใช้แล้ว

**DB สะอาดหลังทุก mutation** — ยืนยัน `holders now: [{"name":"super_admin","scope":"org"}]`
และรันซ้ำได้ **4/4** ทุกครั้ง

## fixture ไม่ผ่านด้วยเหตุผลผิด

สามข้อที่ผมตรวจเป็นพิเศษ เพราะเป็นชั้นที่เคยพลาดมาก่อน:

1. **`multiUserMode: true`** — ทั้งสอง guard มี `|| !multiUserMode` · เทส
   `single-user mode admits everyone` ยิงเคสนี้ตรง ๆ และผ่าน = ยืนยันว่า flag load-bearing
   ไม่ใช่ประดับ
2. **`resetCapabilities()` ใน `beforeEach`** — `useCapabilities` cache เป็น module-level
   promise · ถ้าไม่ reset เทสตัวที่ 2 เป็นต้นไปจะรันบน capability ของ admin ทั้งหมด ·
   dev เขียน comment อธิบายว่าเคยเจอเองแล้ว
3. **`waitFor` รอ loader หาย** — ถ้าไม่รอ `page()` จะเป็น null สำหรับ **ทุก** role
   รวม admin · positive control `an admin still reaches the page` คือตัวที่จับข้อนี้

**เทส `ManagerRoute WOULD have admitted that manager`** เป็น control ที่ถูกต้อง — มันพิสูจน์ว่า
guard สองตัวต่างกันจริง ถ้าวันหนึ่งมันบรรจบกัน เทสนี้แดงและ premise ของ issue ต้องทบทวน

---

## FINDING (ไม่ block) — `setup_admin` เจอบั๊กเดิมทุกประการ แค่แคบลง

`AdminRoute` ถาม `settings.write` ซึ่ง **`setup_admin:org` ก็ถือ** · แต่ `system.read`
**มีแค่ `super_admin:org`** · แปลว่า:

> ผู้ใช้ที่ถือ `setup_admin` **ผ่าน AdminRoute** แล้วได้ **403 จากทั้งสอง route** ของหน้านี้
> — "หน้าที่ render ได้แต่ทำงานไม่ได้" อันเดียวกับที่ #127 แก้ เพียงแต่ย้ายจาก `manager`
> ไป `setup_admin`

**ทำไมไม่ block:**
- ไม่มี legacy role ไหน map ไป `setup_admin` (`ORG_ROLE_FOR_LEGACY` มีแค่ `super_admin`/`member`)
  ดังนั้นไม่มีผู้ใช้ได้มันโดยอัตโนมัติ · ต้อง grant ผ่าน `/admin/authorization/grants` โดยเจตนา
- ขอบเขตของ #127 คือ `manager` ซึ่งเป็นเคสที่เกิดเอง · เคสนี้ต้องมีคนตั้งใจสร้าง
- **ทิศทางปลอดภัย**: 403 ไม่ใช่การรั่ว

**แต่มันแปลว่า "AdminRoute ตรงกับ system.read" ไม่จริง** — ตรงแค่กับ `super_admin`
· ledger residual พูดถึง "manager เห็นหน้านี้" แต่ไม่ได้พูดถึงข้อนี้ · **ควรเพิ่มลง residual
หนึ่งบรรทัด** ว่าไม่มี guard ฝั่ง client ตัวไหน map กับ `system.read` แบบ 1:1 และ
`setup_admin` คือช่องว่างที่เหลือ · ถ้าจะปิดจริงต้องมี guard ที่ถาม `system.read` ตรง ๆ
ซึ่งเป็นงานคนละชิ้น

## residual ที่ ledger เขียนไว้ — เห็นด้วย

`system.read` เป็น org-scoped all-or-nothing · การให้ manager เห็น mobile device
โดยไม่เห็นอย่างอื่นต้องมี action ใหม่ = policy change ไม่ใช่ guard fix · เขียนถูกและ
ตรงกับ ruling ที่ผมให้ไว้ (แก้ guard อย่าขยาย permission)

## Verdict

**PASS** — ไม่มี blocker · mutation 4 ตัวจับได้ทุกตัวแดงคนละชุด · fixture ไม่ผ่านด้วยเหตุผลผิด
· DB สะอาดหลังทุก mutation · finding `setup_admin` ขอให้เพิ่มลง residual ไม่ต้องแก้โค้ด

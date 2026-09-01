# CHECKPOINT — ApproofWorkspace (2026-09-02)

จุดกู้คืนสำหรับ resume หลัง reboot / session ตาย

## สถานะ

- **integration branch**: `approof/main` @ `ffca31ad` (push แล้ว)
- **baseline**: ~759 tests / 68 suites บน PostgreSQL (ยืนยันโดย QA-1)
- **ปิดแล้ว 17 issues**: #1-#6, #8-#14, #16-#18
- **เปิดอยู่ 4**: #7, #15, #19, #20

## รันเทส local (บังคับ — ไม่งั้น fail แบบหลอก)

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"     # Node 26 ทำ jsonwebtoken พัง
export API_KEY_PEPPER="<32+ bytes>"                    # ไม่มี = 5 suites refuse ตั้งแต่ import
export DATABASE_URL="postgresql://..."                 # ต้องเป็น pg เท่านั้น
cd server && npx prisma generate && yarn test          # generate หลัง rebase ทุกครั้ง (57 fails หลอก)
```

## Worktrees ที่ยังทำงานอยู่

| worktree | branch | issue | HEAD | สถานะ |
|---|---|---|---|---|
| `.claude/worktrees/p0-4a` | `approof/p0-4a-ratelimit` | #6 |  merged | ✅ merged แล้ว (ffca31ad) |
| `.claude/worktrees/pr4a` | `approof/pr4a-scope-admin` | #19 | base | scope table 16 routes อนุมัติแล้ว รอเขียนโค้ด |
| `.claude/worktrees/t2` | `approof/t2-authz-engine` | #20 | base | เพิ่งเปิด — engine core + actor resolver |
| `.claude/worktrees/e2e` | `approof/e2e-playwright` | #15 | `88364c8d` | 4/12 spec ผ่าน กำลังแก้ selector |

## ทีม (resume ต้องตั้งใหม่ทั้งหมด — session-scoped)

| บทบาท | session | งานปัจจุบัน |
|---|---|---|
| PMO | `anything-llm-02` (นี้) | คุม merge/ruling/issue |
| Dev 1 | `dev-p0-2` (subagent) | #6 rebase |
| Dev 2 | `dev-p0-6` (subagent) | #19 PR-4a |
| Dev 3 | `anything-llm-94` | #15 E2E |
| Dev 4 | `anything-llm-cc` | #20 T-2 |
| QA-1 feature | `anything-llm-17` | post-merge sanity |
| QA-2 security | `anything-llm-5f` | เจาะ exploit |
| Security reviewer | `anything-llm-e5` | design review |
| Authz architect | `anything-llm-8b` | contract review |
| Techlead | `anything-llm-b5` | pre-merge integration |

**subagent (`dev-p0-2`, `dev-p0-6`) peer session ส่งตรงไม่ได้ — ต้องผ่าน PMO**

## เอกสารอ้างอิง (บน main)

- `docs/superpowers/specs/approof-workspace-enterprise.md` — spec 41 items
- `docs/superpowers/plans/{phase0-foundation,program-backlog,execution-schedule}.md`
- `docs/superpowers/design/seams/` — 11 contracts (binding)
- `docs/superpowers/design/code-standards.md` — §1.2 migration slot · §1.5 filename ไม่ใช่ key · §6.1 prefix `apw-*` · §7.1/§7.2 integration test PG จริง + boot DoD · §7.3 test title ห้ามมี `#`/`//` · §7.4 postgresql:// literal
- `docs/superpowers/design/p0-4-security-recon.md` · `p0-5-authorization-recon.md` · `p0-5-t1-schema-detail.md` · `p0-5-t2-actor-resolver.md` · `p0-5-stest-harness.md` · `pr-0e-sync-watched-bloom.md`
- `.infi/residual-risks.md` — 9 ข้อ (ไม่ commit)

## งานถัดไปตามคิว

1. **#6** — Dev 1 rebase บน `de95015b` → check → merge (QA PASS + Techlead ผ่านแล้ว)
2. **#19 PR-4a** — 16 routes: admin/userManagement/auth · counter 68→52
3. **#20 T-2** — engine + actor resolver 6 identities + A-1 fix + visibility hard override
4. **#15 E2E** — gate ปิด Phase 0
5. **#7** — .env hygiene (ยังไม่เริ่ม)
6. ต่อ: PR-4b/4c · T-3..T-8

## ช่องโหว่ที่ยังเปิด (จดไว้ ห้ามลืม)

- **F-2 over-grant**: 68 routes ใช้ scope `"*"` + DB default `["*"]` → ทุก key ยัง god-mode · ปิดที่ PR-4a/b/c
- `/v1/system/remove-documents` purge ทั้งระบบด้วย API key ใดก็ได้ → รอ scope `document.delete`
- `api_keys.workspaceId` เก็บแต่ไม่บังคับ → PR-4
- ไม่มี scope ceiling ตอนสร้าง key → PR-4/5
- embed sessionId เป็น bearer-by-UUID → P0-5 T-4b
- `docVectorsCanonicalize` job ปิดด้วย guard `ENABLE_DOC_VECTORS_CANONICALIZE` — **ห้ามเปิดจน T-4b/T-5 ย้าย 11 call sites**

## กติกาที่บังคับใช้

- หนึ่ง task = หนึ่ง issue (`task.sh start`) · ปิดด้วย `check` + `close` เท่านั้น
- security fix ต้องมี HTTP-stack test ≥1 ไฟล์ (pattern `/tmp/qa2-http-patterns/`— path ต้องมี `/api` นำหน้า)
- mock ของ model finder ต้องเคารพ clause — ห้าม `mockResolvedValue` คงที่เมื่อพิสูจน์ selection
- rebase ก่อน handoff เสมอ — ด่านต่อ branch จับ merge interaction ไม่ได้ (บทเรียน #18)
- รายงาน SHA หลัง commit ครั้งสุดท้ายเสมอ

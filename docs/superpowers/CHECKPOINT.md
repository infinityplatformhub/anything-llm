# CHECKPOINT — ApproofWorkspace (2026-09-02)

จุดกู้คืนสำหรับ resume หลัง reboot / session ตาย

## สถานะ

- **integration branch**: `approof/main` @ `ffca31ad` (push แล้ว)
- **baseline**: ~759 tests / 68 suites บน PostgreSQL (ยืนยันโดย QA-1)
- **ปิดแล้ว 31 issues**: #1-#14, #16-#26, #29, #33, #34, #37, #38
- **เปิดอยู่**: #15 (Dev3 10/12 — root cause: mock-llm คนละ docker network, model field select/input — ruling: spec 05 ใช้ API upload+update-embeddings แทน drive picker modal, คง 1 assertion modal; 06/11 ตามมา), #27 PR-4c (Dev1 เริ่ม, slot 045000, drop `*` default/fallback, zero * rows), #29 T-4b (Dev4 เริ่ม, ทำ orgWide:true field แทน '*' sentinel + seam 07), #30 T-5 (คิว Dev4 หลัง T-4b — subscriber DoD), #31 T-7 (คิว Dev2 หลัง T-4a), #32 embed session token (คิว Dev4 หลัง #29), #33 closed (4 parts merged), #35 PR-4d (Dev1 หลัง #27+#29), #40 frontend-authz capabilities endpoint (Dev4 หลัง #29/#30 → lane D UI), #43 S2 SAML (หลัง #36), #44 V1-c Thai eval (อิสระ, ก่อน V1-b), #36 S1 SSO OIDC (เดือน 2, Dev2 หลัง T-4a/T-7, slot 060000), #37 merged · recon เดือน 2: s1-sso-oidc, s2-entra-saml, v1-thai-language, v1-c-thai-eval-set, frontend-authz ใน .infi/recon/ · #22 QA-2 post-merge 18/18 PASS, #22 T-3 (Dev4, t3 `60155631` QA-1 FAIL B1/B2/B3 — non-user actor NaN crash documentFilter:151, cache key ไม่รวม allowedDocumentIds, denied cap — รอ SHA fix), #26 PR-4b (Dev1, 4 file-disjoint PRs ทีละอัน), #25 T-4a (Dev2), #27 PR-4c (คิว Dev1 หลัง 4b, slot 040000), #28 Phase A merged b81de0b4 (0325cbfb); Phase B retention body + §7.2 + C-1 → dev-28 next, #29 T-4b (คิว Dev4 หลัง #22, recon + §PMO rulings), #25 T-4a route wiring (recon `.infi/recon/t4a-route-wiring.md`, rulings: B-1 grants(creator)∩scopes, W-5 → T-4b, no migration slot — รอ dev ใหม่)
- **merge order (บังคับ)**: t4a `494ef6d7`+ (B-1 stripped) → t4b (รวม W-8b validApiKey.js) → pr4c rebase (admin.js:521/526 + validApiKey.js:34 ชน)
- **worktrees live**: e2e, pr4b(#33 branch), t4a, t4b, fix34, std71 (Techlead §7.1/§7.5) — เก่าทั้งหมด reap แล้ว
- **§2.2 on main after T-4a**: ROLES. refs (excl admin helper) 0 · role literal 1 (img.js:55, T-5 exemption) · multiUserProtected.js gone · legacy docId sites 8 (T-5/T-6) · flexUserRoleValid mentions 2 files (comments only, verify) · worktrees live: e2e, pr4b, t4b, t7, s76(Techlead)
- **hotfix #39** (Dev2): SERVICE_PRINCIPALS → principals.js (require cycle, silent grant skip) — merge before/after t4b whichever first
- **§2.5 PASS** on 190a5b88: 3×85/940 identical, org-wide grants = super_admin only
- **T-4b merged `800292ff`** (#29 closed) · next: Dev2 rebase #39 (legacyRoleGrants merge-both, JobRuntime 2 imports) → merge → Dev1 rebase #27 → merge · Dev4: #46 → #32 → #45 → #30 · T-7 t7 `2147faaa` 953/953 (rebase after #39) · #39 rebase must merge-both in legacyRoleGrants.js (§7.7) · #38 merged 3f4ee30d · #45 keyKind-required + #46 validatedRequest fail-open hotfix (Dev4 after #29) · #44 V1-c (subagent dev-44 running) · #43 S2 queued · **#39 `19647b03`** (3 commits incl. tx no-swallow + inTransaction) rebase after t4b · #40(A) → T-7 · #41 opened (7 document routes bound-key gap, Dev1 after #27) · gates running: #38 0fce7589, AAD 47f30790, t4b 4c32bce3 (check-29c) · #42 pg-literal cleanup opened (after #29/#27) · #15 11/12 (login 429 root cause) · trial-merge recipes sent: JobRuntime 2 imports (Dev2), validApiKey line 115 + regression single row (Dev1) · **#39 `d4fbe651`** (gate PASS at 10b7fe44 948/948; +routeWiring STORAGE_DIR fix) conflicts t4b in JobRuntime.js → Dev2 rebases after t4b · checklist §2.5 merged 3bf21384 · #33p2 QA-1 PASS
- **main**: Dockerfile node:22 ทั้ง 3 จุด (FROM + nodesource ×2) + 6 workflow steps node 22 · #39 `3438fde8` rebased, 1 test red = actorResolver R5 mock lacks users.count (ruling: fix in #39) → SHA → merge NEXT · #42 36ec3abb gate check-42 · #46 15aa6e7b gate FAIL §7.3 (`#46:` in describe) → Dev4 fix → regate · #28A QA-2 PASS 12/12 · #15 12/12 (rebase pending) · #39 rebase (Dev2) → pr4c · #28 Phase A 3fd99b7b gate check-28 + QA-1/QA-2 requested · #38 QA-2 post-merge PASS · e2e worktree detached at 8ec7a303 (Dev3 pinged) · t6 3fd99b7b (dev-28 pinged) · v1c ae7c0dc1 (dev-44) (#38 merged; AAD 47f30790 merged; #33p1 QA-1 post-merge PASS) · t6 first commit `2b6d8643` (sink redaction) · #38 gate FAIL §7.3 line 208 → Dev1 · FINDING-1 fix extras sent Dev4 (both-throw→null, onboarding window comment) · pending:, #39 principals.js (Dev2), #33 AAD fix (Dev1), #38 test name (Dev1), #15 (Dev3 7/12), #28 Phase A (dev-28), §2.5 baseline report (subagent) · was `469ecc83` (T-4a merged 70283c1b + §7.6/§7.7 doc + residuals) · in flight: t4b rebase (Dev4), #38 4-run proof (Dev1), #15 7/12 login-state regression (Dev3), #31 T-7 (Dev2), #28 Phase A (dev-28), §2.5 baseline-3x-b, QA-1 T-4a post-merge, QA-2 #33p2 crypto · next: t4b rebase → merge → pr4c rebase → merge; #33p3, #35 GREEN, #31 started (#34, #33p1, residual-risks.md tracked, code-standards §3.4 status contract + §2.2a) · pr4c ชน t4b 2 ไฟล์ — recipe ส่ง Dev1 แล้ว (rebase หลัง t4a→t4b) + hotfix test on migrate deploy, check-local clean · (gates §7.1a check-db-push + §7.5 check-locals-contract merged; 5 suites allowlisted on db push → Dev4 converts in t4b) · **t4a merged `70283c1b`** (#25 closed, 044000 in main) · Dev2 → #31 T-7 started (t7 worktree; ruling: grant_revocations table slot 021000, not soft-delete) · #35 RED `086c0da3` (setup_admin) · #38 modelPricing flake → Dev1 filler · residual markers merged (§2.8 = 0, no needs-issue) · #28 DoD: audit sink redaction allowlist (QA-1) · #27 rebase rule: validApiKey.js hand-resolve + mandatory HTTP `["*"]`→403 test · t4b `aad4ae2e` gate PASS + QA-2 PASS 12/12 (ledger normalized → /tmp/ledger-29.md, 41 rulings; re-copy after rebase) · migration 044000 (T-1 org-wide member grants → workspace-scoped from workspace_users.role_id + runtime sync; ruling ก), 401→403 ruling, legacyRoleGrants kept · t4b `aad4ae2e` gate check-29 all gates PASS (Tests line pending) · #33p2 gate check-33b running · Dev1 → #35 RED on t4b base while blocked (W-5..W-12, 5 suites → migrate deploy) รอ t4a merge → rebase → SHA สุดท้าย; reviewers ยิง interim บน c3e58fa2 · t4a 494ef6d7+wt (group 3, engine.js = W-6 only) · t4b 6cf4de60+wt (B-1 binding blanket, W-8b, keyKind fix) · pr4c `700ae960` (906/906, PASS ครบ Techlead/QA-1/QA-2; rebase commit ต้องเพิ่ม bootSSL report + envDumpGuard fixture, rebase หลัง t4a→t4b) · t4b W-8 `3677aec8` (single-user createdBy-null → singleUser principal ruling; 9 env-local failures ต้องเขียวก่อนส่ง) (PR-4b ครบ 5 PR, wildcard route counter 0; §2.5 baseline 3×868 clean บน 6a4307a8) (checklist §2.7/§3.1 merged, engines.node pinned ทุก workspace รวม frontend) · t4b `cfa3388a` W-5/orgWide/B-1 done, W-8/W-10 pending · subagent baseline-3x รัน §2.5 three-run บน main · t4a 8/8 S-tests GREEN, route sweep in progress (rebased 8e1b7b9c) · t4b started (ruling: router middleware = grant check only, no double scope/audit) · merge order 4b-3 → t4a → t4b · slots: 4b-1 ใช้ 040000, 4b-2/3/4 = 041000/042000/043000, PR-4c 045000, T-6 050000 (+ std-import-gate §5.1, scripts/check-local.sh) · Dev1 pr4b + Dev2 t4a เริ่มแล้วจาก d7f92baf · recon พร้อม: pr4b, pr4c, t4a(#25), t4b, t5, t6, t7 ใน `.infi/recon/` (§PMO rulings ท้ายไฟล์) · slots: 4c 040000, T-6 050000
- **contract ใหม่** ทุก task.sh start: `yarn test 2>&1 | grep -E "Tests:" | grep -v failed; exit 0` (เทสแดง = ไม่ match)
- **รอ dev ใหม่ 2 คน** (user จะเพิ่ม): Dev1 → PR-4b/4c (recon จาก Techlead b2), Dev2 → T-4a (recon จาก architect 6f) · ทักมาที่ PMO แล้วแจกทันที · reboot แล้ว session ชื่อใหม่: PMO=anything-llm-47, Dev1=13 (#26 PR-4b → #27 PR-4c), Dev2=6f (#25 T-4a), Dev3=3d (#15 → #28 T-6), Dev4=ff (#22 → T-4b), QA-1=af, QA-2=e6, Techlead=b2 · (13/6f เคยตอบ roll call เป็น security/architect — แก้ role แล้ว)
- **test PG หลัง reboot**: docker down → ใช้ local PG17 `postgresql://approof:approof@localhost:5432/approofworkspace_<name>` + API_KEY_PEPPER 32+ bytes

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
| `.claude/worktrees/pr4a` | `approof/pr4a-scope-admin` | #19 | `0a6c0ab5` | โค้ดเสร็จ counter 68→52 · รอ verdict QA-2 (5f) + Techlead (b5) → check/close/merge |
| `.claude/worktrees/t2` | `approof/t2-authz-engine` | #20 | `b9be0c9d` | core เสร็จ 779/779 (rebased 639a1e71) · ส่ง QA-1 (17) ตรวจแล้ว → check/close/merge |
| `.claude/worktrees/dburl` | `approof/dburl-helper` | #21 | `65979867` | helper forPostgresClient/forPrismaTest/forPsql + t1-authz refactor เสร็จ · subagent `check-21` กำลังรัน task.sh check |
| `.claude/worktrees/e2e` | `approof/e2e-playwright` | #15 | `092c9f8b` | 4/12 spec ผ่าน กำลังแก้ selector |

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

1. **#21** — อ่านผล check-21 (`/tmp/check-21.log`) → close (ledger sed normalize) → merge → push
2. **#19 PR-4a** — รอ QA-2/Techlead verdict → check → close → merge
3. **#20 T-2** — รอ QA-1 verdict → check → close → merge · ส่งต่อ T-4b: engine ยังไม่ enforce scope-vs-grant ของ apiKeyContext
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

# CHECKPOINT — ApproofWorkspace (2026-09-02)

จุดกู้คืนสำหรับ resume หลัง reboot / session ตาย

## สถานะ

- **integration branch**: `approof/main` @ HEAD ของ origin (ดูบรรทัด main-line ด้านล่าง; push ทุก merge)
- **baseline**: ~759 tests / 68 suites บน PostgreSQL (ยืนยันโดย QA-1)
- **ปิดแล้ว 57 issues** (ล่าสุด: … #60 #61 #68; #30 slices 1a+1b merged, issue open) · HARD RULE hook ~/.claude/hooks/infi-dev-gate.sh: edits/commit/task.sh blocked until Skill infi-dev (or requesting-code-review/security-review) invoked per session
- **เปิดอยู่**: #15 (Dev3 10/12 — root cause: mock-llm คนละ docker network, model field select/input — ruling: spec 05 ใช้ API upload+update-embeddings แทน drive picker modal, คง 1 assertion modal; 06/11 ตามมา), #27 PR-4c (Dev1 เริ่ม, slot 045000, drop `*` default/fallback, zero * rows), #29 T-4b (Dev4 เริ่ม, ทำ orgWide:true field แทน '*' sentinel + seam 07), #30 T-5 (คิว Dev4 หลัง T-4b — subscriber DoD), #31 T-7 (คิว Dev2 หลัง T-4a), #32 embed session token (คิว Dev4 หลัง #29), #33 closed (4 parts merged), #35 PR-4d (Dev1 หลัง #27+#29), #40 frontend-authz capabilities endpoint (Dev4 หลัง #29/#30 → lane D UI), #43 S2 SAML (หลัง #36), #44 V1-c Thai eval (อิสระ, ก่อน V1-b), #36 S1 SSO OIDC (Dev3, slots 080000/081000, recon docs/superpowers/recon/), #37 merged · recon เดือน 2: s1-sso-oidc, s2-entra-saml, v1-thai-language, v1-c-thai-eval-set, frontend-authz ใน .infi/recon/ · #22 QA-2 post-merge 18/18 PASS, #22 T-3 (Dev4, t3 `60155631` QA-1 FAIL B1/B2/B3 — non-user actor NaN crash documentFilter:151, cache key ไม่รวม allowedDocumentIds, denied cap — รอ SHA fix), #26 PR-4b (Dev1, 4 file-disjoint PRs ทีละอัน), #25 T-4a (Dev2), #27 PR-4c (คิว Dev1 หลัง 4b, slot 040000), #28 Phase A merged b81de0b4 (0325cbfb); Phase B retention body + §7.2 + C-1 → dev-28 next, #29 T-4b (คิว Dev4 หลัง #22, recon + §PMO rulings), #25 T-4a route wiring (recon `.infi/recon/t4a-route-wiring.md`, rulings: B-1 grants(creator)∩scopes, W-5 → T-4b, no migration slot — รอ dev ใหม่) — S2 79448c01 (XSW fixtures + xml-crypto + deriveUsername; derived-handle 409 only vs local account, SSO-linked → suffix retry; normalizeForCompare NFC+lowercase both sides; order identity_links email → local email → handle, mutant-proven; 101/101); Techlead PASS + FINDING-1 (NameID read from doc root, not verified assertion) → 6 rulings in s2-entra-saml.md, Dev3 dab75e1a closes 1–6 + slot 082000 (identity_assertion_ids INSERT-claim, identity_providers, NFC backfill; 128/128) → Techlead PASS dab75e1a; claim order ruling (verify→ID→Conditions→claim, 3 row-count tests) → SamlIdentityProvider landed 01888688 (155/155; readFromAssertion, claim after conditions, order-pin test, cert list loop) + QA-2 PASS 23/23 on dab75e1a; Techlead review 01888688 pending; Techlead retracted #48 PASS (test green for wrong reason, JWT_SECRET had no row) → ruling addendum: denylist 5 keys + set-row-then-refuse test + envKey char class; Dev3 4765dbae (cd4fda5e + Host-fallback mount error log, 365/365) = full S2 (ACS + inviteRateLimit + Recipient/Issuer/Status; mount order fix; ACS URL from SSO_ACS_URL not Host; 361/361) Dev3 69a64bf7 (+mount-order explanatory test, consumed.provider check, warnIfMisconfigured; 372/372) **merged** (gate 1446, QA-2 40/40, Techlead-1 confirm); Dev3 S3 #60 da87ec42 (rebased on f89fba9a; recon 9e63f4df; unhelpful mock directory + RFC 4515 escape module, 203/203) → f221df51 client selection (ldapts) + LdapIdentityProvider (547/547) but Techlead-1 **FAIL on fixtures** (no objectClass → realistic filters match nothing, injection fixture wrong shape; DN-case entry missing; search without service bind; anonymous/unauthenticated conflated) → Dev3 **54081944** (RFC 4515 parser + parser tests, objectClass, Alice.Smith + DN case-insensitive, service-bind gate, anonymous/unauthenticated split, G1–G3, concat mutant now dies, §7.9c survivor #2 fixed, slot 091000 LDAP columns; 577/577) → Techlead-1 PASS → **#60 merged** (17aadd2f; gate 1669, QA-2 12/12, Techlead PASS) → Dev3 **#68 ac518607** (092000 shape CHECK + COMMENT + 7 tests + loginAccountRateLimit; RED 4/9) gate PASS 1847/1883 (36 skipped real-store, /tmp/wt-68 kept) + Techlead-1 PASS (2 NIT → small commit); QA-2 pending → merge (POST /sso/ldap/login + inviteRateLimit, wildcard rejects redirect:false providers, password scope/finally, ldap:// refused, /sso/ldap/enabled boolean; 595/595) GATING /tmp/wt-60; QA-2 + Techlead-1 → merge; FINDING-5 schema CHECK → slot 092000 later (2 findings → tiny follow-up: mount-order explanatory test, consumed.provider check; NOTE-A residual); QA-2 pending → merge; Dev3 S3 recon done → issue #60 opened with rulings 1–5 → identity_assertion_ids + identity_providers slot 082000 → SamlIdentityProvider landed 01888688 (155/155; readFromAssertion, claim after conditions, order-pin test, cert list loop) + QA-2 PASS 23/23 on dab75e1a; Techlead review 01888688 pending; Techlead retracted #48 PASS (test green for wrong reason, JWT_SECRET had no row) → ruling addendum: denylist 5 keys + set-row-then-refuse test + envKey char class; Dev3 4765dbae (cd4fda5e + Host-fallback mount error log, 365/365) = full S2 (ACS + inviteRateLimit + Recipient/Issuer/Status; mount order fix; ACS URL from SSO_ACS_URL not Host; 361/361) Dev3 69a64bf7 (+mount-order explanatory test, consumed.provider check, warnIfMisconfigured; 372/372) **merged** (gate 1446, QA-2 40/40, Techlead-1 confirm); Dev3 S3 #60 da87ec42 (rebased on f89fba9a; recon 9e63f4df; unhelpful mock directory + RFC 4515 escape module, 203/203) → f221df51 client selection (ldapts) + LdapIdentityProvider (547/547) but Techlead-1 **FAIL on fixtures** (no objectClass → realistic filters match nothing, injection fixture wrong shape; DN-case entry missing; search without service bind; anonymous/unauthenticated conflated) → Dev3 **54081944** (RFC 4515 parser + parser tests, objectClass, Alice.Smith + DN case-insensitive, service-bind gate, anonymous/unauthenticated split, G1–G3, concat mutant now dies, §7.9c survivor #2 fixed, slot 091000 LDAP columns; 577/577) → Techlead-1 PASS → **#60 merged** (17aadd2f; gate 1669, QA-2 12/12, Techlead PASS) → Dev3 **#68 ac518607** (092000 shape CHECK + COMMENT + 7 tests + loginAccountRateLimit; RED 4/9) gate PASS 1847/1883 (36 skipped real-store, /tmp/wt-68 kept) + Techlead-1 PASS (2 NIT → small commit); QA-2 pending → merge (POST /sso/ldap/login + inviteRateLimit, wildcard rejects redirect:false providers, password scope/finally, ldap:// refused, /sso/ldap/enabled boolean; 595/595) GATING /tmp/wt-60; QA-2 + Techlead-1 → merge; FINDING-5 schema CHECK → slot 092000 later (2 findings → tiny follow-up: mount-order explanatory test, consumed.provider check; NOTE-A residual); QA-2 pending → merge; Dev3 S3 recon done → issue #60 opened with rulings 1–5
- **merge order (บังคับ)**: t4a `494ef6d7`+ (B-1 stripped) → t4b (รวม W-8b validApiKey.js) → pr4c rebase (admin.js:521/526 + validApiKey.js:34 ชน)
- **worktrees live**: e2e, pr4b(#33 branch), t4a, t4b, fix34, std71 (Techlead §7.1/§7.5) — เก่าทั้งหมด reap แล้ว
- **§2.2 on main after T-4a**: ROLES. refs (excl admin helper) 0 · role literal 1 (img.js:55, T-5 exemption) · multiUserProtected.js gone · legacy docId sites 8 (T-5/T-6) · flexUserRoleValid mentions 2 files (comments only, verify) · worktrees live: e2e, pr4b, t4b, t7, s76(Techlead)
- **hotfix #39** (Dev2): SERVICE_PRINCIPALS → principals.js (require cycle, silent grant skip) — merge before/after t4b whichever first
- **§2.5 PASS** on 190a5b88: 3×85/940 identical, org-wide grants = super_admin only
- **T-4b merged `800292ff`** (#29 closed) · next: Dev2 rebase #39 (legacyRoleGrants merge-both, JobRuntime 2 imports) → merge → Dev1 rebase #27 → merge · Dev4: #46 → #32 → #45 → #30 · T-7 t7 `2147faaa` 953/953 (rebase after #39) · #39 rebase must merge-both in legacyRoleGrants.js (§7.7) · #38 merged 3f4ee30d · #45 keyKind-required + #46 validatedRequest fail-open hotfix (Dev4 after #29) · #44 V1-c (dev-44 died silently; dev-44b resumed from v1c uncommitted work) · #43 S2 queued · **#39 `19647b03`** (3 commits incl. tx no-swallow + inTransaction) rebase after t4b · #40(A) → T-7 · #41 opened (7 document routes bound-key gap, Dev1 after #27) · gates running: #38 0fce7589, AAD 47f30790, t4b 4c32bce3 (check-29c) · #42 pg-literal cleanup opened (after #29/#27) · #15 11/12 (login 429 root cause) · trial-merge recipes sent: JobRuntime 2 imports (Dev2), validApiKey line 115 + regression single row (Dev1) · **#39 `d4fbe651`** (gate PASS at 10b7fe44 948/948; +routeWiring STORAGE_DIR fix) conflicts t4b in JobRuntime.js → Dev2 rebases after t4b · checklist §2.5 merged 3bf21384 · #33p2 QA-1 PASS
- **main**: 992116f4 — 46/58 closed. #52 MERGED b1dbd4e5. #41 MERGED 674d8f19 (QA-1 + Techlead PASS; QA-2 post-merge probe on main); QA-1/QA-2 verdicts pending §7.11 → merge; Dev1 → #48 recon (docs/superpowers/recon/credential-store-dc.md). #36 S1 MERGED c9a0863f (all verdicts PASS); Dev3 → S2 #43 on branch from c9a0863f (rulings in s2-entra-saml.md §PMO). #30 slice 1a 05e18e79 gate PASS 1310/1310 but **FAIL ×2** — QA-2: pgvector toJsonbSql placeholder numbering kills every query (LanceDB 6/6 PASS, policy cache 13/13); Techlead: pre-T-5 Arrow schema without ACL column → escape hatch throws (FINDING-1) + retrievalSupport countRows bare identifier (FINDING-2). Rulings A–D+C2 → Dev4 round 3 b35c73eb (bind push-then-return, schema-check (ข), count 3-outcome, 22 tests, 1332/129) **slice 1a merged f12e8108** (gate 1332, QA-2 62/62, Techlead-2 PASS; findings 42P01/Milvus/half-migrated → 1b); **slice 1b merged** (dd72fc85; gate 1712, QA-2 49/49, Techlead-2 PASS; NITs: toWeaviateWhere dead code, staleClasses untested, UNVERIFIED_PROVIDERS unpinned → slice 2/3); slice 2 78cdbecb gate PASS 1760 but **Techlead-2 FAIL HIGH** (pinnedDocs ignores filter workspace/org scope → cross-workspace pinned leak via org chat.send; embed/router prefetch passes user=null) + QA-1 FAIL confirms (M7 survivor) → round-2 ruling → Dev4 **4737f574** (scope 2 layers + org join, HTTP RED cross-ws, embed actorRef, M7 fixed; 1769/164) GATING /tmp/wt-30s2 4 engines; QA-1/QA-2/Techlead-2 reviewing; QA-1 + Techlead-2 reviewing; slice 2 rulings Q1–Q4 issued (pinned docs via DocumentAclFilter on document_id, NULL documentId = unprovable; getContextFiles requires user; agent paths in scope); 1b WIP c4de0124 paused · **#58 merged 8ea3842f** (953e108a; gate 1250/1250, QA-1 PASS, QA-2 PASS 12/12, Techlead PASS; follow-up: Dev2 approof/58-followup 2adbe8c5 **merged a05c8796** (Techlead PASS); #59 opened; #50 recon done — rulings (a) separate issue for simpleSSOLoginDisabledMiddleware fail-open, (c) yarn swagger regenerate OK, **#50 merged ba486811** (d655a7eb; gate 1546, QA-1 6/6, Techlead PASS); **#53 merged** (1fa7aeae; gate 1609, QA-2 20/20, Techlead PASS) → Dev2 #40: mockup cf7ed8ad **user-confirmed 13:40**; rulings (endpoint ?workspaceId, WORKSPACE_CAPABILITIES list checked by ACTION_SCOPES, workspace.create added to ORG list, contract as issue comment) → contract comment posted, plan 40c76712 on main, #66 opened for workspace sites; Dev2 dispatching Sonnet implementer/reviewer → round-2 rulings (keep redirect→OIDC, :66 predicate, migration 090000 strip sso.issue → [] no revoke, /v1 sweep, single-use → OIDC test) → ff42b682 (round-2 done, 1351/1351; SSOProviders in currentSettings; migration 090000; NO_LOGIN_REDIRECT kept as operator override) → 9d000ec8 (+SSOProviders payload tests); gate ff42b682 FAIL ×2 tool rules: §7.3a titles start with # (4 files) + §5.1 missing SystemSettings require in noLoginShapeB.test.js → 5c05a935 (rebased on #43, +SSOProviders saml test, 1546/1546) gate PASS 1546/1546 (/tmp/wt-50 kept, DB approofworkspace_g50); merge target d655a7eb (= +NIT-1 comment/ledger only); Techlead-1 PASS 4a5f4a65 + confirm pending; QA-1 pending → merge; then Dev2 #53) · Dev2 #50 recon → commit · **#48** Dev1 06965da4 gate PASS 1378/1378 but **QA-1 FAIL BLOCKER-1** (DELETE /system/credential/AUTH_TOKEN → validatedRequest passthrough → instance open permanently; JWT_SECRET clear kills sessions); ruling: denylist instance-auth keys + iterate-all-secret-keys test + /request-token 401 not 500; Dev1 round 4 **66cb5e7d** (denylist 5 keys, set-row-then-refuse, passthrough sweep test, envKey pattern, /request-token 401; 27/27) gate PASS 1391/1391 (/tmp/wt-48b kept, DB approofworkspace_g48b); **merged** (gate 1391, Techlead-1, QA-1 PASS; NIT missing-password 500 → #59); Dev1 #59 **merged** (bd15b0d3; gate 1598, QA-1, Techlead PASS; Techlead FINDING-1 → #65) → #64 5d8bc8cb gate **FAIL** (scope change broke #63 /v1 twin tests ×2 + S-20 super_admin test; ruling: retarget #63 tests to 403 + fix S-20 fixture scope) → Dev1 fix SHA → regate → #65 (SDD from here) → #57 → #51 → #55 · was: (4 sites check .success, M10 guard, liveSync handler test; 17/17; RED 7/11 + 4/6) GATING /tmp/wt-59 DB approofworkspace_g59; QA-1 + Techlead-1 reviewing → merge → #64 → #57 → #51 → #55 in /tmp/wt-48 (DB approofworkspace_g48) → QA-1 probe + Techlead → merge → Dev1 #51 #55 #57 #59
- **contract ใหม่** ทุก task.sh start: `yarn test 2>&1 | grep -E "Tests:" | grep -v failed; exit 0` (เทสแดง = ไม่ match)
- **รอ dev ใหม่ 2 คน** (user จะเพิ่ม): Dev1 → PR-4b/4c (recon จาก Techlead b2), Dev2 → T-4a (recon จาก architect 6f) · ทักมาที่ PMO แล้วแจกทันที · reboot แล้ว session ชื่อใหม่: PMO=anything-llm-47, Dev1=13 (#26 PR-4b → #27 PR-4c), Dev2=6f (#25 T-4a), Dev3=3d (#15 → #28 T-6), Dev4=ff (#22 → T-4b), QA-1=af, QA-2=e6, Techlead=b2, Techlead-2=10 (joined 12:05; T-5/vector/embed reviews), QA-3=ea (joined 13:33; Track V/Ops reviews: #61 V9, O2, V8, #64/#65), Dev5=7c (joined 12:25; lane C/E) — V9 = #61 (slot 100000) code written, blocked by live main bug: chat.read never granted to non-super_admin → **#63 merged** (ffb8b1f2; gate 1596, QA-1, Techlead PASS; ruling ก′) → Dev5 rebasing #61 V9 → merge → #61 rebases (apiKeys.postgres 5-fail claim = Dev5 env, 6/6 green here); then O2 → V8 · (13/6f เคยตอบ roll call เป็น security/architect — แก้ role แล้ว) · **#61 V9 e29d3d84** (Dev5; slot 100000 response_text + pg_trgm SCHEMA public §7.13; 1611/1611) gate PASS (/tmp/wt-61 kept, DB approofworkspace_g61) but **HOLD**: Techlead-1 FINDING-1 response_text stale after update-chat (2 routes) + EXPLAIN index test missing + migrate-only test untracked → QA-3 FAIL F1–F5 (stale response_text on 3 more write paths, no EXPLAIN test, Thai trgm zero-trigram under lc_ctype=C) → Dev5 **54dcdc34** (helper 4 paths + scan test, EXPLAIN per-column, locale detect 3 layers; 1626/156) gate PASS 1626/1626 (/tmp/wt-61 kept); QA-3 rerun + Techlead-1 diff pending → merge; O2 recon done (44408aa1, rulings 1–3) → mockups
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

## In-flight gates (2026-09-02)
- #28B merged; #44 merged; #47 merged (cdb03d1d)
- pairwise merge-tree across all six: 0 conflicts
- #32 ruling (ข): EMBED_REQUIRE_SESSION_TOKEN default off; widget → anythingllm-embed submodule PR [→ #49]
- T-7 rulings: grants endpoint stays in #31; migrations → 070000/071000; frontend/src/models/system.js reserved for t7
- ledger-46 reconstructed by PMO from commit bodies (QA-2 confirmed content)
- RULE: main checkout is PMO-only; trial merges in detached /tmp worktrees (63beadd3 stray merge reset 2026-09-02)

## In flight (2026-09-02, after 1c6d9bd1)
- #30 slice 2 `4737f574`: gate PASS 1769/1769, Techlead-2 PASS (evidence committed). Waiting QA-1 + QA-2 → merge, keep #30 open for slice 3 (Dev4 recon; 2 TL-2 notes go to slice 3).
- #64 `b542deba`: title fix only; regate in /tmp/wt-64c (gate-64c.report). QA-1/QA-3/TL-1 PASS on code. Merge on gate PASS.
- #40 (Dev2): b55f0f4 has router-walk test; pending resolverName stamp + ORG_CAPS pin + MOCKUP_SHA from plan + bypass-4 fix (scopeOf must classify by resolverName, not catch). Gate task 1 with --no-contract + related tests (§7.14).
- O2 (Dev5): mockups A/B at `24951395`, QA-3 recommends B. **User must choose A/B** → task.sh start.
- S11 (Dev3): recon + 3 mockups at `031be4f5` (worktree s3-ldap). Dev3 recommends B. **User must choose A/B.** Invite-code leak into event_logs confirmed (inviteCode in ALLOWED_KEYS) → Dev3 opens bug issue first; QA-3 re-verifies.
- #70 (Dev1 SDD): implementer running.
14:24 main c79c5d2b: post-merge suite 1897 passed / 1933 (36 skipped)

- Opened: #71 invite-code leak (Dev3, spec = TL-2 5 holes), #72 unknown-key drop (Dev1, QA-3 5 amendments), #73 CI real-store services (Dev4). Slice 2 waits QA-2 only. #40 task1 waits FINDING-2 fix.
- #70 65dc3890: gate PASS 12/12 (/tmp/wt-70 kept). Waiting QA-1 + TL-1 verdict → close/merge. Then #72 (Dev1).
- #70 merged f6d3c851 (57/74 closed). #71 9119fcbd gating (/tmp/wt-71, full suite) — waits QA-3 + TL-1. Dev1 → #72 (typed unknown_keys, route-level 400).
- slice 2 merged a325e180 + pushed (origin was 51 behind → §7.16). #71 59e978b0 waits title fix (§7.3a) → regate 2-suite → close (QA-3 PASS, TL-1 PASS). #40 3d29de9 withdrawn (bypass 5) → WeakSet identity + dynamic bucket. #73 a42b3f0 needs rebase. #76 opened (sweep unsound, after #72). main suite: 1 fail ldapRoutesHttp → QA-3 triage. 58/76 closed.
- #77 opened (limiter env freeze, Dev3 after #71). #71 9da833d5 regate after checkignore. 58/77 closed.
- #71 merged c81fcb75e (59/77). #73 blocked on chroma image pin (TL-2). Dev1: manager forbidden-keys → new issue after #72.
- #78 opened (manager forbidden_keys 403, after #72 before #76). #77 reframed: limit read at request, windowMs frozen. 59/78.
- post-merge suite on main 387a6152 (after #71): 2081 passed / 2117, 36 skipped, 0 fail (ldapRoutesHttp green).
- #52 retro (TL-1): /v1 unswept but no ungated route; comment posted on #52. Fix via #40.
- #77 a004eee3: gate PASS 36/36 (/tmp/wt-77 kept). Waits ledger-77 + QA-3 + TL-1 → close/merge (incl. S11 mockup B fixes). #73 8beff79c9 gating (/tmp/wt-73), TL-2 verdict asked. #40 e875cd1 withdrawn (bypass 7) TL-1 accepted regex+guard; next SHA delta only. #72 pending hub_api_key regression fix. #74 Tasks 1-3 done, M11/OBS-1/2 pending SHA.
- #73 TL-2 PASS 8beff79c9; gate blocked only by §7.3a title → regate on next SHA. #77 regating 59f07e80 (ledger). 60/79.
- #77 merged df059c557 (61/79). S11 mockup B fixes in. Next: #73 title regate, #40 SHA (WeakSet guard + export list), #72, #74.
- S11 expiry recon merged 623269b1 (expiry in Invite.get). #73 4646ef8be gating (title fixed; earlier report stale). Post-#77 main suite running.
- #80 S11a opened (Dev3, backend half; no A/B needed). Ruling: verified-hash stored beside config, atomic. 61/80.
- post-merge suite on main d65973bc (after #77): 2085 passed / 2121, 36 skipped, 0 fail.
- #73 4646ef8be gate PASS 2123/2123 + TL-2 PASS; close waits ledger-73 from Dev4.
- #73 merged 0657de64e (62/80). Slice 3: partial retracted → 500 over cap; batch namespaceCount → backlog issue.

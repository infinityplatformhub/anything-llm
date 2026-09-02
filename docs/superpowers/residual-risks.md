# Residual risks — QA P0-1 (carry forward)
บันทึก 2026-09-02 จาก QA Opus P0-1 (หลัง 8 fixes ยังต้องตามต่อ):
1. [→ #28 T-6] DLP corpus scan (S6) ยังไม่มี findings-store/moderator-review seam ของตัวเอง — ตอน S6 track ห้าม invent เอง ให้เปิด contract เพิ่มผ่าน issue
2. [→ #30 T-5] policyVersion staleness undefined ใน 07 (driver รู้ได้ไงว่า stale, TTL เท่าไหร่) — จะโผล่ตอน P0-5
3. [→ #30 T-5] documentFilter cache invalidation ไม่มี event trigger ใน 10 — ผูกกับ fix #2 (ACL delta) ตอน implement
4. [→ backlog, unscheduled] ไม่มีกลไกบังคับ seams (prose-only) — เพิ่ม import-graph assertion เข้า test suite (มอบ P0-3/P0-6)
5. [→ backlog, unscheduled] Stage order ใน 03 เป็น prose — พิจารณา stage-slot enum ที่ constructor validate (มอบ P0-6 ตอน implement pipeline)

## เพิ่มรอบ re-review P0-1 (2026-09-02)
6. [→ backlog O1] Budget counters ผูกกับ license driver — เปลี่ยน license driver = migrate usage history ด้วย (มอบ O1)
7. [→ #31 T-7] explainAccess ต้องการ policy store reverse-queryable — เป็น hard requirement ของ P0-5 schema ไม่ใช่ optimization
8. [→ backlog S10] consumeBudget ต่อ chunk ไวต่อ latency — implement จริงใช้ batched delta + bounded overspend window (มอบ S10)
9. [→ backlog S4] Group→workspace/role onboarding mapping ของ S4 ยังไม่มี diagram ทดสอบ (listGroups รองรับแล้ว) — เพิ่ม diagram ตอน S4
- [→ #38] server/utils/modelPricing/index.test.js "fetches the remote pricing data and writes the disk cache" — etag "" vs "abc123" once in full run, isolated 41/41 (QA-1, T-2 verify on f7038595). Cause traced by Dev1: lazy getter + background refresh + singleton-on-require, NOT a shared cacheDir as first guessed. Did not recur across the three §2.5 runs at 190a5b88 — which does not close it; an intermittent failure that did not happen is not a fixed one.
- [→ #31 T-7] chat.read_others + access.diagnose stay in READ_ACTIONS (impersonated allowed). Re-decide when content_moderator role splits: admin without chat.read_others impersonating a user who has it = privilege borrowing. (QA-2, #20 round 2)
- [→ #25 T-4a, cap landed; /v1 half → #29] authorizeMany has no batch cap (0.176ms/resource linear). Cap 500 at any HTTP endpoint that exposes it.
~~[fold into #22] F-20d actorResolver checks revokedAt but not expiresAt on apiKeyContext; PR-3 filters upstream today. 1-line fix assigned to Dev4 in T-3.~~ (closed: T-3 f5bf914f)

- [reference, not a risk] contract cmd for future task.sh start: `sh -c 'cd server && yarn test 2>&1 | grep -E "Tests:" | grep -v failed; exit 0'` (a failing run yields no "passed" match)
~~[flake] engine.test.js + t1-authz-migration.test.js afterAll DROP DATABASE under default 5000ms hook timeout (beforeAll has 300_000). One-line fix: pass timeout to afterAll. Seen by dev-7 (#7) and PMO (#23 FAIL header with all tests passing). Fold into next P0-5 branch (#22).~~ (closed: T-3 f5bf914f)
- [closed: worktree reaped, 0 unmerged commits] stale worktree .claude/worktrees/p0-4d on approof/p0-4d-env-hygiene @ b5146345 holds unrelated P0-7 work; #7 uses approof/p0-4d-env-hygiene-a. Reap after confirming nothing unmerged.
- [→ #33] maskSecretValues is a name heuristic (8 words, 90/212 env keys, 0 mismatch today). Add guard test: every KEY_MAPPING entry must declare secret:true/false; fold into CredentialStore D(c). (QA-2 #7 interim)
- [→ #33] env keys outside protectedKeys are dropped on dumpENV — accepted pre-existing data loss; revisit at CredentialStore D(c).
- [closed: accepted by design, #7] parent-dir symlink (link/.env → real/.env) writes through by design; guard covers the leaf only. Requires write access to parent anyway. (QA-2)
- [→ #30 T-5] FilterCache.invalidateScopes with a lone "document:<id>" key evicts nothing; version stamp backstop rebuilds next call (perf loss, not correctness). Lock with a test when cache is wired. (QA-2)
- [closed in T-3 f5bf914f: afterAll 60_000 on engine/documentFilter/t1-authz] engine.test.js + t1-authz-migration.test.js afterAll DROP DATABASE race recurs under load from new HTTP suites; fix = afterAll timeout 300_000 (dropped from #7 branch; Dev4 asked to fold into #22).
- [→ #33] 30 URL-valued env keys (CHROMA/WEAVIATE/QDRANT/ZILLIZ/ASTRA/AZURE endpoints, *_BASE_PATH, AGENT_*_URL) can carry user:pass@ and are echoed verbatim by update-env. Fix: parse-URL mask (strip credentials, keep host) rather than more name regex. (QA-2, #7)
- [→ #29 T-4b] document_acl row principal_type=workspace principal_id="*" denies for every org-wide actor — usable as org-wide kill switch; anyone with ACL write can deny the whole org in one row. Writes go through requireActor gateway today; note the primitive. Replace "*" sentinel with orgWide:true (T-4b) and write the rule into seam 07 before T-5 wires drivers. (QA-2 #22)
- [closed: code-standards §7.0] Without DATABASE_URL (PG) + API_KEY_PEPPER≥32B, 6 suites fail at import time and count as failed, not skipped; Tests: line silently shrinks. Reviewers must export both. (code-standards §7.0)
- [closed: engines.node pinned >=22 <23 in all four package.json — e68fbadf + frontend 3caffef6] jsonwebtoken@9.0.2 fails to load on Node 26 (SlowBuffer); runtime path utils/http/index.js:4. Baseline is Node 22 (/opt/homebrew/opt/node@22). Must be answered before any CI/Docker moves to Node 26 — do not patch Buffer in tests. (Dev2, T-4a)
- [closed: PR-4b bound-key e8c624d4, #26] bound API key: GET /v1/workspaces lists all workspaces + thread names (metadata leak); POST /v1/workspace/new mints (resource exhaustion, minted ws unreadable by that key). Fix: filter by apiKeyContext.workspaceId; 403 on new. (QA-1 P1/P2, QA-2)
- [closed in PR-4b(3) 7ae3f3c6] validBrowserExtensionApiKey wrote scopes:["*"] into apiKeyContext → actorResolver minted a service Actor holding every scope for every extension request. Now EXTENSION_SCOPES (browser-extension.read/.write, document.write, workspace.read) and "*" rejected. Pre-merge history: any extension key was an all-scope service principal from PR-3 (016) until 7ae3f3c6.
- [closed: PR-4b bound-key e8c624d4, #26] upload/upload/:folderName/raw-text/upload-link accept body `addToWorkspaces` — bound key embeds into any workspace by slug (QA-2 E-1, pre-existing). Fix at Document.api.uploadToWorkspace call sites: 403 when slug ≠ bound workspace. Test needs CollectorApi.online()=true mock.
- [reference, not a risk] /v1/documents is a global namespace; per-actor scoping is documentFilter (T-3/T-5), not route binding. (QA-1)
- [→ #29 T-4b] resolveActorRef reads `actorRef.orgId ?? 1` from the job row — a forged enqueue row picks its own org. Single-org today; derive orgId from user row. (QA-1 T-4b interim)
- [→ #29 T-4b] validWorkspaceSlug/validWorkspaceAndThreadSlug are now pure loaders (no membership decision); every user must be preceded by requirePermission. T-4b must check /v1 W-9 sites for the same pattern. (Dev2)
- [→ #29 T-4b, fixed on branch, live on main until merge] cross-credential grant confusion: validBrowserExtensionApiKey wrote keyId from browser_extension_api_keys into apiKeyContext; resolver looked it up in api_keys → extension key N inherited grants of API key N's creator. Fixed via keyKind tag. Live on main until #29 merges. (Dev4)
- [→ #32] embed session UUID bearer-by-value; T-4b (#29) binds session→owner, #32 adds HMAC token.
- [→ #35 PR-4d] key-creation scope ceiling: PR-4c uses admin-gated presets (ponytail); PR-4d replaces with authorize() against creator grants + test non-admin cannot mint scopes it lacks. (Dev1 #27)
- [reference, not a risk — release note] PR-4c migration 045000 rewrites legacy `*` keys to 33 explicit scopes WITHOUT system.env.read — integrations calling GET /v1/system/env-dump with a legacy key break by design; api_key_legacy_wildcard_grants + boot report list them.
- [closed: code-standards §7.1a + check-db-push.sh, #29] regression.test.js + ssoIssuanceLockHttp.test.js build their DB with `prisma db push` (no migrations) → T-1 vocabulary/roles/grants absent in those suites; hidden until something read the policy store. Now seed.js + super_admin grant in fixture. Rule for code-standards §7.1: HTTP suites that boot the app must `migrate deploy`, not `db push`. (Dev4)
- [closed: #34 + code-standards §7.5 + check-locals-contract.sh] browser-extension check/disconnect had zero tests; 500 since PR-3 fcf09619 survived 895-green suites. Rule: every route touched by a middleware rewrite gets an HTTP test in the same PR. (QA-2)
- [→ #27 ops note] api_key_legacy_wildcard_grants is a new model — without `prisma generate`, reportLegacyWildcardGrants throws, is caught, and reports count=0 (looks like "no legacy keys"). Any gate/review run must generate first. Legacy rewrite set is a 33-scope SQL literal by design; scopes added later are not granted to legacy keys (boot report covers it).
- [→ #25 T-4a, CRITICAL, slot 044000 on branch] T-1 migration.sql:407-410 grants org-wide `member` (workspace_id NULL) to every manager/default user; org `member` role holds workspace.read/write + document.*; engine never reads workspace_users → once getWithUser bypass is removed (W-2), every user reads/writes every workspace. Hidden today only by the legacy model filter. Fix (ก): narrow org member role, workspace-scoped grants from workspace_users.role_id + runtime sync. (Dev2)
- [→ #28 T-6, DoD] Audit sink has no redaction: AuditEventSubscriber.handle stores event.data verbatim; only guard is models/user.js sensitiveFields=["password"] at one call site. No live route leaks today; any new field/call site would. Fix at sink with allowlist + PDPA pattern scan. (QA-1)
- [reference, not a risk] Runtime locals sweep after #34 (main 407ec344): 108 GET routes × 4 credentials = 432 calls, 0 locals-class 500s. Not covered: 186 mutating routes (needs per-route E2E fixtures, not a sweep). (QA-1)
- [→ backlog V1-b, not a bug] Thai chunks fill ~81% of chunkSize (U+200B markers counted at split, stripped after; ~1 per word). Under-fill, never over. ~20-25% more chunks for Thai vs English at same size. Fix if needed: custom length function on stripped text. (QA-2 #37 post-merge)
- [→ #39 hotfix] require cycle models/user → legacyRoleGrants → actorResolver → systemSettings → utils/http → models/user: SERVICE_PRINCIPALS undefined when actorResolver loads first → membership grant sync throws, caught, logged — new members silently ungranted. Prod safe today (index.js order). Fix: principals.js constant file. (QA-1 T-4a post-merge)
- [→ #33 part 3 prefix, fixing now] credentialStore: envKey/keyVersion not bound as GCM AAD → blob relocation across keys by a DB writer (no SIG_KEY needed). Table empty today; fix before first prod row. (QA-2 #33p2)
- [→ #40 frontend-authz] UI reads users.role (lossy projection of grants): default user with workspace editor grants gets sidebar hidden today; T-7 permissions have no role-string equivalent. Fix = capabilities endpoint + can(). (Techlead recon)
- [reference, not a risk] Ruling: DDL migrations need not be replay-safe (Prisma _prisma_migrations tracks); data migrations (04x000/045000) must be idempotent. (QA-1 #33p2)
- [closed: #39 d4fbe651] routeWiring.test.js depended on developer server/.env (STORAGE_DIR) — red on fresh worktree/CI; suite now mints its own temp dir like its siblings. (Dev1 found, Dev2 fixed)
- [closed: T-4b 800292ff — isConfirmedSingleUser reads users.count(), both reads fail closed] isMultiUserMode swallows DB errors → returns false → resolver treats as single-user → anonymous = super_admin when DB unreadable or multi_user_mode row missing. Fix: single-user only if users.count()===0; unreadable → multi-user/deny. (QA-2 T-4b)
- [→ #41] 7 /v1/document routes give bound keys cross-tenant disk storage access; carve-out comment overclaims. (QA-1 T-4b)
- [→ #40 frontend-authz / UX] Login form shows nothing on 429 from /api/request-token (rate limit #6, 5/window) — user just stays on /login. Found by E2E #15. (Dev3)
- [→ #45] apiKeyContext without keyKind defaults to api_keys branch (latent; only ingress today is tagged). Make keyKind required, resolver fails closed. (QA-2 T-4b)
- [→ #46 hotfix] validatedRequest.js:9-24 same fail-open class as T-4b FINDING-1 (isMultiUserMode false on DB error → single-user → next() in dev/no AUTH_TOKEN). Pre-existing. Use isConfirmedSingleUser. (QA-1)
- [→ #45 companion] job queue is a second identity surface: a job row with actorRef {service, single-user} resolves without evidence check (isConfirmedSingleUser guards ingress only). DB writer == already privileged; note, not exploit. (QA-2 T-4b)
- [reference, not a risk — code-standards §7.8] after T-4b, tests touching authorization/grants (single-user R5, pr4aScopeHttp grant half, etc.) read live DB state — a reused DB with leftover rows makes them red. Gate on a fresh DB. (QA-2)
- [→ needs issue, upstream infi-skills] task.sh gate_commented_code misreads JS private fields (`this.#x`) as comments: 59 lines / 16 files latent under server/. Fix upstream: ignore `#` preceded by `.`. (Techlead §7.3)
- [reference, not a risk — release note, #33 part 3] Secrets migrate .env → CredentialStore lazily on next save (061000 no-op). Fresh container without .env volume loses unsaved credentials. SIG_KEY/SIG_SALT stay in .env by design.
- [reference, not a risk — runbook] /v1 routes return 403 (not 503) when the policy store is down — by design (which half rejected is audit detail). Operators must read auth.key_used.denyReason, not the status code. (QA-2 W-8 under failure, 7/7 fail-closed)
- [closed: code-standards §7.7] Tests needing a usable admin must create via User model, not raw prisma (no grant otherwise → 403 on update-env). (QA-2)
- [→ #47 flake] modelPricing/cacheIsolation.test.js (added by #38) fails ~1/5 on clean main — unawaited constructor refresh race. Two independent reports. Blocks §2.5 three-run until fixed.
- [→ #48] Stored credential cannot be cleared via updateENV: value validators reject "" before the delete branch runs; row stays decryptable. Needs explicit clear endpoint. (QA-1 #33p3 post-merge)
- [→ #49] Embed widget must return x-allm-session-token; until it lands EMBED_REQUIRE_SESSION_TOKEN stays off on every deployment (#32 carve-out)
- [→ backlog] require cycle actorResolver→systemSettings→utils/http→models/user still present after #39 (principals.js leaf fixed only SERVICE_PRINCIPALS); isConfirmedSingleUser catch should console.error (QA-2 #46)
- [→ backlog] EMBED_REQUIRE_SESSION_TOKEN and EMBED_REQUIRE_ALLOWLIST are presence-based (repo convention, 9 sites): fix .env.example to `# X=1  # any value enables`, do not change code (#32 NIT-1, Techlead).
- [→ backlog] regression.test.js "does not expose password in login response" flaked once in 4 runs at ee4be889 (QA-1); watch for recurrence.
- [→ backlog] parseRetentionDays (server/utils/retention/purge.js:30) tests regex after trim: " 7 " and "07
" accepted as 7; fix compare raw before trim + /^[1-9]\d*$/ (QA-2 post-merge probe, low, not fail-open)
- [→ backlog] embed sessionId is client-chosen UUIDv4: two concurrent first requests with the same id can both mint a token; closing it needs server-minted session ids (widget contract change) (#32 fix review)
- [→ #49] #32 mint rule ("no embed_chats row" or valid token) leaves 4 holes (Techlead design check): (1) pre-first-message window is seconds (row written after LLM reply); (2) two concurrent first requests both mint (no unique on embed_chats.session_id, no tx); (3) history delete / embed cascade empties rows and re-opens minting; (4) mint-vs-verify response difference is a session-existence oracle. Flag EMBED_REQUIRE_SESSION_TOKEN stays OFF until #49 lands server-minted sessionId+token at POST /embed/:embedId/session and stream-chat requires a verified token unconditionally.
- [→ #49] #32 NIT-3 embed_id scoping in mintIfEntitled has no test (drop it → cross-tenant mint DoS); NIT-4 embedHistoryRateLimit wiring on stream-chat has no test (QA-1)
- [→ #36 follow-up] OIDC discovery cached for process lifetime (no TTL); IdP changing jwks_uri needs restart (Techlead S1 review)
- [→ #57] providerDocIdCallSites.test.js 5s hook timeout flakes under parallel load (C-1, #28); raise hook timeout or isolate (QA-2)
- [→ #52] view-as-user mutation via engine-less routes (POST /system/user, /onboarding) — LIVE on main until hotfix merges; MAJOR-2 setup_admin cannot delegate (QA-1 T-7 baseline)
- [→ #52] 24 engine-less mutating routes rely on handler-level isSingleUserMode/multiUserMode checks (scheduled-jobs, telegram, outlook, update-password, api-key): safe only in one mode; sweep test allowlist must assert the check (QA-2)
- [→ backlog] BrowserExtensionApiKey.create bypasses scope ceiling; any role gaining browser-extension.write could mint document.write credentials without holding it (QA-1 #35 NIT-2)
- [→ backlog] #35 empty-trim branch has no test reaching it (fixture dies at key.manage first); use key.manage-only principal, assert /nothing to mint/ (QA-1 NIT-1)
- [→ #55] agent generated-files have no owner row; any principal with a valid uuid reads any tenant's file; #41 blocks bound keys only (Dev1)
- [→ #53] view-as-user cannot GET /workspaces, search, or agent files (chat.send is a membership proxy denied by R5); #52 kept the 044000 wall instead of seeding workspace.read to member (Dev2 measured org-wide grant matches every workspace)
- [→ backlog] grantRole/revokeGrant return policyVersion as BigInt; JSON.stringify throws for new callers (routes String() it) (QA-1 #52 NIT-2)
- [→ #52] isSingleUserMode (deploymentMode.js) read raw setting, diverging from isConfirmedSingleUser; on multi_user_mode=false + user rows 3 config routes were writable by impersonated sessions (QA-2). Fixed in #52 addendum 7; pattern: every 'which mode am I in' question must go through isConfirmedSingleUser
- [→ #52] telegram.js and scheduledJobs.js have no requirePermission at all; isSingleUserMode is their only gate (23 sites). After #52 they follow isConfirmedSingleUser; a proper action gate is still owed (QA-1)
- [→ #58] raw isMultiUserMode readers in auth paths: extension suspended bypass on shape (b), validApiKey locals, request-token mints dead token, websocket tool toggle (QA-2 sweep 121 sites)
- [reference, not a risk] worktrees share server/node_modules via symlink (h52→t7, pr41/pr4d→pr4b); run ./node_modules/.bin/prisma generate before direct jest/node in any worktree (§7.6)
- [→ #43 follow-up] usernameFromEmail collapses distinct emails into one username; collisions hit users.username unique instead of R1 → unrelated user locked out with opaque 401; also strips leading non-ASCII/digits. Fix: R1 compares derived username too, or suffix retry (QA-1 S1 NIT-1). S2 inherits the helper.
- [→ backlog] suites relying on users.count()===0 (apiKeys.postgres, actorResolver R5) break on any shared-DB user row; give them their own DB like other integration suites (QA-1, seen 3×)
- [→ #50] simpleSSOEnabled.js fails open on shape (b); resolved when #50 removes issuance half and the remainder uses isConfirmedSingleUser (#58 ledger E)
- [→ backlog] #41 boundDocpaths catch→new Set() has no test; flipping to null = allow-all silently (QA-1 NIT-1); storedNameFor readdirSync per resolve (NIT-2)

- **simpleSSOEnabled.js fallback reads raw `multi_user_mode`** when `res.locals.multiUserMode` is unset (route mounted without `validatedRequest`). No such route today; drift point only. Found by QA-2 on #58 953e108a. `[→ backlog]`

- **ruling A (`validApiKey.js:111`) has no test** — QA-1 mutation M5 survived on #58; code verified correct by probe. Add test in approof/58-followup. `[→ #58 follow-up]`
- **`websocket.js:17` `userCanToggleTools` bypasses engine in shape (b)** until reboot repairs it (QA-1 D1/D2 on #58). Deferred per ruling D. `[→ backlog]`
- **chroma has no escape clause for unlabelled rows** (no `$exists`); `RETRIEVAL_FILTER_ALLOW_UNPROVABLE` is inert there and logged as such at boot. Unbackfilled chroma deployments get empty retrieval until #56. `[→ #56]`
- **LanceDB `table.add()` silently drops fields not in the Arrow schema** — pre-T-5 tables never gain ACL metadata through normal ingest; unlabelled population grows after T-5 ships. Backfill must migrate/rewrite the schema, not update rows. Found by Techlead on #30 05e18e79. `[→ #56]`
- **pre-T-5 LanceDB tables have no ACL column at all** — any predicate naming `orgId` throws; slice 1a handles via schema check (ruling B). `[→ #30 1a]`
- **`validatedRequest` passthrough when AUTH_TOKEN/JWT_SECRET unset** is reachable in production via `update-password usePassword:false` and (before the #48 denylist) via credential clear. #48 blocks the new path only. Separate issue to open by Dev1. `[→ new issue]`
- **`SSO_ACS_URL` vs `SSO_CALLBACK_BASE_URL` not canonical across saml.js / identity.js** — setting only SSO_ACS_URL leaves OIDC on Host fallback without warning. Techlead NOTE-A on #43 4765dbae. `[→ backlog]`
- **Flag set + legacy LanceDB table + actor with allow/deny list serves every legacy row** (unlabelled rows have no docId to check). Per rulings B/C; no production caller passes allowedDocumentIds today. #56 must backfill before the embed path sends allow-lists. Techlead-2 on #30 1a. `[→ #56]`
- **Milvus predicate rendered but never executed in tests** — same bug class as LanceDB backtick / pgvector placeholder. Real-store test or "unverified" label required in 1b. `[→ #30 1b]`
- **Milvus real-store test skips without `MILVUS_TEST_ADDRESS`** — CI must set it or the parser regression (§7.12) is unguarded there. Dev4 #30 1b. `[→ O2/CI backlog]`
- **`chat.read` not granted to any workspace role or org member on main** — regular users 404 on own chat history (4 routes). Found by Dev5 on #61. Hotfix #63 (slot 101000). `[→ #63]`
- **Breaking: `/v1` chat listings now require `chat.read_others`** — `GET /v1/workspace/:slug/chats`, its thread twin, and `POST /v1/admin/workspace-chats` return every user's chats and so declare `chat.read_others` as of #64. An existing API key whose creator holds only `chat.read` receives 403 where it previously received 200. Chosen over filtering to the key's creator, which would return an empty list — a wrong answer the caller cannot distinguish from an empty workspace. Operators upgrading must grant `chat.read_others` to the creator of any key that reads chats. `[→ #64]`
- **Weaviate classes created before T-5 cannot gain `indexNullState`** (schema update rejected) — escape clause unavailable; re-embed (class recreate) required. #56 must include a Weaviate class-recreate path. Dev4/Techlead-2 on #30 1b. `[→ #56]`
- **pinecone/astra predicate renderers never executed against a real store** (hosted-only) — `$exists:false` escape clause and deny-list unverified. Boot report must not call them supported. Techlead-2 on #30 1b. `[→ #30 residual / O2 CI]`
- **`policy_versions` rows carry no origin** — T-1 backfill and later migrations all write `(grant, org:1)`, so a migration-only test cannot assert its own bump. Dev5 on #61. `[→ backlog]`
- **Raw prisma writes to document_acl bypass the version bump** — `grantDocumentAcl`/`revokeDocumentAcl` (policyRepository) are the only correct paths; filter cache stays stale otherwise. Staleness test + model comment in slice 2. `[→ #30 slice 2]`
- **`chat.read` is now a dead API scope** (no route declares it after #64) but migration 045000 backfilled legacy wildcard keys with it; harmless, confusing in audit; minting a NEW key with `chat.read` now fails validateScopes (400) while existing keys still resolve. QA-1/Techlead-1 on #64. `[→ backlog]`
- **pg_trgm produces zero trigrams for Thai under `lc_ctype=C`** (initdb default) — chat search full-scans silently for the product's primary language. #61 adds detection (migration warning + boot error); O2 installer must create the DB with a UTF-8 locale. QA-3 on #61. `[→ #61 detect / O2 enforce]`
- **Embed principal never granted** — every embed widget retrieves nothing (matchNone); fail-closed availability bug, predates slice 2. QA-2 on #30 s2. `[→ new issue]`
- **Scan test for response_text derivation uses a 600-char window from the prisma call** — upsert-shaped writes (payload built above the call) escape it; behaviour tests still cover today's 4 paths. Techlead-1 on #61. `[→ backlog]`
- **`WorkspaceChats.upsert` returns `{chat: undefined}`** (destructures a bare row); sole caller ignores it. QA-3 on #61. `[→ backlog]`
- **`OutlookBridge.updateConfig`'s own return is ignored by its three callers** — `outlook/lib.js:669` and `:742` (token refresh) and `endpoints/utils/outlookAgentUtils.js:70`. #70 made `updateConfig` report a failed settings write truthfully, but at `:669` the very next lines set `this.#accessToken` and `return {success:true}` regardless, so a refresh that could not persist the new token still reports success and the process keeps a token the database does not have. Gmail and Google Calendar have no such callers today. The #70 sweep greps `SystemSettings.updateSettings` and cannot see this layer — a second hop would need its own scan. TL-1 on #70 65dc3890. `[→ #72 or new issue]`

- **pinecone/astra ship UNVERIFIED — PMO decision, not an oversight.** Their renderers are unit-tested and have never been executed against a real engine (hosted-only, no local instance). Five providers shipped predicates that read correctly and were rejected by their engine on first contact — LanceDB identifier quoting, pgvector placeholder numbering, Milvus operator precedence, Qdrant `is_null` semantics, Weaviate tokenization. The boot report warns per deployment and must never call these two supported. Ruling: ship with the warning rather than block #30, recorded here and on the issue so it reads as a decision someone made. Dev4/PMO on #30 slice 3. `[→ #30 residual]`
- **CI has never executed a real-store suite.** `.github/workflows/ci.yml` sets only `DATABASE_URL` and `API_KEY_PEPPER`, so `MILVUS_TEST_ADDRESS`/`QDRANT_TEST_URL`/`WEAVIATE_TEST_URL`/`CHROMA_TEST_ADDRESS` are unset and all four `describeIf*` guards resolve to `describe.skip`. CI is therefore green without ever running the tests that caught five of this issue's bugs — a gate that has never been red is a gate not yet shown to stop anything. Until a separate CI issue adds the services, these suites are dev/QA-run only and QA-2's evidence stands in for CI. Dev4/PMO on #30 slice 3. `[→ new issue: CI services]`

- **ldapRoutesHttp flake (2026-09-02)**: post-merge gate on f6d3c851 saw 1 test red in `__tests__/security/identity/ldapRoutesHttp.test.js`; test name not captured (log grep dropped it). 2 full in-band runs + 3 targeted runs on a325e180 did not reproduce. Structural defect found during investigation → #77 (limiter freezes env at module load). **#77 is NOT a confirmed root cause** — if the symptom returns after #77 lands, treat as new.

## #80 S11 — settings write ไม่ atomic ข้ามสองตาราง
`_updateSettings` = `Promise.all` upsert อิสระ ไม่มี `$transaction`; secret ไป `credential_store` คนละ path. partial write เป็นไปได้เมื่อ DB ล้มกลางทาง. #80 ลด blast radius ด้วย gate ปฏิเสธก่อนเขียนทั้งคู่ + `process.env` set หลัง persist สำเร็จ แต่ไม่แก้ atomicity. debt แยก (พบโดย Techlead-1, `techlead-80-preread.md` finding 2)

## O2a (#74) — the doctor cannot be fully exercised on a developer's machine
(written by Dev5, committed by PMO)

Three of the doctor's branches need a database that is *missing* something the machine running the test already has:
- `ext.available` failing needs a server that does not ship an extension. Driven through exported `checkExtensions` with a made-up extension name instead of `runChecks`.
- `ext.permitted`'s probing branch only runs for an extension available but not yet installed. On a migrated DB `pg_trgm` is already there. Test asserts the property that holds on any server (whatever was probed, detail says it was rolled back).
- `db.version` below the floor needs PostgreSQL 15. Pinned as a number (`MIN_SERVER_VERSION_NUM === 160000`) plus comparisons.

Why written down: SHA `3165b913a` passed a full green gate on Dev5's machine (pgvector installed) while failing on TL-2's stock `postgres:16`. §7.1c one level out — a fresh database is not enough when the *server's* capabilities differ.

What would close it: a CI job running `__tests__/scripts/doctor.test.js` against stock `postgres:16` (`.github/workflows/ci.yml:16`). Not done in #74 (scope = installer, not CI matrix).

Until then: any change to `utils/doctor/index.js` touching required extensions or the version floor must be reviewed by someone whose database does *not* match the author's.

## O2a (#74) — getVectorDbClass switches on the raw string
`utils/helpers/index.js:88` compares `VECTOR_DB` raw; `PGVECTOR`/` pgvector ` silently fall back to LanceDB. Doctor now blocks boot on such spellings (c0c6472b0), so the app never reaches that fallback under doctor — but any boot path that skips doctor still does. Fix = normalize in `getVectorDbClass` (separate issue). TL-2 notes: M3 (`ext.permitted` forced ok) survives because test harness is superuser — closing needs a low-privilege role in-test; M10 (backup notice) needs `toContain("BACK THESE UP")` on the happy path.

## #87 — provider `connect()` guards still compare VECTOR_DB raw
7 of 10 providers guard `connect()` with `process.env.VECTOR_DB !== "<name>"`; `CHROMA` now resolves to Chroma but throws "Invalid ENV settings" at connect, while `PGVECTOR` works. Fail-closed with a named error (better than the old silent LanceDB fallback) but inconsistent. Follow-up: route those guards through `normalizeVectorDbKey`. Option ค (throw on unknown) after one release of warnings. (TL-2 evidence techlead2-87-e6908fd54.md)

## #30 slice 3 — scope-before-store is a stated rule, not an asserted one
`scopedNamespaceCount` refuses before querying the store, but `cardinalityScope.test.js` only asserts return values; TL-2 mutant moving the scope check after `namespaceCount` stays 102/102 green (timing channel). Fix = spy `namespaceCount` + `not.toHaveBeenCalled()` on out-of-scope / match-none / unknown slug (docs follow-up with resolveActor arity throw).

## #88 — telemetry labels read VECTOR_DB raw (8 sites in endpoints/)
Data-quality only: `Chroma` vs `chroma` split aggregate counts. None selects a provider or gates anything. `endpoints/utils.js:25` is a metrics response (operator sees own spelling — arguably preferable). No test drives `connect()` to success (needs live engines in CI).

## #90 O5a — counters read zero until O5a-wire lands
All 5 counters are declared with an enforced vocabulary but no call site calls `observe()` yet. A dashboard wired now shows flat lines that look like "endpoint broken". `observe()` throws on vocabulary violation — fine while every call site passes literals; becomes a liveness question if a label is ever computed. `doctor.test.js` needs a pgvector-capable DB (1 red on stock postgres:16) — dependency not visible from the suite name.

## flake: liveSyncWriteFailure (#97)
Red once in full --runInBand run after #40 task 1 merge; green alone. Ordering dependency unknown. Owner: Dev1 after #91.

## #91 residuals
- credentialClearHttp premise guard now pins #91 status mapping (500); a revert of #91 shows as a #48 test failure.
- enable-multi-user drops updateENV return → #104.

## #94 residuals (O5b bundle)
- PG_USER_PHRASE redacts the quoted token after user/role/for user in any prose (e.g. `the user "guide"`); no live doctor string affected today.
- Unquoted usernames rewritten by proxies/poolers are not covered; pg always quotes.
- 14-digit ids (migration names) redacted as credit_card → #101.
- collectDatabase strip vs URL_CREDENTIALS overlap; strip only load-bearing for non-parsable full-mask.

## #49 residuals (embed session)
- Rate-limit key is IP only; one caller's budget spans every embed it touches (self-inflicted, not cross-tenant).
- EMBED_REQUIRE_ALLOWLIST presence-flag has no test (boolean-parse "fix" would fail open on =false).
- malformed vs expired both 401; equality not pinned (embedMiddleware.js:329).
- Old tokens invalid at deploy; flag default off so impact = one missed rotation.

## #40 task 2 residuals
- Workspace half is membership-scoped, not grant-scoped (org-wide grant without membership → null, intended).
- Non-numeric id answers without a query (0 vs 1 query timing) — non-goal.
- workspaces has no orgId column; tenant isolation rests on membership; orgId from actor.

## #102 residuals
- safeObserve swallows in tests too; a call site passing a forbidden label goes silent, not red (NIT: spy console.warn).
- chats_total source assert covers one wrapper (NIT: behavioural reject→+0 for both).

## #96 residuals (group grants)
- group_members writes do not bump policy version → documentFilter cache stale up to 30s (removed member keeps access) — S4a #113 owns the fix.
- A creator holding system.write only via group can now mint system.write API keys (ceiling asks engine).
- groupIdsFor user-type guard is redundant for today's id shapes (G6); kept as NaN barrier for future numeric non-user principals.
- Invariant: group expansion widens a key's deny, never its allow.

## #104 residuals
- update-password rotates AUTH_TOKEN + JWT_SECRET without rollback → #116.
- A future postUpdate hook on a secret key would run after a failed persist (none today).
- newValues key removal cannot suppress audit rows today (mapping has no secret keys).
- process.env keeps the value on failed persist by design: live until restart, error names the key.

## #108 residuals (S11b)
- Delivery log (mockup B step 3) deferred to #107.
- #115 hydrate window: GET /mailer/settings reports hasPassword:false right after boot; admin who retypes overwrites a working credential.
- Test gaps: hostile-GET password render; main.jsx route-guard assert (next Dev4 SHA).

## #112 residuals (O2b)
- Fresh install with DB unreachable → preflight 403 by design (isConfirmedSingleUser fails closed); operator uses CLI doctor.
- preUserOrGated catch block is unreachable (helper never throws) — comment or remove.
- Synthetic check id in level test is load-bearing; do not "tidy" to a real id.
- GET /setup-complete neighbour still unauth → #114.

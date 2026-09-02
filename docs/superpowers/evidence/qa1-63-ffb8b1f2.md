# QA-1 evidence — #63 ffb8b1f2 — PASS (1 NIT)

Author: QA-1 (anything-llm-af), transcribed by PMO. Own worktree, gate 1596/1596 (152 suites).

DB after migrate: chat.read holders = super_admin(org), owner/editor/viewer(ws); org member absent.
Session routes: owner/editor/viewer 200 on /chats with own history only; thread route 200 only for own thread, 404 for others'; super_admin outsider 200 empty; org-member outsider 404 (premise: holds org member grant); content_moderator outsider 404; no auth 401.
Engine: owner/editor chat.read=true, read_others=false; content_moderator inverse. /v1 twins: key with chat.read 200, without 403.
Mutations (15/15 baseline): M2 org member back → 4 fail; M3 read_others instead → 4 fail; M6 seed org member → 2 fail. Survived: M1 drop viewer from migration only (seed overwrites → test asserts seed, not migration); M4 drop policy_versions bump; M5 seed owner loss.

## NIT-1 (non-blocking) migration not independently tested
Suite runs migrate + seed; seeder rewrites role_permissions so a broken migration is masked. Add a migrate-only test (pattern: ssoIssueRetirement.test.js).

## Observation (pre-existing, → new issue)
`GET /v1/workspace/:slug/chats` returns every user's chats in the workspace (no user filter) — `chat.read` on /v1 behaves like `chat.read_others` on session routes.

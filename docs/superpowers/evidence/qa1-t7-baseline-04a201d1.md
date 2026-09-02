# QA-1 T-7 baseline — 04a201d1 (2026-09-02) — FAIL, hotfix issued post-merge
BLOCKER-1: impersonated session POST /system/user → 200, victim username changed; POST /onboarding → 200. Routes with validatedRequest but no requirePermission never reach the engine blanket deny. 6 such mutating routes; 4 are single-user-only (401 in multi-user).
MAJOR-2: escalation guard set-subset refuses setup_admin → member/content_moderator (member holds chat.send). role.grant on setup_admin unusable.
PASS: inTransaction 5/5 + revoke guard; grant_revocations in same tx; service/system principals 400; two guards distinct; impersonation via engine denies all writes; D-2 AND; D-1 kill switch removed; explainAccess fail-closed. 1168/1168.
NIT-1 PRINCIPAL_EXISTS prototype keys; NIT-2 BigInt policyVersion. Env: stale .prisma client in t7 worktree needs prisma generate before direct node/jest.

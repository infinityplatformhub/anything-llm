# QA-1 #52 hotfix review — cf0b6af2 (2026-09-02) — PASS
BLOCKER-1 closed: impersonated POST /system/user 403, username/password unchanged in DB; /web-push/subscribe 403; /onboarding 403. Positive: real admin 200/201; view-as-user mint 200; my-capabilities 200; explainAccess 404.
MAJOR-2 closed: setup_admin→member allowed; →content_moderator/super_admin refused; BASELINE_GRANTABLE constant, no seed.
New gates: /admin/workspaces member 403 (user.manage); onboarding/enable-multi-user member 403. workspace.read seed withdrawn (would reopen 044000). Impersonated GET /workspaces / search → 403 not 500.
Sweep from app._router.stack. Mutation: remove requireSelfSession → 3 failed. NIT-1 closed. NIT-2 (BigInt policyVersion) open → residual. 1209/1209.

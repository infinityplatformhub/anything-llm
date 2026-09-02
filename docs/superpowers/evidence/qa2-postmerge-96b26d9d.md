# QA-2 post-merge probe — main 96b26d9d (2026-09-02)
Fresh DB, migrate deploy: Test Suites 104/104, Tests 1108/1108.
#39 PASS: legacyRoleGrants throws (no try/catch); JobRuntime two imports; membership+grant roll back together (T1-T4, orphan=0); baseline at merge-base 5e0ad5eb showed membership=1 grants=0. Cycle actorResolver→systemSettings→utils/http→models/user→legacyRoleGrants remains (residual).
#28B PASS: deletes only via deleteAuditEvents (1 call/batch), batching correct, cutoff computed once, window honored. Low finding: parseRetentionDays accepts trimmed " 7 " / "07\n" (residual).

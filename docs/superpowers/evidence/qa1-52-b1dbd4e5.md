# QA-1 #52 final — b1dbd4e5 (2026-09-02) — PASS
Addendum 7 GREEN: 3 routes 401 on shape (b) with impersonated AND plain token; true single-user 0 users still 401 from validatedRequest. Harness 12 no regress. 1219/1219.
Machine hazard: worktrees h52→t7, pr41/pr4d→pr4b share server/node_modules by symlink; prisma generate in one silently mis-schemas the other (yarn test regenerates, direct jest does not).

# Recon hotfix: validatedRequest.js single-user branch trusts isMultiUserMode() (same class as T-4b FINDING-1)
- utils/middleware/validatedRequest.js:9-24 reads SystemSettings.isMultiUserMode() directly; a swallowed DB error → false → single-user branch → with NODE_ENV=development or missing AUTH_TOKEN/JWT_SECRET it next()s without any check. Pre-existing (identical on main), not a T-4b regression.
- Fix: use the same `isConfirmedSingleUser` (setting says single-user AND users.count()===0, any read failure → not confirmed) exported from actorResolver/principals; when not confirmed and no valid JWT → 401. Never next() on unreadable state.
- RED: mock isMultiUserMode throw + 3 users → request without JWT → 401 (today: passes in dev / no AUTH_TOKEN). Single-user real (0 users) unchanged.
- Owner Dev4 after #29 merges (owns resolver export). Tiny diff, separate branch.

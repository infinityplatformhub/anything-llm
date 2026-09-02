# QA-1 — #138 driver half — pre-fix baseline on main (written by PMO from QA-1's body)
Harness /tmp/qa138/ (accept-then-silent server + probe, QA138_ROOT). Baseline on main:
A page silent, token answers → HUNG >20s (token 1, page 1) · B token silent → HUNG >20s (page 0) · D Retry-After 86400 → HUNG (second page fetch silent under first config; will serve every page on SHA) · C caller 1s signal → rejects 2506ms today (inherited; load-bearing only paired with "driver 10s wins over never-firing caller").
Corrections for fixtures: floor is timeout + backoff, NOT maxRetries × timeout (a silent socket stalls attempt 0; loop never iterates). B asserts page hits = 0. `_tenantAccessToken` memoised via _tokenExpiresAt → fresh provider per case or the second call is green regardless.
Assertions on SHA: A/B ceiling <20s + floor >timeoutMs; B page hits 0; D completes under clamp ceiling and above clamp floor (clamp 0 must fail); C both directions.
Mutants: 1 remove AbortSignal.timeout → A+B hang; 2 bind _page only → B hangs, A green; 3 remove clamp → D hung; 4 drop AbortSignal.any → C first half red; 5 clamp 0 → D no wait. If 1 and 2 red the same set, the token path has no fixture.

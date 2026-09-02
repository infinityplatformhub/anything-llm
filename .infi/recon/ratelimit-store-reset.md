# Recon: rate-limiter BoundedMemoryStore leaks across test suites (flake F-19b)
- File: server/utils/middleware/requestControls.js — every limiter does `new BoundedMemoryStore()` at module load = singleton per process
- Impact: server/__tests__/api/regression.test.js, envDumpGuardHttp.test.js, ssoIssuanceLockHttp.test.js all `require("../index")` in one process under --runInBand (same pid in schema names) → `regression › locks repeated login attempts` gets 501/404 instead of 429 in ~2/3 full runs
- Fix: export `resetRequestControls()` from requestControls.js calling `store.resetAll()` (exists, line ~51) on every limiter; call in beforeAll of the 3 suites. NOT jest.resetModules (re-boots express app)
- Proof: requestControls.test.js — hit /api/request-token until 429 → resetRequestControls() → next hit = 401 not 429; full suite 3 runs 0 flake
- Type: bug · no runtime behavior change in prod

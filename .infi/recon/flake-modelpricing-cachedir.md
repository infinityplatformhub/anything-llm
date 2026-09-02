# Recon: modelPricing/index.test.js etag flake — shared temp cacheDir across suites
- Symptom: "fetches the remote pricing data and writes the disk cache" gets etag "" vs "abc123" once in a full run; isolated 41/41. Seen by QA-1 during T-2 verify and in §2.5 baseline notes.
- Cause (likely): cacheDir path shared between suites under --runInBand; another suite writes/clears the same file.
- Fix: per-test tmpdir via fs.mkdtempSync in beforeEach; inject cacheDir into the module (option or env) instead of a module-level constant. No prod behavior change.
- DoD: full suite 3× with 0 flake; test asserts cacheDir is unique per test.

## CORRECTION (Dev1, probe-proven) — original cause above is wrong
- index.test.js already mkdtemps per test. Real cause: (1) CACHE_FILES lazy getter resolves STORAGE_DIR at WRITE time; (2) constructor fires background #refresh() nobody awaits; (3) bare `require` builds the singleton (index.js:332) — 9 suites import it without setting STORAGE_DIR. A refresh started under suite A's dir finishes after suite B moved STORAGE_DIR → B's .etag overwritten.
- Fix: capture cacheDir/cacheFiles once at construction + `{ cacheDir }` option. Singleton at :332 kept (prod behavior, out of scope) — ledgered.

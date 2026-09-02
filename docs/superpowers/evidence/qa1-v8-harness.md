# QA-1 — V8 static harness staged (/tmp/qav8/scan.mjs) — reproduces contract numbers on main (written by PMO from QA-1's body)
scannedFileCount 602 · ternary 52 + bare 1 (LoadingChat) = 53 · residual measured 24 == listed 24, both directions empty · md:my-[16px] carriers 56 · react-device-detect importers 52 (post-slice expectation 6, compared as a set).
Three harness bugs, each a plausible wrong number: (1) import lines counted as sites → residual 131; (2) block-comment stripping merged lines → every site off by N → 68 present-not-listed / 13 listed-not-present phantoms (fix: replace comment chars with spaces, keep newlines); (3) residual compared ALL uses instead of what survives (ก)+(ข) → 55 spurious. 
Asserts: F4 counts → 0 AND scannedFileCount == 602; F4 pairing every converted site carries md:my-[16px] on the same line; F5 two named lists; F8 importer set == six named.
RF-9 needs vitest with matchMedia and react-device-detect mocked INDEPENDENTLY; mutant keep-isMobile must red exactly the two conflicting fixtures. Blocked on Dev4's hook.
Mockup note: LoadingChat is the one of 53 whose conversion CHANGES behaviour (32px short today) — a fix, not a refactor.

## RF-9 runtime skeleton (08:05) — /tmp/qav8/rf9/viewportRF9.test.jsx
Baseline on main (isMobile): 3 pass / 4 fail = RF-9a (500+desktop UA → renders desktop), RF-9b (900+mobile UA → renders mobile), F1 (matchMedia change without resize does not flip), F1b (no listener registered). Positive control: simulated useSyncExternalStore + matchMedia("(max-width: 767px)") hook → 7/7. "keep isMobile" mutant returns exactly this red set.
Mocks independent: react-device-detect via hoisted getter (module-load resolution); matchMedia parses the query (max-/min-width) with a mutable width; two positive tree markers so "neither" ≠ "the other".
Three harness bugs caught by the positive control: F1b satisfied by 0→0; emitChange outside act(); matchMedia factory closed over stale width.
rf2b folded: exact delta (PARTIAL+N, catches MB 18 vs 16) AND group_members end state, limits stated.

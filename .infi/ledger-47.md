# Ledger — issue 47, cacheIsolation.test.js flake

This is my own defect, introduced by the file I wrote to prove the defect exists.

`cacheIsolation.test.js` came from #38, whose second finding was: `jest.resetModules()` followed by `require` reconstructs the module-level `MODEL_PRICING` singleton, which starts a refresh nobody awaits, and that write lands later in whatever directory it was pointed at. I fixed that in `index.test.js` — and then wrote `instanceIn()` in the new file with exactly the same shape: require, discard the singleton, return a fresh instance, never touch the abandoned `bootRefresh`. Three tests, each calling `instanceIn` one to two times, each leaving a write in flight.

Ruling: fixed the same way as `index.test.js` — `instanceIn` captures `MODEL_PRICING.bootRefresh` before discarding the singleton, and `settleAbandoned()` awaits them. Called at every point an assertion follows a construction, and in `afterEach` before the temp directories are removed: an unsettled write into a directory that is being deleted is a second failure mode, quieter than the first.

Ruling: `settleAbandoned` swallows rejections (`p?.catch(() => {})`). These refreshes are abandoned by definition — the test never wanted their result, and a rejected one failing the test would report a fetch the test did not ask for.

Ruling: verified with 40 consecutive runs of the file alone rather than the full suite. The reported rate is roughly 1 in 5, so 40 runs is about eight expected failures if unfixed — a sample where zero means something. Three runs would not have distinguished this from luck, which is the lesson from #38's first incomplete fix.

Ruling: did not change the module. The production behaviour (an eager singleton starting a background refresh) is deliberate and was ruled on in #38; what is wrong is a test abandoning instances in a way no production caller does.

Worth stating plainly: #38's ledger describes this mechanism in detail, and I still shipped a new file carrying it. A ruling written down is not the same as a ruling applied — the check that would have caught it is asking, of every new test that calls `require` after `resetModules`, what happens to the singleton it just built.

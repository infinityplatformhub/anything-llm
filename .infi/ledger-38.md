# Ledger — issue 38, modelPricing etag flake

Ruling: **the recon's cause was wrong, and the fix it prescribed would not have worked.** The recon says the cacheDir is shared between suites and proposes a per-test `mkdtempSync` — but `index.test.js:46` already does exactly that, per test, and has since it was written. Implementing the recon as stated would have changed nothing and closed the issue on a flake that still fires.

The actual mechanism, verified by probe rather than reasoning:
1. `CACHE_FILES` was a set of lazy getters over `cacheDir()`, so every write re-read `process.env.STORAGE_DIR` **at write time**, not at construction.
2. The constructor starts `#refresh()` in the background and returns; `bootRefresh` is the only handle and nothing outside the pricing suite awaits it.
3. `require`-ing the module at all runs `new ModelPricing()` at `index.js:332`. Nine test files import it, most without setting `STORAGE_DIR`.

So a refresh begun while STORAGE_DIR pointed at suite A's tempdir finished after suite B had repointed STORAGE_DIR, and wrote `.etag` into B's directory — overwriting the value B had just asserted. That is the `"" vs "abc123"` symptom, and it explains why the suite is clean in isolation (nothing else moves STORAGE_DIR) while flaking in a full run.

Ruling: fixed by **capturing the directory once per instance** (`this.cacheDir` / `this.cacheFiles`) instead of resolving it per write, plus an optional `{ cacheDir }` constructor option for tests. A refresh now writes where it was started, whatever the environment does while it is in flight. The per-test tempdir the recon asked for is already there and unchanged.

Ruling: did **not** remove the module-level `new ModelPricing()` at `index.js:332`, though it is what makes a bare `require` start a fetch. Every consumer imports `MODEL_PRICING` as a ready singleton; making construction lazy is a production behaviour change well outside a test-only fix. The capture makes the eager construction harmless — its refresh writes to the default storage dir and stays there. Noted so a later cleanup knows the eager singleton is still there by choice.

Ruling: RED-proven by restoring the lazy getters, which fails all three new tests. The three assert distinct properties (an in-flight refresh is not redirected; two instances do not cross-write; the captured dir survives an env change) rather than three angles on one, so a partial regression cannot pass two of them.

Ruling: the new tests live in their own file rather than inside `index.test.js`, because they are about instance isolation rather than pricing behaviour, and the existing file's `beforeEach` deliberately sets one STORAGE_DIR for the whole suite — which is the condition these tests need to violate.

Ruling: one fixture correction during the work — my first `okResponse` returned `{openai: {"gpt-4o": ...}}`, but `slim()` reads `provider.models`, so it produced no usable data and the refresh bailed before writing. The tests were failing for the wrong reason until the fixture matched the real API shape.

## Correction — the first fix was incomplete

Ruling: I reported "0 flake, 4 runs" before the fourth run had finished writing, and it had failed. The correct figure was 3 clean, 1 red. Recorded because the wrong number went to PMO before the right one did.

The surviving failure was `ModelPricing › cache mechanics › walks the full retrieval lifecycle`, i.e. case (ก) — the pricing suite itself, so the first fix was necessary but not sufficient.

Second mechanism, distinct from the first: the capture stops a refresh from being redirected to **another** directory, but this test reboots four times in one `tempDir`, and each `jest.resetModules()` + `require` re-runs the module-level `new ModelPricing()` at `index.js:332`. That construction starts its own unawaited refresh **against the same directory the test is using**. `flushRefresh()` awaited only `lastInstance.bootRefresh`, so boot N's abandoned write could land during boot N+1 and overwrite `.etag` — which is exactly the `"v1"`-vs-empty assertion that failed.

Ruling: fixed in the test rather than the module. `freshInstance()` now captures `MODEL_PRICING.bootRefresh` before discarding the singleton, and `flushRefresh()` awaits every refresh touching the directory instead of one of them. The alternative — making module-level construction lazy — is the production behaviour change already ruled out above, and this is a test that abandons instances in a way no production caller does.

Ruling: verified with 25 consecutive runs of the pricing suite plus full-suite runs, rather than the 3 the DoD asks for. Three runs is what let the first incomplete fix look finished; a flake that fires roughly one run in four needs a sample that would have caught it.

Ruling: `gate_commented_code` flagged `if (this.#hasDiskCache && fs.existsSync(this.cacheFiles.etag)) {` as commented-out code. It is a false positive: the gate splits a line on `#` and treats the remainder as a comment, and a JS **private field** (`this.#hasDiskCache`) puts a `#` mid-expression, so the tail reads as a comment ending in `{`. The identical line is on main and does not trip the gate there — it only trips because my diff touches that line, and the gate scans changed lines.

Fixed by hoisting the condition into a named `canRevalidate` so the changed line carries the private field **or** the brace, never both. Not by suppressing the gate: the check is right to flag `{`-terminated comments, and `canRevalidate` reads better than the inline conjunction anyway. If wrong, one extra local for a condition used once.

Worth surfacing rather than working around silently: any JS file using private fields will hit this, and the codebase uses them in `EncryptionManager`, `ModelPricing` and the authorization engine. The gate's own comment says it deliberately does not use `;`/`}` alone as a signal because human prose ends that way — `#` as a comment marker has the same problem in a language where `#` is also syntax.

# Ledger — issue 44 (V1-c Thai retrieval eval set)

Ruling: eval gate split in two — `yarn eval:thai` (real embedder, slow, not in `yarn test`) and a fast mock-embedder jest test — because jest has no config in `server/package.json`, so its default testMatch runs every `.js` under `__tests__/`; recon file list (`__tests__/eval/thaiRetrieval.eval.test.js`) and recon DoD item 6 ("Not in `yarn test`") cannot both hold. If wrong, the slow eval never runs in CI and quality regressions are caught only when someone runs it by hand.

Ruling: corpus is original prose authored for this repo, not Thai government documents, because the task brief says so explicitly and it removes the licence question the recon spends section 2 on. If wrong, the register is one step less formal than real ระเบียบ and the numbers are slightly optimistic for legal boilerplate.

Ruling: ranking is in-memory cosine over chunks produced by the real `TextSplitter`, not a live vector store, because the recon's stated failure mode is skipping the chunker and the chunker is exercised; cosine is the same similarity the stores compute. If wrong, provider-specific recall differences (index type, quantization) are invisible to the eval.

Ruling: a pair counts as retrieved only when a chunk contains the whole gold answer span, because a chunk holding half an answer cannot answer the question. If wrong, recall reads lower than a span-overlap metric would and a split span shows as a miss rather than a partial credit — which is the intended signal for the chunker.

Ruling: the runner sets `process.exitCode` instead of calling `process.exit()`, because the DoD gate's skipped-test detector matches the literal `xit(`, which `process.exit(` contains — a false positive the gate cannot distinguish from a real `xit("...")`. Setting exitCode is also the better shape: it lets stdout flush before the process ends, so a piped metrics table is not truncated. Verified the three exit paths still return 0 (pass), 1 (below threshold), 1 (bad EVAL_EMBEDDER). If wrong, a future `process.exit` reintroduced anywhere in the eval path trips the same false positive with no comment explaining why it was avoided.

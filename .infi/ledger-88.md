# Ledger — #88 (provider `connect()` guards compare `VECTOR_DB` raw)

Ruling: (PMO) all eight guards are kept and normalised, not deleted. They still catch a `getExactly` argument that disagrees with the environment, which `resetAllVectorStores:31` genuinely passes.
ถ้าผิด: deleting is a behaviour change across eight providers to remove a check that costs nothing and is not purely redundant.

Ruling: the count is **eight**, not seven. The eighth is `zilliz/index.js:18`, whose guard sits at the top of `connect()` rather than beside its `new Client(...)` like the other seven.
ถ้าผิด: a fix applied from a seven-item list leaves one provider that resolves under #87's normaliser and then throws `Zilliz::Invalid ENV settings` at first use — the exact bug, still present, in the one place nobody re-checks. The test derives the list by scanning `utils/vectorDbProviders/` for the guard pattern rather than hardcoding it, so a provider added later without a normalised guard fails the suite.

Ruling: the tests call the real `connect()` and assert only that the rejection is not `Invalid ENV settings`. No SDK mocks.
ถ้าผิด: eight mocks of eight client libraries is eight chances to pass for the wrong reason. The guard runs before client construction, so a genuine connection failure afterwards (no endpoint, no API key) is the correct outcome — and if someone moves a guard below the construction, the error changes shape and the test goes red.

Ruling: each provider must also still REJECT another provider's name and a value matching nothing.
ถ้าผิด: deleting the guards entirely would satisfy the accept-every-spelling tests. Mutation-verified: replacing chroma's condition with `false` turns 2 red.

## The recon's require-cycle claim was wrong

The recon for this issue (`docs/superpowers/recon/vectordb-connect-guards.md`, merged) stated that
a top-level `require("../../helpers")` in a provider would close a cycle
(`helpers → provider → helpers`) and receive a partially-populated `module.exports`, so the helper
had to be required inside `connect()`.

Measured, it does not. `utils/helpers/index.js` requires providers **only inside function bodies**
(`getVectorDbClass`'s switch arms), so nothing is required in that direction at load time — and
**seven of the eight providers already require helpers at module scope today** and work. I wrote
that claim from the shape of the code without running it.

The require was placed inside `connect()` anyway, because that is what the ruling says and it
costs nothing. But the three tests that were going to enforce it have been rewritten to assert
what is actually true: that helpers requires providers lazily, and that the module loads whole in
either order. Kept rather than deleted, because if someone later hoists a provider require to
helpers' module scope the cycle becomes real, and those tests go red before anyone debugs
`normalizeVectorDbKey is not a function` at runtime.

## Residual

- **No test drives a provider's `connect()` to success.** Each is asserted only to get *past* its
  guard. Proving a provider actually connects needs a live Chroma/Qdrant/Weaviate/etc., which is a
  CI-environment question, not something this issue can settle.
- **The eight `VectorDbSelection:` telemetry labels in `endpoints/` still read the raw value** —
  unchanged from #87's ledger, still deliberate.

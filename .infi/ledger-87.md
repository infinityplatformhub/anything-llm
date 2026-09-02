# Ledger — #87 (VECTOR_DB compared as a raw string)

Ruling: (PMO ข) one exported normaliser, `normalizeVectorDbKey`, used by every comparison of a `VECTOR_DB` value — `getVectorDbClass`, `resetAllVectorStores`, `supportedVectorDB`, and the installer's `requiredExtensions`.
ถ้าผิด: the defect is not one wrong comparison. Four places compare this setting, and fixing one leaves the rest disagreeing about the same field — which is how `.env` came to accept spellings the settings UI rejects.

Ruling: an unrecognised value still falls back to LanceDB. Throwing (matching `getLLMProvider`, `helpers/index.js:261`) is a follow-up after one release.
ถ้าผิด: `getVectorDbClass` runs on document upload, on chat, and on workspace delete, so a throw converts a wrong-storage bug into an outage for every instance already running on an accidental LanceDB — a real population, since the fallback has been silent for the life of the setting.

Ruling: the unknown-value log names the value received, the set accepted, and the provider used instead.
ถ้าผิด: the old text said "No VECTOR_DB value found in environment!", which is wrong about the cause — the value WAS found, it just matched nothing. An operator grepping for their own typo found a message telling them the variable was unset.

Ruling: the warning is deduplicated per value, not per process. Two different typos are two different problems.
ถ้าผิด: either a per-call log that buries every other line an operator is reading (this runs on every upload and every chat), or a single flag that swallows the second mistake after the first.

Ruling: `normalizeVectorDbKey` maps empty and whitespace-only to `lancedb`, the documented default, but returns an unrecognised value UNCHANGED.
ถ้าผิด: an unset variable would take the unknown path and log an error about a machine that is merely using the default; and mapping unknowns to the default would leave the caller unable to quote what the operator wrote. Mutation-verified: dropping the empty-string mapping turns 2 tests red.

Ruling: `resetAllVectorStores` normalises its own comparison (`:33`), not just its call to `getVectorDbClass`.
ถ้าผิด: the right provider with the wrong reset strategy — a misspelled pgvector would take the per-namespace deletion path, leaving its embedding table in place with a vector dimension that can no longer be changed. This is the reason the issue exists rather than a one-line change; mutation-verified.

Ruling: O2a's `config.vector_db` doctor check is REMOVED, along with its four tests.
ถ้าผิด: that check existed precisely because `PGVECTOR` reached LanceDB. Once the resolver normalises, the spelling works, and a preflight still failing it would block a configuration the app itself honours. A check that was right last week is wrong this week, and retiring it is part of this fix rather than a later cleanup.

Ruling: `supportedVectorDB` reads the resolver's own list rather than keeping a second copy.
ถ้าผิด: two lists drift. They were already inconsistent in ordering, and a provider added to one and not the other is a provider the UI accepts and the app cannot resolve.

## Residual

- **The reset-strategy fix is verified by source inspection, not behaviour.** Exercising `resetAllVectorStores`' pgvector branch needs a live pgvector store with an embedding table; the test asserts the comparison is not a bare `===` against the raw key and that the normaliser is used. A mutant reverting it goes red, so the guard holds, but it would not catch a normaliser that returns the wrong string.
- **The eight `VectorDbSelection: process.env.VECTOR_DB || "lancedb"` sites in `endpoints/` are untouched.** They are telemetry and response labels, not dispatch, so they now report the raw spelling while the app uses the normalised one. Left deliberately: changing what those fields report is an API-visible change, and no ruling asked for it.
- **Throwing on an unknown value (option ค) is not in this issue** — PMO ruled it a follow-up after one release, so the honest log has time to warn people first.

## Process note

While mutation-testing I backed the four edited files up into `/tmp` keyed by BASENAME, and `utils/helpers/index.js` and `utils/doctor/index.js` collide on that. The restore step wrote the doctor file over helpers and every source edit was lost; the tests survived, so this surfaced as 27 red rather than as silent corruption. Re-applied from the recorded edits and re-ran the mutants with path-preserving backups. Worth recording because the failure mode is a restore that looks like it worked.

# QA-2 — #102 fbef8c6bf — PASS

Probe 78/78 via `/api/metrics` exposition body over HTTP; dev suites providerLabel + wiring 75/75. Negative fixtures: suspended user → failure +1 equal to no-user/bad-password; `documents.js:164` create-failure counted (mutation removing it → 3 red); `voyageai` → `other`.

A positive control (path drives value); B oracle: 4 refusal branches delta = 1 each, label set = ["outcome"] only, username absent from body; C per-document 2/1 from batch 3; D per-completion resolve +1 / reject +0 via real factory; E providerLabel derived from both resolvers (41, guarded), junk → other, openai → openai; F safeObserve swallows, log has metric+label names not values, warn-once; G guards bite, vocabulary 7, ALLOWED_LABEL_NAMES ["outcome","provider"]; H no new routes.

| mutant | probe | dev |
|---|---|---|
| M1 add `reason` label | 8 | 1 |
| M2 documents .length once | 2 | 2 |
| M3 providerLabel passthrough | 38 | 45 |
| M4 count chats before resolve | 2 | 0 — dev suite lacks reject→+0 case |
| M5 remove auth wiring | 7 | 2 |
| M6 remove create-failure increment | 2 | 1 |

Notes: scrape needs one `setImmediate` after response (finish hook); wrapper binds at construct so prototype swaps must precede factory; SPA fallback returns 200 for unknown /api paths (#40 lane).

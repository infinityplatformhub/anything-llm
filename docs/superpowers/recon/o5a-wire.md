# Recon — O5a-wire: connect the declared counters to real call sites

#90 declared five counters and a closed label vocabulary, and shipped `/api/metrics`. Nothing
increments them, so every scrape today reports zero and reads as a healthy idle instance. This
issue wires them.

## 0. The risk this issue carries, stated first

#90's own header says it: **the risk in a metrics endpoint is not the numbers, it is the labels.**
Prometheus labels are unbounded cardinality and plain text in every scrape, and `/api/metrics` is
unauthenticated behind an `ipAllowlist` that is EMPTY on a default install
(`utils/middleware/requestControls.js:222-223` calls `next()` when the list is empty).

#90 wrote the guard. This issue is where the guard is actually tested, because a guard with no call
sites has never been asked a question. Every call site added here is a chance to pass user text into
a label.

**No user id, workspace id, workspace slug, document name, model name, or endpoint URL becomes a
label.** Not "should not" — `observe()` throws on an undeclared value, so a call site that tries it
fails at that line. That behaviour is the thing this issue must not weaken to make wiring easier.

## 1. What #90 left in place

`utils/metrics/index.js` exports `observe(name, labels)`, which refuses an unknown metric, an
undeclared label NAME, and an undeclared label VALUE, throwing in each case rather than dropping the
label and counting anyway.

| counter | labels |
|---|---|
| `chats_total` | `provider` |
| `embeddings_total` | `provider` |
| `documents_total` | `outcome` |
| `auth_attempts_total` | `outcome` |
| `operations_total` | `kind`, `outcome` |

Allowed values: `provider` ∈ {openai, azure, anthropic, ollama, localai, native, other};
`outcome` ∈ {success, failure}; `kind` ∈ {chat, embedding, document, login}.

## 2. The gap nobody has had to face yet

**`getLLMProvider` switches on 41 distinct provider strings. `provider` allows 7.**

Measured from `utils/helpers/index.js`: openai, azure, anthropic, gemini, lmstudio, localai, ollama,
togetherai, fireworksai, perplexity, openrouter, mistral, groq, koboldcpp, textgenwebui, cohere,
litellm, generic-openai, bedrock, deepseek, apipie, novita, xai, nvidia-nim, ppio, moonshotai,
cometapi, foundry, zai, giteeai, llmman, privatemode, sambanova, lemonade, omlx, minimax, cerebras,
vertex, anythingllm-router, plus native and voyageai on the embedding side.

So 34 of 41 must map to `other`, and passing `process.env.LLM_PROVIDER` straight into `observe()`
throws on most real installs. The wiring needs **one mapping function** — call it
`providerLabel(raw)` — living in `utils/metrics`, beside the vocabulary it must satisfy, returning
`other` for anything unlisted and never throwing.

Two things this must not become:

- **Widening the vocabulary to 41 values to avoid the mapping.** Cardinality is the reason the list
  is short. A dashboard does not need to distinguish `ppio` from `novita`; an operator debugging
  one knows which they configured.
- **A mapping that passes the raw string through when it does not recognise it.** That is the
  failure mode in miniature: an unlisted value reaching a label. `other` is the whole point of
  `other` being in the list.

The mapping is also the natural place for the test that matters: **every one of the 41 strings the
resolver accepts must map to a value `observe()` accepts.** Derived by scanning the resolver, not
by a hand-written list that drifts — the same argument #88 made for deriving the provider list from
a directory scan.

## 3. Where each counter is incremented

The test of a site is: *is this the place where the thing actually happened, or the place where it
was requested?* A counter incremented on request counts intentions.

| counter | site | note |
|---|---|---|
| `chats_total` | the chat path, after a completion returns | `provider` from `providerLabel(process.env.LLM_PROVIDER)` |
| `embeddings_total` | the embedder call, after a batch returns | `provider` from `providerLabel(process.env.EMBEDDING_ENGINE)` — its own env var, not the LLM one |
| `documents_total` | `models/documents.js` `addDocuments`, which already separates `embedded` from `failedToEmbed` | one `success` per embedded, one `failure` per failed; NOT one per call |
| `auth_attempts_total` | `endpoints/system.js` `/request-token` | it already has the four branches: no such user, bad password, SSO disabled, success |
| `operations_total` | deferred — see below |

**`operations_total` is deliberately NOT wired in this issue.** Its `kind` values duplicate what the
four specific counters already say, and a counter that double-counts what another counter reports is
worse than one that reports nothing: two dashboards disagree and nobody knows which is wrong. It
either finds a distinct use in a later issue or it is removed; both are honest, and leaving it
incrementing alongside the others is not.

## 4. Failures must not be silent, and must not be loud

Two constraints in tension:

- `observe()` throws by design. A throw inside a chat handler that is otherwise fine would turn a
  metrics bug into a user-visible 500 — the observability breaking the thing observed.
- Swallowing the throw silently returns us to a counter that reports zero forever with nobody
  noticing, which is the exact condition this issue exists to end.

**Resolution: every call site wraps `observe()` in a try/catch that logs once and continues.** In
production the mistake lands in the log rather than in the user's response.

> **updated:** "the throw still fires in tests, where it is a hard failure" was wrong as written.
> `safeObserve` swallows the throw everywhere, tests included — there is no test-only mode. What
> keeps a bad label a hard failure in tests is that the suites call `observe()` DIRECTLY for that
> assertion, and separately assert that `safeObserve` does not throw. Two different functions, not
> one function behaving differently by environment. The catch logs the metric name and the rejected label, never the value
that was rejected — a rejected value is by definition one that was not supposed to be published, and
writing it to a log to explain why it was not published is the same leak one file over.

## 5. Tests

- **the mapping is total**: every provider string `getLLMProvider` accepts (scanned from the source,
  not listed by hand) maps to a value `observe()` accepts
- **unknown → `other`**, and specifically NOT passed through
- `documents_total` counts per document, not per call: a batch of three with one failure yields two
  `success` and one `failure`
- `auth_attempts_total` records `failure` on each of the three refusal branches and `success` only
  on the branch that issues a token
- **the guard still bites**: a call site passing a workspace slug as a label throws — the assertion
  that this issue did not quietly widen the vocabulary to make wiring easier
- **a throwing `observe` does not break the request**: with `observe` stubbed to throw, the chat
  path still returns its completion
- **`/metrics` reports the increments**: after driving the paths above, the scrape body contains the
  counters with non-zero values — the end-to-end check that #90's residual asked for

## Scope

**In:** `providerLabel` in `utils/metrics`, the four wired counters, the try/catch at each site, and
the tests above.

**Out:** `operations_total` (§3); widening the label vocabulary; authenticating `/metrics`
(an `ipAllowlist` decision, not this issue's); a real Prometheus scrape in CI (#90 residual,
still backlog); dashboards.

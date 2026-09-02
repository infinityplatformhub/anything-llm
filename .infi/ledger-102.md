# Ledger — #102 (O5a-wire: connect the declared counters to real call sites)

## Rulings from PMO

Ruling (1): every call site increments through `safeObserve`, which logs and continues. `observe`
throws by design, and a throw inside a chat handler turns a metrics bug into a user-visible 500 —
the observability breaking the thing it observes. Swallowing silently returns to counters that read
zero forever. The log names the metric and the label NAME, never the rejected VALUE: that value is
by definition one that was not supposed to be published. Warn ONCE per (metric, label NAME) — keyed
on the name, not the value, because keying on the value makes the memory unbounded, which is the
cardinality problem one layer down. — ถ้าผิด: bug ของ metrics กลายเป็น 500 ที่ user เห็น หรือ counter
ศูนย์ตลอดกาลโดยไม่มีใครรู้

Ruling (2): `operations_total` and the `kind` label are REMOVED, not left unwired. Its values
duplicated what the four specific counters report, and a label with no metric using it is an
invitation to find a use for it — which is how a vocabulary widens without anyone deciding to widen
it. — ถ้าผิด: เพิ่มกลับพร้อม use case จริงทีหลังราคาถูก

Ruling (3): one table, `providerLabel(raw)`, unknown → `"other"`, never passthrough. Widening the
vocabulary to 41 values would defeat its purpose (cardinality is why the list is short), and
passthrough would let the guard fire only on values somebody anticipated — the opposite of the
point. The drift test iterates the resolver's OWN cases scanned from source. — ถ้าผิด: ค่าที่ไม่มีใคร
คาดคิดหลุดเป็น label บน endpoint ที่อ่านได้โดยไม่ต้อง auth

Ruling (4): `documents_total` per document; `embeddings_total` from `EMBEDDING_ENGINE` through the
same table. A common install runs a hosted LLM against the bundled native embedder, so labelling
embeddings with the chat provider would report a provider that computed none of them. — ถ้าผิด:
dashboard บอกว่า provider หนึ่งทำ embedding ที่มันไม่เคยเห็น

Ruling (5): `auth_attempts_total` labels are constants. Nothing from the request reaches a label.

## TL-2 pre-read

Ruling (F-1/F-2): the drift test scans BOTH `resolveLLMProviderInstance` and
`resolveEmbeddingEngineInstance`, since the engine list carries `native` and `voyageai` which the
LLM list does not. A value in neither list maps to `other` without throwing.

Ruling (F-3): `/request-token` has NINE outcome points across the multi-user and single-user paths.
Counted from the STATUS CODE on `response.on("finish")` — once, not nine times. A tenth branch added
later is counted without anyone having to remember, and no branch can be the one that forgot. This
is what makes the suspended and ruling-C refusals count like every other. — ถ้าผิด: brute force
มองไม่เห็นในตัวชี้วัดที่มีไว้ดูมันพอดี

Ruling (F-4): no `reason` or `branch` label, ever. `/api/metrics` is readable without
authentication behind an `ipAllowlist` that is empty by default, so separate counters for "no such
user" and "bad password" would answer, for free and to anyone, the question the endpoint refuses to
answer directly — the handler deliberately returns the same 401 for both. Pinned by a test.

Ruling (F-5): counters are asserted by reading the VALUE OUT OF THE REGISTRY, not by counting calls
to a spy. A spy proves the test called a function; the registry proves a scrape would report the
number.

## QA-2 probe prep

Ruling: `documents.js`'s `prisma.workspace_documents.create` catch enters NEITHER array — the vector
write succeeded, the row did not. A counter wired from `embedded`/`failedToEmbed` would report two
outcomes for a batch of three, and the missing one reads as a smaller batch rather than a partial
failure. Counted there too: THREE outcome sites, not two. — ถ้าผิด: batch ที่พังบางส่วนดูเหมือน
batch ที่เล็กกว่า

Ruling: the suspended branch counts like every other refusal — and that is true BY CONSTRUCTION
here, not by remembering, because the `finish` hook reads a status code every branch already sets.
If it were the one refusal that did not increment, a caller learns the account exists and is
suspended precisely by the counter NOT moving: silence is as much a signal as a count. — ถ้าผิด:
oracle กลับด้าน

## What the recon got wrong, corrected by measurement

The recon said to wire "the chat path". There is no such single place: ELEVEN completion call sites
across five files (`apiChatHandler` ×3, `embed`, `openaiCompatible`, `stream`, `telegramBot`), 39
provider classes and no base class among them; `embedChunks` is called from eight vector-database
providers and implemented by fourteen engines.

Ruling: instrument the two FACTORIES — wrap `getChatCompletion` / `streamGetChatCompletion` on the
connector `getLLMProvider` returns, and `embedChunks` on the engine `getEmbeddingEngineSelection`
returns. Wiring eleven sites means a twelfth, added later, is counted nowhere and the metric
under-reports silently, which is worse than not having it: a dashboard reading low looks like low
traffic. The METHODS are wrapped rather than the factory call, because a counter incremented on
CONSTRUCTION counts intentions — connectors are built on paths that then fail validation and on
paths that complete nothing. The increment is after the promise resolves, so a rejected completion
is not a served one and the throw propagates untouched. In the stream path that is one per
completion, not per token. — ถ้าผิด: นับเจตนาแทนที่จะนับของที่เกิดขึ้นจริง

Ruling (test correctness): the registry helper returns `null` for a label set never observed and a
NUMBER when it has been. Collapsing "never seen" into `0` would have let the passthrough test pass
while `chats_total` was published under the raw provider string. Found by that test failing. —
ถ้าผิด: เทสที่เขียวบนบั๊กที่มันมีไว้จับ

## Evidence

`providerLabel.test.js` 61 · `wiring.test.js` 14 · `endpoints/metrics.test.js` 18 (#90's, unchanged)
= **93 passed**.

### Mutations (§7.9f)

| mutation | result |
|---|---|
| `providerLabel` returns the raw key instead of `"other"` | **46 red** |
| add a `reason` label to the vocabulary | **2 red** — the F-4 pin |
| drop the create-failure increment | **1 red** — QA-2's branch |
| remove the `finish` hook from `/request-token` | **2 red** |

`--findRelatedTests` over the four touched files: 1956 passed, 11 skipped. Four suites
(`impersonationWrites`, `chatReadOthers`, `keyCeilingHttp`, `wildcardKeyDeniedHttp`) failed inside
that 138-suite parallel run and pass 25/25 together on this branch AND on unmodified main — load
flake, same family as #57, not this change.

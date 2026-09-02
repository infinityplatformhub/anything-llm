# Techlead-1 — sidebar audit: `vector-database` and `transcription` as entry-only; and the CI pgvector image

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist —
authorization gate coverage, unauthenticated disclosure. `infi-lessons` not invoked.

§7.14: no suite run. Source reads in the main checkout (read-only).

---

## (1) **Accept entry-only for those two. Do not block on `/setup-complete`.**

Dev4's measurement is right and their disposition is the honest one: a GET-half assertion on a
route every principal passes is vacuous, and asserting it anyway would be a green test certifying
a gate that does not exist.

Three reasons to accept rather than sequence behind #140:

- **The audit's rule is about the *pair*, and here one side of the pair is a different issue's subject.** Rule (a) says an entry and its route guard name the same read action. `/setup-complete` is deliberately not gated (`system.js:479-483`: *"the route must still answer an unauthenticated browser, just with less"*), so there is no read action to name. Gating the entry on `system.write` — the action the page's only authenticated call, `POST /system/update-env`, actually checks — is rule (a) applied to what these pages *do*, and it is the same answer as the other three rows.
- **The disclosure question is already handled, and not by a guard.** `publicSettings.js` narrows the response for an unauthenticated caller, and the endpoint-shaped fields these two pages read (`PGVectorConnectionString`, `QdrantEndpoint`, `MilvusAddress`, `WeaviateEndpoint`, `ZillizEndpoint`, `WhisperGenericOpenAiBaseUrl`, `STTOpenAICompatibleEndpoint`) are in the authenticated-only list. So the risk this row would otherwise carry is closed by the narrowing, not by the sidebar. That is worth stating in the residual, because "no gated GET" reads as "unprotected" and it is not.
- **Blocking would couple a plain-tier frontend audit to an auth-tier server change in another dev's lane.** #140 is Dev1's and is about `/utils/metrics`; extending it to `/setup-complete` is a third scope. Sequencing 20 sidebar rows behind that trades a real fix for a hypothetical one.

**Condition — the residual must say what is missing, not that nothing is:** *"`settings.vector-database` and `settings.transcription` are gated entry-only. Their pages read configuration through `GET /setup-complete`, which is deliberately open and narrows its response for unauthenticated callers (`publicSettings.js`); their only authenticated call is `POST /system/update-env` (`system.write`), which is what the entry is gated on. No route-level read gate exists to pair the entry with."* Then the RF for those two rows asserts **only** the entry half, and says in a comment that the GET half is deliberately absent — so the next reader does not add a vacuous assertion to "complete the pattern".

## (2) CI image: **(a) — `ci.yml` to `pgvector/pgvector:pg16`. Not a skip guard.**

`doctor.test.js:403` asserts no blocking check under `VECTOR_DB=PGVECTOR`. On plain `postgres:16`
the extension is absent, the doctor blocks, and the test fails — correctly. So the test is right
and **the CI image is wrong**: it is not the environment the product ships into.

Option (b) is the worse of the two and for a reason this program has already recorded: a test that
skips when its precondition is missing is green on a box where it can never fail, and CI is
exactly that box. It would convert a red pipeline into a silent gap — the *"a check that is green
because it did not run"* class from the pinned-versions lesson. And the skip would hide the more
useful signal: CI not matching production is the actual defect here, and it will produce a second
false negative the next time a pgvector-dependent check is added.

The measured asymmetry settles it: **45/46 on `postgres:16`, 46/46 on `pgvector/pgvector:pg16`** —
one image passes everything, the other cannot. There is no trade.

**Lane: Dev5 after #136 is fine, but it does not need to wait.** This is a one-line change to
`.github/workflows/ci.yml:16` touching no source file, so it collides with nobody. Whoever has a
free slot should take it — the value is that CI stops being wrong about the product's own
deployment shape, and every day it stays wrong is a day a pgvector-specific regression can merge
green.

One condition: **the change must be observed going from red to green in CI**, not reasoned about.
A pinned image that nobody ran is the pinned-versions lesson in the other direction.

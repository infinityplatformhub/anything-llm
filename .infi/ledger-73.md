# issue 73 — ledger

CI: add milvus/qdrant/weaviate/chroma services so the real-store ACL suites actually run.
Split out of #30 by PMO ruling.

## Round 1 (`0b3e50aee`)

Ruling: the guard is a jest REPORTER, not a test (TL-2, and my first version was the weaker
shape TL-2 named). I originally asserted that the four env vars were SET, which is a
different claim wearing the same words: a container that starts and dies, a variable
pointing at a dead host, or a `describeIf` rewritten to gate on something else all leave the
variable set and the suite skipped. Proving execution needs the whole result set — which no
test can see, and a test is itself subject to the skipping it exists to detect. The reporter
reads `numPassingTests` per suite and sets a non-zero exit when a required suite contributed
nothing.

Ruling: the reporter stands down on a FILTERED run (`jest -t`, or a path pattern), because a
subset run cannot prove a suite's absence. That exemption is itself a hole — a pattern added
to `yarn test` would silently disable the guard — so `ci.yml` carries a comment at that line
saying not to add one.

Ruling: the RED is demonstrated by running it, not by reasoning about it (§7.9). A full run
with the engines unreachable prints "Test Suites: 4 skipped, 161 passed" and exits 0 — the
exact state CI was in — and the reporter names all four suites and forces exit 1. Green with
engines up: 1774/1774, zero skipped.

Ruling: the missing services were the SYMPTOM. The root cause is that nothing noticed the
skip, so adding services without the reporter would regress silently the first time a
container is renamed or a health check starts failing.

Ruling: chroma/qdrant/weaviate get no `--health-cmd`, because those images ship without curl
or wget — a container-level check would be permanently failing, or (worse) written as
something that always succeeds. The readiness wait is a real step on the runner, which has
curl, and it fails the job loudly.

Found while writing it: `expect()` takes exactly one argument. My message-as-second-argument
made all four CI-branch assertions throw "Expect takes at most one argument" — they would
have failed in CI whatever the environment. Visible only by running the CI branch; reading
it showed nothing. Second time this exact slip has cost a cycle (slice 2 was the first).

## Round 2 (`8beff79c9`) — TL-2 BLOCKER-1

Ruling (my bug, and worse than the wrong number): I pinned `chromadb/chroma:0.5.5` while
`server/package.json` pins `chromadb ^2.0.1`, whose client speaks the v2 API. Measured
directly: 0.5.5 answers `/api/v1/heartbeat` 200 and `/api/v2/heartbeat` **404**; 1.0.0
answers v1 410 and v2 200. So the readiness wait would have gone green on a server the
client cannot talk to, and all 8 chroma tests would then fail on `ChromaNotFoundError`.

Ruling: **I reported green having never run against the version I pinned.** My local
container was `chromadb/chroma:0.5.20`; ci.yml said 0.5.5. Pinning a version you have not
executed against is the same defect this issue exists to close, one level up — the suites do
run now, but they ran against something other than what CI will use. Verified the fix by
starting a fresh 1.0.0 container and running the real suite against it: 8/8.

Ruling: the wait step probes `/api/v2/heartbeat`, matching the client. A readiness check that
passes while the thing it checks is unusable is worse than no check at all.

Ruling (TL-2): Milvus moves to `.github/milvus-compose.yml`. `services:` has no `depends_on`
and cannot pass a command, so a `services:`-based Milvus races ahead of etcd and MinIO and
never receives `milvus run standalone` — it starts, fails, exits, and the suite skips while
CI stays green. Compose expresses both; `up -d --wait` blocks on health.

Ruling (TL-2 NOTE-2, same defect class as QA-1's M7 on slice 2): the CI-exempt test looped
over an empty `CI_EXEMPT` and early-returned, so it passed identically whether the rule
worked or not — and would have kept passing the day someone added the first exemption. The
rule is extracted and driven with fixtures: declared in neither, in the workflow only, and
in both. An assertion made against data that cannot exercise it only asserts that the
fixture is empty.

## Round 3 (`4646ef8be`) — gate

Ruling: `describe("#73: ...")` → `describe("issue 73: ...")` (§7.3a). Title only; the
reporter and every assertion are untouched.

SHA: 4646ef8be (branch approof/t5-slice-2, base c7ef9d28b)

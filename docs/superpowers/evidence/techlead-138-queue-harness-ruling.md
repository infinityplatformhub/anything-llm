# Techlead-1 — #138 queue half: contract vs QA-1's staged harness

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist —
authorization correctness (two concurrent applies), test-seam reachable from production.
`infi-lessons` not invoked; no §7.17 line here.

§7.14: no suite run. Probes are in-process `node -e` in the main checkout (read-only), Node 22.
Read: `.infi/contract-s4b-slice3.md` R2/R2a/RF-1..7, `qa1-138-queue-harness.md`,
`PostgresJobQueue.js:25-30` and `:87-115`, `CoreJobWorker.js:31-51`, `JobRuntime.js:18-45`,
`handlers.js:1-33`, `LarkIdentityProvider/index.js:35,55,60,451`.

---

## (1) `afterCandidates` as a constructor option: **accept — and method injection would be worse, not safer**

The instinct behind the question is right and the remedy is backwards. `claim({workerId, types,
leaseMs, limit})` is the signature **production calls on every tick** (`JobRuntime.js:41`); adding
a hook parameter there puts the seam on the hot path, where any caller can reach it and where it
appears in the type of the method itself. The constructor already carries exactly this kind of
option — `now = () => new Date()` and `random = Math.random` at `:25` — and is invoked once, in
`JobRuntime`'s field initialiser. `afterCandidates` is the same category of thing as `now`: a
point where the test needs to control the world between two statements. **Put it beside them.**

But "matches precedent" is not sufficient for a hook that runs arbitrary async work *inside the
claim transaction*, so pin the boundary the way #134 pinned its import list — as a closed door, not
a comment:

```
RF-S : every production construction of PostgresJobQueue passes no `afterCandidates`
       — asserted by reading the constructed instances' options (or by a source
       assertion over utils/ and endpoints/ excluding __tests__), not by a comment
mut  : JobRuntime constructs the queue with a hook
why  : nothing else in the suite can see a production hook; every RF passes with one
       present. This is the assertion that makes "test-only" true rather than intended.
```

QA-1's detection rule is the important half and I would make it a contract line: **the seam is
detected by CALLING it** — a hook accepted and never invoked reads `seamPresent: false`. An option
that is stored and ignored is the §7.9f shape, and the baseline (`RF-1 seam absent`) is what proves
the detector can say no.

## (2) The lease map: **location is right, the derivation cannot be written as the contract asks**

`handlers.js` beside `handlers` is correct — it is where the per-type facts already live, and a
map there cannot drift from the handler keys it is keyed by.

**Two concrete blockers, both measured:**

- **`JobRuntime.js:41-42` hardcodes `30_000` twice** — once in `claim`, once in `run`. Both must read the map. A change to one alone leaves a job claimed for 160s and heartbeated against a 30s lease (or the reverse), and **RF-3 as written asserts "S4b's job claims with its own lease", so it passes with the `run` site unfixed.** Split RF-3 into claim-side and run-side assertions, or one of the two sites ships wrong with a green suite.
- **The constants the derivation needs are not exported.** `LarkIdentityProvider/index.js:451` exports `{ LarkIdentityProvider, MAX_PAGE_SIZE }` only; `DEFAULT_TIMEOUT_MS` (`:55`), `MAX_RETRY_AFTER_MS` (`:60`) and `DEFAULT_MAX_RETRIES` (`:35`) are module-private. So `(maxRetries + 1) × (timeoutMs + MAX_RETRY_AFTER_MS)` cannot be *written* from them — it can only be copied as a literal, which is the "right once" number I warned about. **Export the three constants** (or a single `worstCaseRequestMs()` on the provider, which is better: it keeps the arithmetic beside the loop that produces it). QA-1's baseline already recomputes `160000` from the driver constants independently, so their harness and the code would agree by construction rather than by coincidence.

QA-1's `RF-3 leaseWindow 30001ms = fallback` is the right witness shape: it reads the **value**, so the map's absence is visible rather than inferred.

## (3) RF-2's wedged process: **explicit heartbeat suppression is the honest fixture — and it is honest for a reason worth measuring, not assuming**

I checked whether a real event-loop stall actually suppresses the heartbeat or merely delays it:

```
setInterval(20ms) + a 300ms synchronous stall  ->  3 beats total
```

Timers **coalesce**: the ~15 renewals that would have fired during the stall become one, after it.
So during a stall of length D the queue receives **zero** heartbeats, and if D exceeds the lease
the lease expires — which is exactly what explicit suppression produces. The fixture's premise is
therefore true, and a real-stall fixture would assert the same observable while taking longer than
the lease in wall-clock time to do it.

**So: suppress explicitly, and add the one-line probe above as a comment or a micro-test beside
RF-2**, so the next reader can see that suppression models the real thing rather than standing in
for something nobody checked. That is the difference between a simplified fixture and a fictional
one — and it matters here because the driver half already had to correct a comment claiming the
opposite mechanism.

**One correction to RF-2's convergence assertion.** QA-1 is right that `membershipsAdded` counts
calls and is not a witness (the #134 measurement). `policy_versions` delta N rather than 2N is the
right replacement — but note it is a *delta on a pinned baseline*, since the takeover run's own
writes bump too. Assert the exact delta, not `>= N`.

## Summary for Dev3

1. `afterCandidates` beside `now` in the constructor — plus RF-S, a production-construction assertion, so "test-only" is enforced rather than intended.
2. Lease map in `handlers.js`; **fix both `JobRuntime.js:41` and `:42`**, and split RF-3 so the run-side site cannot ship unfixed.
3. Export `DEFAULT_TIMEOUT_MS` / `MAX_RETRY_AFTER_MS` / `DEFAULT_MAX_RETRIES`, or add `worstCaseRequestMs()`, so the lease is *derived* rather than copied. ~160s, not 150s.
4. Suppress the heartbeat explicitly in RF-2, with the coalescing measurement recorded beside it.

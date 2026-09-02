# Techlead-1 — #138 driver half `ab26979ab` (auth): **PASS**, with one number to correct in the contract

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist —
authorization correctness (two concurrent applies), availability of the identity seam, secret
exposure in error paths. `infi-lessons` not invoked; the §7.17 harness line is Dev3's and PMO
has it.

§7.14: no suite run. Probes are in-process `node -e` driving the real `LarkIdentityProvider` and
the real `CoreJobWorker` against stub fetches in a detached worktree (`/tmp/tl-138b` at
`cd2c6cabe`, source identical to this SHA; Node 22).

---

## My four checks, all measured

**timeoutMs = 10_000 from the OIDC precedent** — `index.js:46` with the reason written out, and
the driver's own justification for *why a directory driver needs it more than a login flow*
(lease + heartbeat) beside it. Reuses the number rather than inventing one. Confirmed.

**`AbortSignal.any` never overwrites** — `_signalFor:138-141`:

```js
const timeout = AbortSignal.timeout(this.timeoutMs);
return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
```

Both directions covered by fixtures, and the pairing is what makes it real: the caller-abort test
alone is green on unfixed code (forwarding a signal is inherited behaviour), so QA-1's
never-fires test is the half that actually pins the combine. Both present.

**`Retry-After` clamped, beside the formula** — `:232-237`, `MAX_RETRY_AFTER_MS = 30_000` declared
at `:51` with the stalled-lease reason. Measured against a 429 advertising `86400`:

```
page attempts: 4 | clamped sleeps (s): [30, 30, 30, 30] | total 120
```

The clamp binds. The wait is kept, which is correct — waiting is the right answer to a shared
tenant quota.

**Token call bound** — `_tenantAccessToken:157` takes the same `_signalFor(signal)`, and `_page:188`
passes its `signal` through to it. This is the one I did not name in the ruling and Dev3 found while
implementing; it is the most damaging to miss, because it precedes every page.

## Dev3's two implementation decisions — both correct, both witnessed

**Fresh signal per attempt.** `AbortSignal.timeout` counts from creation, so a hoisted signal gives
four attempts one deadline. The witness is the right shape: page 1 hangs **once** then answers, so
a per-attempt signal recovers and a shared one cannot. A fixture that hangs forever is red under
both and proves nothing — that distinction is the whole test, and the comment says so.

**A caller's cancel is not retried, distinguished by `signal?.aborted`.** Cancel and timeout arrive
as the identical error, so the discriminator has to be whose signal fired. The witness asserts
`userPages.filter(p => p === 1)` has length **exactly 1** — a driver that retried the cancel would
still reject, so the count is the only thing that separates them. Correct, and it is the assertion
the hang tests cannot make.

## QA-1's floor correction is right, and the ledger records it honestly

On a silent socket the run stalls inside attempt 0 and the loop never iterates, so the observed
floor is `timeoutMs + backoff`, not `maxRetries × timeoutMs`. The test floor stays loose (>300ms)
for that reason. A tight floor derived from my arithmetic would have been a test that correct code
cannot pass.

## FINDING (contract, not code) — the lease formula is short by one backoff

The ledger and contract both carry:

```
4 attempts x 10s timeout + 3 x 30s worst clamped backoff + headroom  ~=  150s floor
```

Measured on the real loop: **four sleeps, not three.** `_backoff` runs on the failing attempt
*including the last one*, and only then does the loop exit and throw:

```
sleeps on a doomed page: [100, 200, 400, 800] -> the last runs after the final attempt, then it throws
```

So the worst bounded `_page` is `4 × 10s + 4 × 30s = 160s`, not 130s. With headroom the floor
should be ~180-200s, not 150s. **The 150s number is below the quantity it is meant to exceed** —
which is the exact failure mode the whole issue exists to prevent, arriving through arithmetic
instead of through an unbounded wait.

Two things to do in the queue half, neither in this SHA:

1. Correct the formula and the floor. Write it as `(maxRetries + 1) × (timeoutMs + MAX_RETRY_AFTER_MS)` **derived from the constants**, not as a literal — a lease number that does not move when `maxRetries` does is a number that is right once.
2. Separately and optional: the final `_backoff` before the throw is a pure waste — the loop sleeps up to 30s and then gives up regardless. Skipping it on the last attempt shortens the worst case by 30s and removes the off-by-one that produced this. Small, and it makes the formula the obvious one.

## Security checklist, applied

- **Authorization correctness** — the reason this is auth-tier. Confirmed the mechanism on the real worker rather than assuming it: a handler that never settles keeps its heartbeat firing (`setInterval` is not blocked by an awaited promise) — measured **9 beats during a real never-answering fetch**. So the lease does *not* expire from a hung fetch alone in a healthy process, and the concrete risk is narrower than "the heartbeat stops": it is a process that is killed, wedged, or event-loop-starved while a call that can never end holds the run open. The bound is still the right fix, and the takeover rule from `885f339df` is what makes the recovery safe — but the queue half should not repeat "the heartbeat stops renewing" as the mechanism, because measured, it does not.
- **Secret exposure** — `_tenantAccessToken:172-175` keeps Lark's own message and states in a comment that the secret is not in it and must not be added. The new timeout path adds no new error surface carrying credentials.
- **Availability of the seam** — a bounded failure now throws `IdentityUnavailableError` rather than hanging, and `_page`'s out-of-retries branch still refuses to return a partial page set. That refusal is what stops the reconciler reading a gap as departures; it is untouched.

## Verdict

**PASS on the driver half.** Every ruling landed, the two decisions Dev3 made on their own are the
right ones and are witnessed by fixtures that could fail, and the harness lesson is the most
valuable thing in the ledger. The 150s figure must not carry into the queue half unexamined — fix
it there, derived from the constants.

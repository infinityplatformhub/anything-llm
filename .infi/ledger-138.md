# Ledger — #138 (S4b slice 3): driver half

Dev 3. Branch `approof/134-apply-checkpoint`. Contract `.infi/contract-s4b-slice3.md`.
TL-1 lock ruling `885f339df`; TL-1 timeout ruling: option (1), #138 bounds the fetch
itself. QA-1 driver baseline `qa1-138-driver-baseline.md`.

Driver half frozen at **`cd2c6cabe`** (26/26). Queue half continues as later commits.

---

## Rulings

`Ruling: the Lark driver takes timeoutMs in config, default 10_000, reusing
OidcIdentityProvider's DEFAULT_TIMEOUT_MS value and shape rather than inventing a
second number — two identity providers disagreeing about how long "unreachable" takes
is a difference nobody chose — cost if wrong: a Lark tenant that is merely slow rather
than hung fails a sync that would have completed, which the retry loop absorbs and the
checkpoint records.`

`Ruling: a caller's signal is COMBINED with the timeout via AbortSignal.any, never
replaced — signal: AbortSignal.timeout(ms) is the plausible one-liner and it silently
removes the caller's ability to cancel, which the sync job needs on shutdown — cost if
wrong: a shutdown cannot stop an in-flight enumeration, and the process stays alive
doing work nobody wants.`

`Ruling: Retry-After is clamped at 30s rather than honoured verbatim — a 429
advertising a day parks the run for a day, which is the same stalled-lease outcome as
a hung socket arriving through a header instead of a socket; the wait itself is
correct and kept, only its ceiling is ours — cost if wrong: we retry a shared tenant
quota sooner than Lark asked, which the backoff still spaces out.`

`Ruling: _tenantAccessToken is bounded too, which TL-1's ruling did not name — it runs
BEFORE any page is fetched, so bounding _page alone leaves a hung token endpoint
stalling the run before it starts: correct in review, identical in production — cost
if wrong: none; it is the same bound applied to the one call that was missed.`

`Ruling: a FRESH signal per retry attempt, not one hoisted above the loop —
AbortSignal.timeout counts from CREATION, so a single hoisted signal gives all four
attempts one shared deadline and attempts 2-4 start already aborted — cost if wrong: a
driver that "has a timeout" and still fails the hang test, with the retry behaviour
#113 built silently gone.`

`Ruling: a caller's cancel is NOT retried, while a timeout still is — cancel and
timeout arrive as the IDENTICAL error, so they are told apart by whose signal fired
(signal?.aborted), not by the error; a tenant that stalled may answer the retry, and
the bound is what makes retrying safe — cost if wrong: a deliberate cancel is retried
three more times, and on shutdown keeps the process doing work somebody stopped.`

`Ruling: MUTATE ONLY COMMITTED CODE, and the mutation harness fails loudly rather than
reporting jest's summary regardless — cost if wrong: measured this session, see the
harness lesson below.`

---

## Why this was in #138 at all

TL-1's lease rule for slice 3 is "the lease must exceed the longest plausible stall in
a SINGLE driver call". That number could not be derived, because the stall was
unbounded: `_page` forwarded an optional `signal` that no production caller supplied,
and `_tenantAccessToken` had none at all. The retry loop covers a DROPPED socket; a
socket that stays open and never answers is not a dropped socket.

It is a concurrency bug, not hygiene: the job heartbeat renews the lease only while
the process makes progress. A run stalled forever in `fetch` stops renewing, the lease
expires, and a second worker claims the job and starts a CONCURRENT APPLY against the
same directory — the failure slice 3 exists to prevent.

**Lease formula, to be written beside the value in the queue half:**

```
4 attempts x 10s timeout + 3 x 30s worst clamped backoff + headroom  ~=  150s floor
```

QA-1's correction, adopted: on a silent socket the run stalls inside attempt 0 and the
retry loop never iterates, so the observed floor is ~`timeoutMs + backoff`, NOT
`maxRetries x timeoutMs`. The test floor stays loose (>300ms) for that reason — a 40s
floor is one correct code cannot clear.

## RED, confirmed rather than assumed

Three tests failed by hanging to their jest deadlines (30s / 30s / 90s) — the
unbounded-fetch signature TL-1 named as the mutation signal. The fourth (a caller's
signal still aborts) passed BEFORE the fix, which is correct: it is the control that
catches an overwrite implementation, so it must be green either way.

## Mutants

| # | mutant | result |
|---|---|---|
| A | `_signalFor` returns the caller's signal only (no timeout) | KILLED by the hung-page test, the hung-token test, and the fresh-signal witness |
| B | overwrite instead of combine (`return AbortSignal.timeout(ms)`) | KILLED by "a caller's own signal still aborts, and is not overwritten" |
| C | drop the `Retry-After` clamp | KILLED by "Retry-After cannot make the driver sleep unboundedly" |
| D | bind `_page` only, leave the token call unbounded | (see run) |
| E | hoist the signal above the retry loop (one shared deadline) | (see run) |
| F | retry a caller's cancel like a transport failure | (see run) |

Every mutant is run against the COMMITTED file with a verified-pristine restore source.

## The harness lesson (§7.17, PMO adopted verbatim)

My first mutation harness would have reported a false survivor, and did not only
because `infi-bash` §1.B.3 was read first.

A backgrounded mutant run was killed before its restore step, leaving the driver
mutated on disk. The next run then backed up the ALREADY-MUTATED file and failed to
find its anchor. Under a harness that prints jest's summary and exits 0 regardless,
that prints "Tests: 22 passed" — **indistinguishable from a surviving mutant**, while
the real code was never tested and the only clean copy was gone.

Compounding it: `git HEAD` predated the work, so it could not restore the file; the
uncommitted working copy was the only version.

Fixed in three places:
1. The harness exits non-zero with `SURVIVOR-UNKNOWN` on an edit-script failure, on a
   vacuous edit that changed nothing, and on a jest that produced no summary line —
   which is indistinguishable from "tests failed" by exit code alone, since both are 1.
2. The restore source is a single PRISTINE copy, fingerprint-checked before every run,
   never overwritten by a mutated file. A per-run backup is not a restore: a killed run
   makes the next run back up the mutant.
3. Mutate only COMMITTED code, so `git checkout -- <file>` is always a valid restore.

## QA-1's baseline findings, adopted

- **`_tenantAccessToken` is memoised** (`_tokenExpiresAt`), so a hangToken assertion on
  a REUSED provider is green whether or not the token call is bounded — the request
  under test is never made. Added a test asserting the memo (one token call across two
  enumerations) and proving the bound on a COLD instance.
- **The caller-abort test is green on unfixed code**, because forwarding a caller's
  signal is inherited behaviour. Added its pairing: a caller signal that never fires,
  where the DRIVER's timeout must still end the request.

## Evidence

- 26/26 on `larkDirectorySync.test.js` at `cd2c6cabe`.
- Fixture: `failMode: "hang"` ACCEPTS the connection and never answers. Distinct from
  the existing `"drop"`, which destroys the socket and so is green against a driver
  with no timeout — a dead port is not a substitute for a hung one.
- `hangToken` is a separate switch because the token call precedes any page request,
  so `failOnPage` cannot reach it.

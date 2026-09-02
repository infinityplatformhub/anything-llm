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

An unbounded request makes the sync job run forever: it never completes, its worker
slot is held indefinitely, and the directory silently stops syncing while every
dashboard reports a run in progress.

### CORRECTION (TL-1, measured): a hung fetch does NOT stop the heartbeat

`Ruling: the reason recorded for the timeout is that an unbounded request stalls the
job indefinitely and burns a worker slot — NOT that it triggers a lease takeover,
which TL-1 measured false: setInterval keeps firing while a promise is awaited (9
beats observed during a hung request), so the lease keeps renewing and no second
worker takes over; takeover covers a KILLED, WEDGED or event-loop-starved process, not
one politely waiting on a socket — cost if wrong: the fix stays correct either way,
but a comment asserting a mechanism nobody measured is how the next person builds on
it; this is the second time in two issues (see #134's F1) that a plausible mechanism
survived into a comment unmeasured.`

Corrected in three places rather than one, because the claim had propagated: the
driver's `DEFAULT_TIMEOUT_MS` block, the test file's `R2a` docblock, and here.

**Consequence for the queue half (RF-2):** a fixture that models "worker died" by
hanging its fetch would prove nothing — the lease would keep renewing. RF-2 must
suppress the heartbeat EXPLICITLY to model a wedged process.

### CORRECTION (TL-1): the lease formula was short one backoff

`_backoff` runs on the last failing attempt too, before the throw, so a doomed page
sleeps `maxRetries + 1` times rather than `maxRetries`.

**Lease floor, written in the queue half as an EXPRESSION derived from the constants,
never a literal — a literal stops being true the moment either constant moves:**

```js
(timeoutMs + Math.max(BACKOFF_CEILING_MS, MAX_RETRY_AFTER_MS)) * (maxRetries + 1)
```

QA-1's refinement, adopted over my first version: the two backoff paths have very
different ceilings and collapsing them overstates the common case. `Math.max` picks
the worse of them, so the expression stays correct whichever path a run takes:

- **429 on every page** — Lark's `Retry-After`, clamped at `MAX_RETRY_AFTER_MS`:
  `(10s + 30s) x 4 = 160s` worst.
- **Silent socket** — our own backoff, which caps at `BACKOFF_CEILING_MS = 2s`:
  ~41.5s worst.

`BACKOFF_CEILING_MS` did not exist as a named constant — it was an inline `2000` in
`_backoff` — so the expression could not have been written from the constants at all.
Named it and exported all four timing constants for this one purpose, with the reason
at the export: anything that copies these into a literal has already broken the
guarantee they exist to provide.

`Ruling: take TL-1's optional change — skip the final _backoff before the throw —
rather than only widening the formula: sleeping 30s before giving up serves nobody,
the witness is obvious (elapsed on a doomed page drops by one backoff), and leaving a
known off-by-one in the formula's inputs is how the formula quietly stops being true —
cost if wrong: one fewer spacing interval against a rate-limited tenant on a request
we are abandoning anyway.`

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

---

# S4b slice 3 — the QUEUE half (#138), second sitting

The driver half merged at `1822da5d6`. This is the queue, the runner, the sync-now
route, and the two review findings that landed on them.

## Rulings

Ruling: the lease is a DERIVED EXPRESSION on the driver's exported constants, never a
literal — `(DEFAULT_TIMEOUT_MS + max(BACKOFF_CEILING_MS, MAX_RETRY_AFTER_MS)) *
(DEFAULT_MAX_RETRIES + 1)` = 160000. A copied number stops being true the moment any
constant moves and nothing says so; the sync would just start losing its lease mid-run.
If it is wrong, a dead worker's job is either unclaimable too long or claimable while
its worker is alive.

Ruling: no multiplier on that ceiling. Doubling it looked prudent because a run does two
enumerations and then an unbounded apply — but the heartbeat renews every `leaseMs / 2`
for as long as the PROCESS lives, so the lease never has to span a run, only the longest
gap in which a live worker might fail to renew. I had written 320000; QA-1's RF-3 probe
caught it. If the reasoning is wrong, a genuinely dead worker's job waits twice as long
as it needs to.

Ruling: the provider is part of the job TYPE (`directory.sync:lark`), and both the
handler map and the lease map are keyed by the BASE type through one shared
`baseTypeOf`. One helper rather than two so the lookups cannot drift — a job leased for
160s that then fails "No handler for ..." is the shape of that drift. If wrong, a new
provider silently has no handler and a 30s lease.

Ruling: `JobRuntime.tick` claims with the MAXIMUM lease over the registered types, and
`run` renews with each job's own. Given one number for a mixed claim, too long delays
takeover of a dead worker (bounded, visible, recoverable) while too short lets a second
worker claim a job whose first worker is alive and mid-run — the concurrent apply this
slice exists to prevent. The cost is stated at the tick site and pinned by RF-6: a
`telemetry.flush` claimed alongside a sync wears 160s until its own first heartbeat.

Ruling (ORG_CAPABILITIES, PMO item g): `directory.sync` stays OUT of ORG_CAPABILITIES
and the literal stays 12. The trigger is a server route only; a capability in that list
with no UI reading it is a claim nothing checks. If a UI trigger is added, it moves
12→13 in the same commit as the UI.

Ruling (RF-5 boundary assertion): `nextRunAt` is pinned on its WALL-CLOCK FIELDS
(13:00:00) rather than an exact instant. `later` carries the millisecond of the instant
it searches from, so the boundary returns 13:00:00.001 — a quirk of the library, not of
the cron expression. A literal string would fail the day the library rounds differently
while the behaviour under test is unchanged. Accepted by PMO.

Ruling (TL-2's finding, option (a)): the lease predicate is re-checked at the APPLY
site, between entities, using the claim's own predicate verbatim. Passing `lease` is
optional and absent means unguarded — `applyDirectoryPlan` is called directly by tests
and by any future non-job caller, and requiring a lease would make them invent one,
which is a guard that always passes.

## Two corrections to reviewers, both settled by MEASUREMENT

**QA-1 on RF-2b: `policy_versions` cannot witness convergence.** The stated mechanism is
right — `addGroupMember` bumps unconditionally on an upsert, so a worker re-deriving
everything writes as many rows again. The conclusion does not follow. Mutant MB is
exactly that worker (current memberships forced empty, so all 5 are re-applied): the
version delta came back 18 against an expected 16, RED. An unconditional bump is what
makes the count SENSITIVE to redundant work; what would hide it is asserting "more than
before" instead of an exact delta. QA-1's `group_members` witness was kept as a PAIR,
not a replacement: the delta sees redundant WRITES, the row set sees a broken END STATE,
and neither implies the other.

**#142 (SlowBuffer/jsonwebtoken) was MY ERROR — closed not-reproducible.** I reported
that any suite importing `jsonwebtoken` dies under jest because `SlowBuffer` is
undefined, and claimed to have verified it on an unmodified tree. The cause was my
runner: `npx` re-resolves its own node, so even
`/opt/homebrew/opt/node@22/bin/npx jest` ran under the machine default node 26, where
`SlowBuffer` was removed. A probe printing `process.version` inside jest prints v26.7.0
via npx and v22.23.1 via `/opt/homebrew/opt/node@22/bin/node ./node_modules/.bin/jest`.
Dev5 could not reproduce it because there was nothing to reproduce.

**Lesson (§7.17): an absolute path to `npx` does not pin the node it runs.** Invoke
`<node-22>/bin/node ./node_modules/.bin/jest` directly. The failure is expensive because
it looks like a codebase fault, reports "Test suite failed to run" with 0 tests, and
survives being "verified on a clean tree" — the verification runs under the same wrong
interpreter. It also HID a real bug of mine for an hour (see below).

## What the wrong interpreter was hiding

Running the route suite properly turned up a genuine defect in my own route:
`jobs.traceId` is NOT NULL and I passed `request.id ?? undefined` — express has no
`request.id`, so every enqueue violated the constraint and the route answered 500. The
catch logged only `error.message`, which Prisma leaves empty on a constraint error, so
its one real failure mode produced a blank log line. Both fixed: a generated uuid, and
the log now carries name + code + message. The test caught it the moment it could run,
which is the argument for the route suite existing at all.

## Mutants fired (all killed unless noted)

- MA takeover applies nothing (TL-2/TL-1's F2 mutant) · MB worker 2 re-derives from
  empty current state · MC membership count not incremented · MD only the first
  membership written.
- M5A `nextRunAt = now + 1ms` instead of the cron boundary — **SURVIVED** the first
  RF-5, exactly as QA-1 predicted; killed once the boundary itself was asserted.
- M5B per-call UUID idempotency key · M5C registration enqueues directly (killed by
  RF-5b alone — the runtime test cannot see it, which is why both halves exist).

## Residuals

1. **The lease guard is per ENTITY, not per write, and that is safe only because the
   apply is IDEMPOTENT.** The window itself is small — a lease can expire in the
   microseconds between the check and the write, and that one entity still lands — but
   the window is not what makes it acceptable. What makes it acceptable is that every
   entity write is idempotent on its natural key (#133/#134): `upsertGroup` and
   `upsertUser` key on `(orgId, source, externalId)` and on the identity link, and
   `addGroupMember`/`removeGroupMember` are an upsert and a `deleteMany`. So the one
   entity that slips through is a write the winning worker either already made or is
   about to make, and the end state is the same.

   THE MOMENT THAT CHANGES, THIS BECOMES A REAL DEFECT. Any non-idempotent entity write
   — an append, a counter, an increment, a "create without checking first", an outbound
   notification — is a write that lands TWICE across two workers, and the per-entity
   guard will not stop it. Whoever adds such a write owns closing this window first.

   Follow-up: the claim predicate inside each `policyRepository` write, which makes the
   check and the write one atomic step. Dev5's lane, after #136.
2. **No registered provider is directory-sync-capable today.** oidc/saml/ldap all answer
   `directorySync: false`, and `LarkIdentityProvider` is not in the registry
   (`identity_providers` has no `appId`/`appSecret` columns either). So the sync-now
   route's ALLOW path is unreachable in production — every real provider takes the 404
   branch — and the scheduled sync cannot resolve a real driver. `runDirectorySync`
   takes an injected driver and throws a named error otherwise. The route suite pins
   both halves and registers a stub for the allow path; the `lark → 404` assertion is
   written to be the one that flips when the S4a follow-up lands.
3. **The route suite's grant is a FIXTURE, not the seed.** It creates the
   `directory.sync` permission and its super_admin grant itself, because the seed slice
   is Dev1's branch. Every assertion is about the ROUTE given a grant; a seed-only
   install could hold no grant and this suite would stay green. QA-3 runs the holder
   assertion on the merged pair — that is the only place it means anything.
4. Carried from #134: status `'failed'` is still never written, and the membership
   counts are still CALLS rather than net changes.

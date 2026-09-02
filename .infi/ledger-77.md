# Ledger — issue 77: rate limits frozen at module load

Branch `approof/s3-ldap`, on top of `origin/approof/main` @ `5610e098`.
Commits: `df5fcc95` (code), `a004eee3` (S11 mockup docs, separate issue).
Opened by QA-3; scope narrowed after recon.

## The defect, as measured

`limiter()` read both `windowMs` and `limit` from the environment once, at
construction (`requestControls.js:100-101` via `integerEnv`), and all seven
limiters are module-level `const`. So each limit was frozen with whatever
`process.env` held the first time the module was required in that process.

Proven by running, not reading:

```
same module object: true
-> a later env change cannot affect an already-loaded limiter
```

Operator-visible consequence: raising or lowering a ceiling has no effect until
the process restarts, and nothing says the setting is deferred rather than
broken. Tightening a limit during an incident is exactly when waiting for a
restart window is least acceptable.

## Rulings

Ruling: `limit` becomes a function; `windowMs` stays load-time. If this is wrong,
changing a window still needs a restart — accepted. The alternative is worse:
`express-rate-limit` passes `windowMs` to the store's `init()`, and
`BoundedMemoryStore` caches it (`:17-19`) to compute every entry's `resetTime`,
so changing it mid-flight gives entries created before and after the change
different expiry schedules, with nothing declaring that. Windows also change far
less often than limits.

Ruling: the store is NOT made per-request. If this is wrong we keep a shared
counter across configuration changes — which is correct, because
`resetRequestControls()` holds those exact store objects and other suites call it
in `beforeEach`. A fresh store per request would have those resets clearing
something nobody is counting in, and state would leak between tests while the
suite still looked green.

Ruling: the cross-suite collision claim in the original issue is NOT part of this
fix, and the closing comment must not claim it. I could not make it red — three
suites setting the same variables to different values pass together, in parallel
and under `--runInBand`. QA-3 independently reached the same conclusion and said
so. If this is wrong we shipped without a regression for a real defect; the
alternative is claiming to have fixed something unproven, which leaves a reader
believing a guard exists where none does.

Ruling: this is NOT the root cause of the ldap flake and will not be described as
one (PMO ruling, carried).

Ruling: QA-3's probe is kept ALONGSIDE my own rather than deduplicated. If this
is wrong we carry one redundant test. It is not redundant: theirs drives
`loginAccountRateLimit` (keyed ip+username), mine drives `inviteRateLimit`
(keyed ip). They are separate `limiter()` calls, and one reading the environment
late proves nothing about the other six.

## A claim of mine that changed

I told PMO the env cleanup in the identity suites was "hygiene, guarding against
something that cannot happen". That was true *while limits were frozen* — a
leftover value could not affect anything, because nothing read it after load.

The fix inverts it. Limits are now read per request, so a value one suite leaves
behind is a value the next suite's limiters would genuinely read if they shared a
process. Still not reproducible (jest isolates the module registry per file), so
it stays unproven — but it is no longer a guard against the impossible, and the
distinction is recorded because the justification changed after I published it.

## Mutation proof

| mutant | expected kill | result |
|---|---|---|
| drop the arrow: `limit: integerEnv(...)` | the two RED cases + QA-3's probe | exactly 3 of 7 failed |

The four pre-existing tests stayed green under the mutant, so the new tests fail
for their own reason rather than as collateral.

One test — the malformed/unset fallback — was green before the fix and is a
GUARD, not a RED: reading per request must not turn a typo into an unlimited
endpoint. Recorded so nobody counts it as evidence the bug existed.

## Evidence

`__tests__/requestControlsHttp.test.js` + the ldap and saml route suites —
Tests: 36 passed, 36 total, 3 suites. The identity suites are in the contract
because they set rate-limit env at module scope and depend on it for the whole
run; they are what proves a dynamic limit did not break the existing behaviour.

Per §7.14 this branch ran the named suites only; the full run is the gate's.

## Housekeeping

`task.sh start` requires an issue of its own, so #79 was opened solely to declare
this contract and closed immediately as a duplicate. The contract, RED/GREEN and
mutation results are posted on #77.

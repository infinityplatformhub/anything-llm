# ledger-130 — the disconnect hook, tested by behaviour

## Rulings

Ruling: KEEP the source-grep alongside the new test rather than replacing it.
They answer different questions — the grep answers "is this file still
registered and still shaped like a hook", the new test answers "does running it
release the pool". If wrong: one redundant assertion.

Ruling: assert `typeof captured === "function"` before invoking it. Without it a
module that registers nothing leaves `captured` null and the run reports a
TypeError, which reads as a broken test rather than as "the hook registered
nothing". If wrong: nothing — it is one extra line. It earned its place
immediately: the first version of this test failed on exactly this guard.

Ruling: restore `global.afterAll` and `jest.dontMock` in a `finally`. These
tests run under `--runInBand`, so a swap left installed would follow into every
later suite in the process. If wrong: the failure would appear in an unrelated
suite, which is the expensive kind.

Ruling (#130 item 1): close the "timeout 500 -> 2000ms" half as STALE, change
nothing. `c2fdb8dc8` already replaced the fixed sleep with a poll against a
10 s deadline. The 500/2000 still in the file are inside a COMMENT recording
QA-2's measurement (4/6 runs at 500 ms, 6/6 at 1000 and 2000) — evidence that
the number was tuning a race. Setting it to 2000 would reintroduce the sleep
that commit removed. If wrong: a race returns.

## Corrections against myself

CORRECTION: I told the PMO that an in-process assertion CANNOT catch
`if (false) $disconnect()`, and argued for a child-process test instead. I was
wrong, and I was wrong in the worst available way: I read the comment at
lines 60-65 claiming "nothing behavioural can catch it" and reasoned from it
instead of spending five minutes trying it. TL-2 tried it and it works.

The comment was a CLAIM someone had written down, not a measurement, and I
treated it as a fact about the world. That comment is now rewritten, and the
residual is stated narrowly: what cannot be tested from inside is only that
jest itself runs a registered `afterAll`. Everything up to "the callback we
handed jest disconnects the client" is behaviour, and now asserted.

CORRECTION: my first implementation used `delete require.cache[modulePath]` to
force a re-require. It captured nothing — jest serves modules from its OWN
registry, so deleting from Node's cache re-requires nothing at all. Caught by
the `typeof` guard, which is why that guard is in the ledger as a ruling rather
than a detail. Fixed with `jest.isolateModules`.

CORRECTION: the second implementation captured the callback but recorded zero
calls. The hook requires `utils/prisma` LAZILY, inside the callback, so invoking
it after `jest.dontMock` reached the real client. The call now happens while the
mock is still installed. Both of these were found by running, not by review.

## Evidence

Mutations on `__tests__/support/disconnectPrisma.js`, all confirmed RED:

| mutation | result |
|---|---|
| baseline | 13 passed |
| `if (false) await prisma.$disconnect()` | 1 failed — **new test only**; the grep passes it |
| empty `afterAll` body | 2 failed (new test + grep) |
| `$disconnectt` typo | 2 failed (new test + grep) |
| restored | 13 passed |

The M4 row is the point of the issue: the source-grep cannot see it, because
`if (false) await prisma.$disconnect()` matches every pattern the grep looks
for. That is the hole this test closes.

`npx jest --runInBand __tests__/utils/test/connectionBudget.test.js`
→ Test Suites 1 passed, Tests 13 passed, EXIT=0.

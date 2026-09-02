# Dev5 — #142 ledger: teardown hook timeouts (plain tier)

**Skills invoked:** `systematic-debugging` (the original claim did not reproduce, so the
first job was finding what people were actually seeing); `test-driven-development`;
`verification-before-completion`.

Branch `approof/142-jwt-polyfill` off `origin/approof/main` @ `08b27e0ee`.

---

## Rulings

Ruling: the reported defect (jsonwebtoken failing to import on node 22 via
`buffer-equal-constant-time` reading `SlowBuffer.prototype`) does NOT exist in this
codebase and no polyfill was added — because under jest's `node` environment
`require("buffer").SlowBuffer` is a function with a prototype and `jsonwebtoken`
imports clean, and the two suites named in the report run 18 and 11 tests rather than
0 — if wrong, a polyfill would have been added to the shared setup for a condition
nothing in CI or locally produces, and it would never have been exercised.
**Confirmed independently:** Dev3's failure was `npx` re-resolving to node 26 despite a
node@22 PATH. A toolchain fault, not a codebase one. Own runs now use
`/opt/homebrew/opt/node@22/bin/node ./node_modules/.bin/jest`.

Ruling: the real defect is an `afterAll` with no timeout argument doing slow external
work — because jest's DEFAULT hook timeout is 5 s while `beforeAll` in the same file
carries `300_000`, and the teardown drains live HTTP connections, disconnects a pool
and runs `DROP DATABASE ... WITH (FORCE)` against a server shared with other
worktrees' gates — if wrong, the suite reports `● Test suite failed to run` with exit
1 while all 18 tests PASS, which reads exactly like an import-time crash and is almost
certainly what was filed as the SlowBuffer bug.

Ruling: the guard is a STRUCTURAL test, not a behavioural one — because the defect is
load-dependent and I measured both directions rather than assuming — if wrong, the
fixture is green on an idle machine and the mutation survives.

```
untimed afterAll, machine busy (3 concurrent suites) -> Exceeded timeout of 5000 ms
                                                        for a hook; FAILED; exit 1
untimed afterAll, machine idle, 4 consecutive runs   -> passed every time; exit 0
```

A behavioural fixture cannot witness this: idle, the untimed hook finishes in ~50 ms.
What is always true is that the hook declares a timeout, so that is what is asserted.

Ruling: the guard skips ITSELF when scanning — because its own CONTROL holds a sample
hook as a string literal, which a text scanner cannot distinguish from a real one — if
wrong, the guard reports itself as an offender forever. The alternative is parsing
JavaScript properly, which is a much larger thing to get right for one check.

Ruling: scope is `DROP DATABASE` and `server.close` only, not all 42 `afterAll` hooks
that touch a database — because a hook that only disconnects a pool is fast and
bounded, and a guard that fires on correct code gets suppressed rather than obeyed.

Ruling: offenders are NAMED in the failure, not counted — because a count tells the
next person something is wrong and nothing about where, and this failure mode is
specifically hard to recognise from its symptom.

Ruling: `hookTimeouts.test.js` is the SOLE reliable witness for this defect — because
the protected suite passes WITH the mutant applied on an idle machine (mine: 4
consecutive runs, exit 0; QA-2 independently: 3 runs, ~2 s teardown against a 5 s
default), so no assertion about that suite's outcome can hold the fix in place — if
wrong, the `30_000` is deleted by a future reader as an unnecessary argument and
nothing anywhere goes red until CI is loaded enough to hit it again. The timeout
matters under load only; the guard is what makes that invisible property enforceable.

Ruling: the scanner walks the TREE, not a fixed list — because a hard-coded file list
covers only what existed the day it was written, and the next HTTP suite someone adds
is exactly the one nobody remembers to add to it — if wrong, the guard silently stops
covering new files while continuing to report green.

Ruling: coverage is limited to the `afterAll(async () => {` shape and is stated in the
test — because callback and plain-function hook forms and every `afterEach` are
unscanned, and a known untimed one exists today (`endpoints/removeAndUnembedHttp.test.js:90`,
`afterAll((done) => …)` closing a server) — if wrong, the guard's green is read as
"every teardown in the tree is timed", which is broader than what it checks. Left for
a follow-up issue rather than widened here.

---

## Audit — every `afterAll` doing slow external work

Scanned all 42 test files with a brace-matching scan (a regex stops at the first inner
brace and reads the timeout off the wrong paren). Two offenders, both fixed; every
other slow teardown in the tree already carries one.

| file | line | work | before | after |
|---|---|---|---|---|
| `security/authorization/assignableRolesHttp.test.js` | 176 | DROP DATABASE + server.close | none | `30_000` |
| `security/authorization/offboardUser.test.js` | 376 | server.close | none | `30_000` |

30 s, not 300 s: these hooks should take under a second, so the number absorbs a loaded
machine rather than hiding a hang. A teardown that genuinely needs minutes is a defect
and this timeout is still short enough to say so.

---

## Evidence

```
RED   assignableRolesHttp on a clean tree   exit 1, "Tests: 18 passed, 18 total",
                                            "● Test suite failed to run",
                                            "Exceeded timeout of 5000 ms for a hook"
GREEN same suite, timeout added             exit 0, 18 passed
```

### Mutants

| # | mutation | result |
|---|---|---|
| MA | remove the `30_000` from `assignableRolesHttp` | **1 red** (the guard names the file and line) |
| MB | replace brace matching with `indexOf("}")` | **2 red** (the CONTROL catches it) |
| M-load | untimed hook + 3 concurrent suites | **18 failed** — `sorry, too many clients already` |

MB is why the CONTROL exists: a scanner whose matcher silently returns nothing makes
the main assertion pass forever, green because it examined no hooks at all.

The M-load run also shows the second-order cost: an untimed teardown that misses its
window leaves the pool open, and a 100-connection server with several worktrees running
gates then fails every test in the next suite with `sorry, too many clients already` —
the exact failure #122's `disconnectPrisma.js` setup file exists to prevent.

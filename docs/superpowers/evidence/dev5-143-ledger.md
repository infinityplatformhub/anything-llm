# Dev5 — #143 ledger: the hook scanner covered one syntactic form (plain tier)

**Skills invoked:** `test-driven-development`; `systematic-debugging` (the false kill);
`verification-before-completion`.

Branch `approof/143-hook-shapes` off `origin/approof/main` @ `900ddf057`.
Follow-up to #142, from `.infi/recon/issue-hook-scanner-shapes.md`.

---

## Rulings

Ruling: the opener matches by ARGUMENT SHAPE, not by enumerated spellings — one regex
accepting an optional `async`, then a parenthesised parameter list or a bare
identifier, then `=>` or `function` — because enumerating forms is the defect itself:
the #142 version spelled out `afterAll(async () => {` and silently exempted 11 hooks,
one of which (`removeAndUnembedHttp.test.js:90`) was untimed the entire time the guard
reported green — if wrong, the next form someone writes is exempt again and the
exemption is invisible because the check passes.

Ruling: `afterEach` is scanned alongside `afterAll` — because nothing stops slow
external work appearing in a per-test teardown, and the 5 s default applies there
identically — if wrong, moving a `DROP DATABASE` from `afterAll` to `afterEach` escapes
the guard while looking like a refactor.

Ruling: the CONTROL carries one sample PER SHAPE — because a control covering only the
arrow form goes green against the single-shape scanner this issue exists to replace,
which is precisely how the gap survived #142 — if wrong, the guard's own test cannot
tell a working matcher from the broken one it replaced.

Ruling: comments are BLANKED (replaced with spaces) before scanning, not stripped —
because line numbers in the offender list must still point at the real line — if wrong,
the guard reports hooks three lines off and the reader stops trusting it.

---

## The false kill, which is the useful part of this issue

The first version of my own fix comment on `removeAndUnembedHttp.test.js` contains the
text `afterAll(async () => {` **as prose**, describing the shape the old scanner
matched. The new scanner matched that comment, brace-matched into the code beneath it,
and reported the file as an offender — three lines above its actual hook, and on the
very file the same commit had just fixed.

Nothing about that was anticipated; it appeared as a failing run naming a line that had
no hook on it. It generalises: **any file that documents this rule would trip the guard**,
including the guard's own eventual documentation. Comment blanking is the fix and
`CONTROL: a hook mentioned in a COMMENT is not a hook` is the witness — a sample with
the hook text in a `//` line and a `/* */` block, asserting exactly one hook is found.

This is the dispatch rule ("quoted path list = one jest pattern = false kill") in a
different costume: a matcher that cannot tell code from text about code produces a
confident wrong answer rather than an error.

---

## Fix

`endpoints/removeAndUnembedHttp.test.js:90` — `afterAll((done) => …)` closing a server,
now `}, 60_000)`. The number is copied from `endpoints/t4aRouteIdor.test.js:86`, the
same shape which already carried it — which is what the recon meant by "the fix is a
one-line copy".

## Evidence

```
contract  node ./node_modules/.bin/jest __tests__/utils/test/hookTimeouts.test.js \
                                        __tests__/endpoints/removeAndUnembedHttp.test.js
          -> Test Suites: 2 passed   Tests: 7 passed, 7 total
          offenders list empty across all four shapes
```

### Mutants — one per shape, as dispatched

| # | mutation | result |
|---|---|---|
| M1 | opener back to `afterAll(async () => {` only (the #142 regression) | **1 red** |
| M2 | drop `afterEach` from the opener | **1 red** |
| M3 | drop the `function` form from the opener | **1 red** |
| M4 | remove comment blanking | **3 red** (all three, incl. the false-kill CONTROL) |
| M5 | revert `removeAndUnembedHttp:90` to untimed | **1 red**, naming file and line |
| M6 | revert `t4aRouteIdor:86` to untimed | **1 red**, naming file and line |

M1 is the important one: it is exactly the state this codebase was in yesterday, and it
now goes red.

## Residual

A hook whose slow work is inside a HELPER remains unscanned — this reads text, not a
call graph. Stated in the test rather than left implied, so the guard's green is not
read as "every teardown in the tree is timed".

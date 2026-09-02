# Techlead-2 review — #40 task 1 `a2bbb0de8` (router walk as the primary gate)

**Verdict: PASS**, with one NIT on a diagnostic message. Every attack I designed against the
primary gate is caught, including four that no AST anchor could ever have seen. One
methodological finding about my own run is recorded below, because it is the more useful
result.

Independent worktree `/tmp/tl2-40b` (`git worktree add --detach`), `node_modules`
hardlink-copied from `/tmp/base91`, `prisma generate` run, Node v22.23.1. Per §7.14 no
full-directory run. Worktree clean; `index.js` and the sweep suite restored after every
injection.

Baseline: **46 passed, 46 total**.

---

## The restructure is the right one, and the attacks prove it rather than assert it

The gate is now a walk over every mounted route, ignoring provenance entirely. I attacked it
with seven route shapes chosen because each defeats a *different* anchor — file position,
require call, path literal, import at all — and all seven are caught:

| attack | shape | result |
|---|---|---|
| X1 | `apiRouter.post("/x1-inline-probe", [validatedRequest], …)` — no import, no registrar, no `./endpoints/` literal | **3 failed** |
| R6 | same, mounted on `app` rather than `apiRouter` | **3 failed** |
| R1b | ungated route inside a **new** `express.Router()` mounted with `.use()` | **3 failed** |
| R2 | `setTimeout(() => apiRouter.post(...), 0)` — mounted after the walk | **2 failed** |
| R3 | `apiRouter.all("/r3-all-probe", …)` | **3 failed** |
| R3b | `app.all("*", …)` mounted early — shadows every route after it | **3 failed** |
| R5a | fake gate: `Object.assign(fn, {action, resolveResource})` | **5 failed** |
| R5b | same-named function spoof: `function permissionRequired(...)` | **2 failed** |

R5a and R5b are the pair that matters most. A naive check on "has `action` and
`resolveResource`" or on `handle.name === "permissionRequired"` passes both; identity through
the WeakSet registries passes neither. R5a failing *more* tests than a plain ungated route is
the right signature — it is caught by the resolver-identity check as well as the gate check.

R1b is the one I was least sure of. Nothing in the tree mounts a sub-router today, so the
recursion in `mountedRouteLayers` guards a case that does not yet exist — and it catches it.
Given the 50-versus-356 measurement Dev2 reported (a walk without recursion sees 14% of this
router), that recursion is not defensive programming, it is the difference between measuring
the system and measuring a corner of it.

**R2 deserves its own note.** The snapshot-then-`setImmediate`-then-snapshot test fails
*and* the gate test fails, which is the correct pair: one says "the router changed after I
looked", the other says "and what appeared is ungated". Either alone would be weaker — the
first without the second would flag benign late mounts, the second without the first would
depend on scheduling luck.

## Mutating the walk itself

| mutation | result |
|---|---|
| `mountedRouteLayers` stops recursing into `layer.handle.stack` | **5 failed** |

So the recursion is load-bearing in the tests as well as in principle: a walk that regressed
to direct mounts only would be caught rather than silently reporting a clean 14%.

## M-12 — the `Tests: 0 total` guard, checked as agreed

Dev2 flagged that three of their mutations produced `Tests: 0 total` and that the guard moved
to the gate as a `CONTRACT_EXPECT` pin. I broke a suite deliberately — injected
`require("./__does_not_exist__")` at the top of `routeGateSweep.test.js`:

```
Cannot find module './__does_not_exist__' from '…/routeGateSweep.test.js'
Test Suites: 1 failed, 1 passed, 2 total
Tests:       13 passed, 13 total
exit=1
```

**A crashed suite is distinguishable, and the distinguishing signal is not the test count.**
`Tests:` reports only the suite that ran (13, not 46), and `Test Suites: 1 failed` plus a
non-zero exit are what carry the failure. So a pin on the *exact* string
`Tests: 46 passed, 46 total` does catch this — the count changes — but it catches it as a
number mismatch rather than as "a suite did not run", and it would equally fire on someone
legitimately adding a test.

That is acceptable at the gate, where a human reads the diff. It is worth being precise about
what it proves: the pin detects *any* change in the count, of which a crashed suite is one
case. The exit code and `Test Suites: N failed` are the direct signals.

**This bit me during this review and the lesson generalises.** My first R-battery run reported
`Tests: 0 total` for four attacks and I nearly recorded them as caught. They were not caught —
they never ran. Two separate causes: my injection anchor (`const ENDPOINT_REGISTRATIONS = [`)
had become `Object.freeze([` in this SHA so the `python3` replace silently no-op'd on some
runs, and my injected probes referenced `validatedRequest`, which is **not in `index.js`'s
scope** — producing `ReferenceError` at import and a suite that failed to run.

`0 total` and `46 passed` look equally green in a grep for `^Tests:`. I only noticed because
`0 total` is implausible. **A mutation harness needs to assert its mutation applied and that
the suite executed**, or it reports "caught" for edits that never happened. I have added an
explicit inject-confirmation step to my own scripts.

## M-9 — the diagnostic's false-positive behaviour (NIT)

Under the new structure the AST scan is defence-in-depth. I checked what a stray
`./endpoints/` literal does to it.

A literal *containing* the path is fine — the collector keys on `startsWith`, so
`"see ./endpoints/example for the pattern"` is invisible: **33 passed**.

A literal that genuinely *starts* with it fails:

```js
const ENDPOINT_DOC_PATH = "./endpoints/README.md";
```
```
✕ every imported endpoint registrar appears in the production list
  Unsupported endpoint import at line 102: use top-level unaliased destructuring,
  e.g. const { exampleEndpoints } = require("./endpoints/example")
```

Failing is **correct** — default-deny is the whole design, and a path-shaped literal that is
not a require is exactly the kind of thing that should be looked at rather than assumed
harmless. The NIT is the message: it says "use top-level unaliased destructuring", which is
not advice a documentation constant can act on. Someone hitting this has a valid line and an
instruction that does not apply, and that is the moment a diagnostic gets switched off.

One sentence in the error would close it — something like *"if this string is not a module
path, move it out of index.js or add it to the declared exceptions."* Not blocking: the
behaviour is right and the frequency is low.

## Numbers

`mountedRoutesAtTestLoad` is pinned at **309**; Dev2's own dump reports **356**. Both are
correct and count different things — the test counts each route layer once, the dump expands
`app.all("*")` into its 35 per-method entries. Anyone comparing across the two will see a
phantom 47-route gap. Worth a line in the suite so the next person does not chase it.

The terminal 404 is exempted by **exported handler identity, final position, and being the
only wildcard** — not by path shape. R3b confirms an early wildcard is caught rather than
mistaken for it.

## Reproduction

```
git worktree add --detach /tmp/tl2-40b a2bbb0de8
cp -al /tmp/base91/server/node_modules /tmp/tl2-40b/server/node_modules
cd /tmp/tl2-40b/server && npx prisma generate
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" STORAGE_DIR=$(mktemp -d) \
       SIG_KEY=$(openssl rand -hex 32) SIG_SALT=b API_KEY_PEPPER=$(openssl rand -hex 32) \
       DATABASE_URL="postgresql://postgres:pw@127.0.0.1:55472/t5"
npx jest __tests__/security/authorization/routeGateSweep.test.js \
         __tests__/security/authorization/workspaceCapabilities.test.js --runInBand
```

Each attack injected one line above `const ENDPOINT_REGISTRATIONS = Object.freeze([` in
`index.js`, requiring `validatedRequest` explicitly since it is not in that file's scope, and
`index.js` was restored from a backup after every run.

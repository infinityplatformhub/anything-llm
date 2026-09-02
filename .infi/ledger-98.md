# Ledger — #98: refuse route mounts after boot

Dev 3. Branch `approof/98-mount-guard`. Tier plain. Recon merged as
`docs/superpowers/recon/98-runtime-mount-guard.md`.

## The residual, measured twice

`routeGateSweep` asserts at a moment. Re-measured for the recon rather than quoted:
a `setImmediate` mount is caught (2 failed/31), a `setTimeout(…, 5000)` mount escapes
with 33/33 green and an ungated `POST /api/probe98-late` reachable. Waiting longer only
moves the boundary, which is why a guard was needed rather than a better assertion.

Nothing exploits it today — no deferred mount exists in the tree. This prevents one
from being added.

## Rulings

Ruling: throw in every environment, no production exemption. Arming at the end of
module evaluation means a bad mount fails the process at BOOT, not mid-request, so the
availability objection is much weaker than it first sounds; and a lazily-required
module that mounts on first request is precisely the bug this exists to kill. If wrong:
an operator meets a hard boot failure they can clear with the env escape. (PMO.)

Ruling: the escape is `ROUTE_MOUNT_GUARD=off`, compared by EXACT value — not
presence-based. I raised this against the original ruling and PMO changed it.
`EMBED_REQUIRE_*` is presence-based and its own comment gives the reason: under boolean
parsing a typo silently DISABLES a gate the operator believes is on, while presence
means the worst case is an unexpected 401, visible in minutes. That reasoning depends
on presence meaning the guard is ON. A flag that DISABLES a guard inverts it —
presence-based, `ROUTE_MOUNT_GUARD=false` switches the guard off for someone who meant
to switch it on, and the failure is an ungated route mounting silently, which is the
exact outcome this issue exists to prevent. If wrong: the protection is off in the
deployments that most believe it is on. (Dev 3 raised, PMO ruled.)

Ruling: arm after the `if/else` at `index.js:208`, not at the end of the registration
loop. The development branch mounts `apiRouter.post("/v/:command")` after that loop, so
arming earlier throws on every dev boot. This point is also where the codebase already
draws its line — the terminal 404 must be last, and `routeGateSweep` asserts it is.

Ruling: seal mutating methods only, on BOTH `app` and `apiRouter`. They are different
objects and #40's escaping mutation used `app.post`. `get`/`head` are excluded because
production legitimately mounts `app.get`/`app.use` after the seal point; a guard that
fires on correct code gets deleted.

## Evidence

- 52/52 in the new suite plus the existing `routeGateSweep` (33 of those are the
  sweep, which must stay green — this supplements it and replaces nothing).
- Sweep `security/authorization/`: 666 passed, 0 failed (647 before).
- **Four mutants, each killed by its named test and no other:**
  - N1 remove `sealRoutes(...)` from `index.js` → the wiring test
  - N2 seal `get` as well → both read-method tests
  - N3 make the flag presence-based → the typo table, all 9 cases
  - N4 arm at the end of the registration loop → the dev-boot test alone

## A false test I wrote, found by mutation

N2 initially killed only ONE of the two read tests. The reason was a defect in my own
test: it asserted `/robots.txt` and `/manifest.json` are present after boot, but those
mount at `index.js:166`/`:171`, which is BEFORE the seal at `:219`. They are present
whether or not `get` is sealed, so the test passed while proving nothing (§7.9).

Rewritten to assert the state the seal actually leaves behind — after boot a read route
can still be added and a mutating one cannot — after which N2 kills both. Recorded
because the test looked entirely reasonable, and only a mutant killing fewer tests than
expected exposed it.

## A jest trap worth knowing

`delete require.cache[path]` is a NO-OP under jest, which keeps its own module registry:
the second `require` silently returns the first load's module. My dev-boot test failed
in a way that looked like the guard breaking development boot, when in fact development
boot had never run — the helper returned the module cached from the earlier
`NODE_ENV=test` load. `jest.resetModules()` is the working form. Verified the code was
correct by loading `index.js` in a standalone node process first, before touching it.

## TL-2 round 2: four bypasses, measured over real HTTP

TL-2 drove four post-boot mounts and got 200 from every one — none needing a reference
captured before the seal, which is what my first residual claimed was required. That
sentence was wrong and has been removed from the module docs.

I re-probed each on express 4.22.1 before changing anything:

```
PROBE app.all:              NO THROW    → mounted
PROBE apiRouter.all:        NO THROW    → mounted
PROBE app.route().post:     NO THROW    → mounted
PROBE apiRouter.route().post: NO THROW  → mounted
PROBE apiRouter.use(sub):   NO THROW    → mounted
PROBE apiRouter.post:       THREW       (the plain case, already covered)
```

Ruling: `all` IS sealed, contrary to the assumption that it had to stay open for
`terminalNotFound`. The 404 does not need to be mounted after the seal — it needs to be
LAST IN THE STACK, which is a different requirement. Moving `app.all("*")` above the
seal satisfies both, and `routeGateSweep` still asserts it is the final layer. If wrong:
boot throws immediately and loudly, which N7 demonstrates rather than assumes.

Ruling: `.route()` is sealed too. It was not in TL-2's list under that name but is the
same defect — `.route(path)` returns a FRESH Route whose `.post`/`.all` this seal never
wrapped, so `app.route("/x").post(h)` walked straight past it. Found by probing, not by
reading the code. Sealing the factory closes it: no Route is handed out after boot.

Ruling: `use(subRouter)` is NOT sealed, and cannot be. `use` is how all middleware
mounts — sealing it refuses the static handler, the body parsers, and every legitimate
late `app.use`. Closing it means sealing recursively at mount time, which changes what
`use` means; that is **issue #119**, opened with the probe output and a proposed
contract, not a line in this one.

## Evidence, round 2

- 60/60 (was 52). Seven mutants now, each killed by its named test:
  - N1 remove the seal call → wiring test
  - N2 seal `get` → both read-method tests
  - N3 presence-based flag → the typo table, 9 cases
  - N4 arm at the registration loop → dev-boot test
  - N5 remove `all` from SEALED_METHODS → A1
  - N6 stop sealing `.route()` → the `.route()` test
  - N7 move the terminal 404 back below the seal → **11 tests**, because `index.js`
    then throws at load. The ordering is load-bearing and now proven so.

## Residual risks

1. **`use(subRouter)` mounts after boot and its routes are reachable.** Live, measured,
   and covered by a test that asserts it DOES mount — so whoever closes it gets a red
   test forcing a deliberate decision, rather than a stale comment claiming coverage.
2. **A sub-router captured before the seal stays writable.** The seal holds exactly two
   references. No module in the tree does this today; same treatment as (1) — a test
   asserts the current behaviour rather than a comment describing it.
3. **`ROUTE_MOUNT_GUARD=off` genuinely disables it.** That is the point of an escape
   hatch, and the error logged on every boot is the only thing keeping it visible.

## Environment note

`prom-client@15.1.3` is declared in `package.json` (another dev landed `utils/metrics`
on main mid-branch) but was absent from this worktree, so every test that loads
`index.js` failed with "Cannot find module 'prom-client'". That looked exactly like the
guard breaking boot. `yarn install --frozen-lockfile` fixed it; no dependency was added
or changed. Same class as the pinned-versions lesson: a declared version that is not
installed reads as a code defect.

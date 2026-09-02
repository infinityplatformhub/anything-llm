# Techlead-1 review — #40 task 1 `a2bbb0de` (Dev2, worktree `f40`) — **PASS**, 2 NITs

The router-walk rewrite. Delta cf4dc6167..a2bbb0de8 is 6 files / +320 −100:
`ENDPOINT_REGISTRATIONS` frozen, `terminalNotFound` extracted and exported,
`isPermissionGate` added as a WeakSet registry beside `isApiKeyGuard`,
`buildRouter` reduced to a cache-busting re-require of the real `index.js`, and the
sweep rewritten to walk the mounted router.

Per §7.14 no suites — I re-ran my own bypass probes in the worktree, including the
four I raised last round. Created `endpoints/hiddenProbe.js` and
`utils/hiddenProbe2.js`, ran, deleted; `git status` clean at the end.

---

## All three directions tested. All three hold.

### Direction 1 — a known gate disappearing (subtractive)

Removed `requirePermission("invite.create", orgResource)` from
`POST /admin/invite/new` and re-walked:

```
BASELINE                                  routes 309 | ungated 0
S1 remove requirePermission from route    routes 309 | ungated 1 ["POST /admin/invite/new"]
RESTORED                                  routes 309 | ungated 0
```

Red on the route that lost its gate, and green again on restore. Note the route
*count* is unchanged — this direction is invisible to a snapshot and is caught only
by the per-route gate check, which is the point of having both.

### Direction 2 — an unknown router appearing (additive) — every X shape is now RED

This is where my acceptance of `e875cd1` failed. All six:

```
X1  inline route in index.js, no registrar   310 routes | ungated 32 | POST /probe/tl1-inline
X2  registrar under ./utils/                 310 routes | ungated 32 | POST /probe/tl1-registrar
X3  `hiddenProbeEndpoints (apiRouter);`      310 routes | ungated 32 | POST /probe/tl1-registrar   (bypass 8)
X4  member import .mountProbeRoutes          310 routes | ungated 32 | POST /probe/tl1-member      (bypass 10)
X5  module.require + call                    310 routes | ungated 32 | POST /probe/tl1-registrar   (bypass 14)
X7  imported AND listed (the "legit" path)   310 routes | ungated 32 | POST /probe/tl1-registrar
```

X7 is the one worth dwelling on: doing everything *right* — importing the registrar
and adding it to the frozen list — still fails, because the route it mounts has no
gate. That is the difference between the old design and this one. The AST scan could
never have caught X7; the walk catches it without knowing the shape exists.

X1 and X2 are the two that no source-level check could reach at all (no import, and
a path outside `./endpoints/`), and they are now indistinguishable from any other
ungated route.

### Direction 3 — the list mutated after declaration

```
X6  ENDPOINT_REGISTRATIONS.push(fn)   THREW: Cannot add property 32, object is not extensible
```

`Object.freeze` closes it at the language level rather than by assertion, and
`production endpoint registration list is immutable` pins both `isFrozen` and the
throw.

## Baseline is green for the right reason

```
allowlist size: 31 | ungated after allowlist: 0 | allowlist-missing: 0
```

31 unguarded mutating routes, 31 allowlist entries, **zero entries naming a route
that no longer exists**. That last number is the one that makes the allowlist honest:
the test asserts every entry is still reachable, so a stale exemption cannot sit
there excusing nothing while looking like diligence. Each entry carries a reason
string and the reason length is asserted — the same discipline as #78's
`nonManagerCallers`.

## The wildcard exemption is by identity, not by path

```
wildcard routes: 1 | terminal is last? true | terminal stack length: 35
```

Exempting `path === "*"` would have been the obvious shortcut and a fresh hole — any
new `app.all("*")` mounted earlier would inherit the exemption. Instead
`terminalNotFound` is exported and the exemption is `layer === terminalWildcard`,
where that layer is found by *every handler in its stack being that exact function*
and is asserted to be the last mounted route. Three independent conditions, all
identity-based.

The 35-deep stack is worth noting: `app.all("*")` registers one layer per HTTP
method, and the test asserts `stack.length > 1` — so a mutant replacing one of those
handlers with something else would break the `every` check.

## `buildRouter` now uses the real app

The old helper rebuilt a router from the registration list, which meant the sweep
tested a *reconstruction* of production rather than production. It is now a
cache-busting `require` of `index.js` returning the real `app`. That closes the gap
where the helper's own mounting logic could diverge from `index.js`'s — and it is
what makes X1 (a route mounted directly in `index.js`, outside any registrar)
visible at all.

`isPermissionGate` mirrors `isApiKeyGuard`: `Symbol.for` registry, frozen binding,
`typeof` guard, and a test that a forged `{action, resolveResource}` object is not
accepted. The gate check requires **both** the permission-gate identity **and** a
registered resolver identity, so a real gate wired to an unregistered resolver still
counts as ungated.

---

## NIT-1 — a new ungated route can hide behind an allowlisted signature

The allowlist is keyed by `"METHOD /path"`, and the gate check consults it by
signature. Probed:

```
A1  apiRouter.post("/invite/:code", ungatedHandler)
    routes 310 | ungated 0        <- the new route is excused by the existing entry
    snapshot 309 -> 310            <- but the snapshot catches it
```

`POST /invite/:code` is legitimately allowlisted (invite acceptance ingress). A
second, ungated route registered at the same signature is waved through by the
signature lookup. **The 309 snapshot is what catches it** — which is the argument
for keeping the snapshot rather than treating it as a maintenance cost, and it is
worth saying so in the comment next to it. Today the two checks cover each other;
if someone later relaxes the snapshot to `toBeGreaterThan(300)` because it is
noisy, this hole opens silently.

Cheaper hardening if wanted: assert each allowlisted signature matches **exactly
one** mounted layer, which turns a duplicate into a red test on its own.

## NIT-2 — R-2's walk-twice does not reach an `setImmediate` mount

The residual is stated honestly in the code (*"routes mounted asynchronously after
this point are outside this synchronous startup contract"*), and
`mounted route snapshot stays stable through immediate timers` awaits `setImmediate`
then `setTimeout(0)`. But that test compares two snapshots taken **inside the same
test**, while the assertion test uses `mountedRouteLayers` captured at describe-body
evaluation. Measured:

```
sync snapshot:                 309
after setImmediate + timeout:  310, /probe/late present
```

So the walk-twice test *would* go red on an async mount — it is doing its job. What
does not happen is the **gate check** re-running against the later snapshot: the
route appears, is ungated, and no gate assertion ever sees it. The stability test
catches the *change*, not the *ungatedness*, and only because the two happen to
coincide today.

Not a defect — the residual is declared and the deferral is reasonable. Worth one
line saying the stability test is what stands in for gate-checking late mounts, so
nobody deletes it as redundant.

---

## Verdict

**PASS.** This is the right design: the assertion is about the assembled router, not
about how the source is written, so it holds against shapes nobody has thought of
yet. The AST scan survives as a diagnostic that says *where*, which is the role I
argued for.

My acceptance of `e875cd1` was wrong in exactly the way this SHA fixes, and I have
now tested the direction I missed.

## Reproduction

```
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
export API_KEY_PEPPER=... JWT_SECRET=... NODE_ENV=test
cd .claude/worktrees/f40/server        # at a2bbb0de8
node /tmp/tl1-probe40.js   # X1..X7 against the real walk
node /tmp/tl1-sub2.js      # subtractive: strip a gate, re-walk
node /tmp/tl1-sub3.js      # A1 allowlist-signature collision
node /tmp/tl1-sub4.js      # async mount vs the two snapshots
```

Each probe writes `index.js`, re-requires with the module cache cleared, and
restores the file in a `finally`. Probe endpoint files were created and deleted;
`git status` is clean.

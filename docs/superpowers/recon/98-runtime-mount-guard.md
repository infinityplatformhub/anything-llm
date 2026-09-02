# #98 recon — runtime guard against route mounts after boot

Author: Dev 3. Base `approof/main` @ `524c98e6b`. Tier: **plain**.
Issue opened by Dev 2, split out of #40 (NIT-2).

Recon only. No code written; per PMO, nothing is touched until #96's verdict lands.

## 0. The residual, re-measured

I re-ran #98's two measurements rather than quote them, by injecting a mount into
`server/index.js` above `terminalNotFound` and running the gate:

| injected mount | gate result |
|---|---|
| `setImmediate(() => apiRouter.post("/probe98-immediate", …))` | **caught** — 2 failed / 31 passed |
| `setTimeout(() => apiRouter.post("/probe98-late", …), 5000)` | **escapes** — 33/33 green |

Baseline on the untouched tree is 33/33. The claim holds exactly as written: an
ungated `POST /api/probe98-late` is mounted and reachable, and the gate reports
success. `index.js` restored; the tree is clean.

The two failures in the caught case are worth naming, because they say the design is
sound: the sweep itself AND the "mounted route snapshot stays stable through immediate
timers" test both go red. The stability test is what turns "the snapshot was taken at
the right moment" from an assumption into an assertion.

**What the residual is not.** Asynchrony does not escape — `setImmediate` is caught.
Only a mount that lands after the test body has finished escapes, and waiting longer
just moves the boundary. That is why this cannot be closed by a better test.

**Nothing exploits it today.** No deferred `apiRouter.*` mount exists in the tree
(re-checked: the only mounts are the registration loop at `index.js:145-148` and the
development-only `/v/:command` at `:181`). This issue prevents one from being added.

## 1. The three questions #98 leaves open, and what the code says about each

### 1a. Where "boot completed" is

**Not** the end of the registration loop. `index.js:179-207` mounts
`apiRouter.post("/v/:command", …)` *after* that loop, in the `NODE_ENV ===
"development"` branch. A guard armed at line 148 throws on every development boot.

Candidates, in order of how much they actually cover:

1. **After the `if/else` at `:208`, before `app.all("*")`.** Covers everything that
   mounts during module evaluation, including the dev route. Simple, and the terminal
   404 is the natural "nothing may be added after this" marker — it is already the
   thing that must be last, and `routeGateSweep` already asserts it is
   (`terminalWildcard === mountedRoutesAtTestLoad.at(-1)`).
2. **After `bootHTTP`/`bootSSL` resolves.** Later, but boot is async and
   `require.main === module` gates it, so under jest — where the suite imports
   `index.js` directly — it never runs. A guard armed there would be inert in exactly
   the place the gate proves things.

(1) is the one I would propose. It coincides with an invariant the codebase already
asserts, rather than adding a second notion of "started".

### 1b. Throw in production, or only outside it

The honest framing: a throw at runtime converts a **silent ungated route** into a
**loud crash**. Both are bad; they are not equally bad, and which is worse depends on
when it fires.

- Arming happens at the end of module evaluation, so anything that trips the guard
  trips it *at boot*, not mid-request — the process dies on startup rather than
  serving traffic with a hole. That is a much weaker objection than "a throw at
  runtime is an availability risk" suggests.
- But a mount from a lazily-`require`d module reached on first request would throw
  inside a request. That is the case worth thinking about, and it is precisely the
  case the guard exists to catch.

Three shapes, and the third is the one I would argue for:

- **Always throw.** Strongest, and consistent with the codebase's existing habit
  (`refuseBoot` at `:88-94` exits non-zero rather than limping on).
- **Throw outside production, log in production.** Safe, and the pattern LDAP's
  `LDAP_ALLOW_INSECURE` uses — but a protection that degrades in production is weakest
  exactly where it matters, which is the argument S3's ruling made *against* silent
  degradation.
- **Always throw, with a documented env escape** (`ALLOW_LATE_ROUTE_MOUNT=1`) that
  logs an error on every boot when set. Same shape as `LDAP_ALLOW_INSECURE` and
  `SIMPLE_SSO_ISSUE_UNSAFE_ALLOW`: the deployment can survive an emergency, and it
  cannot do so quietly.

### 1c. `app.*` versus `apiRouter.*` — and a trap

`apiRouter` is a local `const` in `index.js:64` and is exported nowhere; no module
under `endpoints/` mentions it by name. So wrapping the object is enough — there is no
second reference to miss.

**But the name is a trap.** `endpoints/admin.js` declares `function adminEndpoints(app)`
and calls `app.post(...)` eight times — and it is registered as a bare function, so
`register(apiRouter)` passes the router in. Those are `apiRouter.post` calls that
*read* as `app.post`. A guard implemented by grepping for the identifier `apiRouter`,
or a test fixture that injects via `app.post` believing it tests the other path, will
be wrong about which object it is touching.

This also answers the third question directly: **`app` and `apiRouter` are different
objects** (`app` is the express application, `apiRouter` the router mounted at `/api`),
and #40's mutation used `app.post`. A guard on `apiRouter` alone leaves `app.post`
open. Both want wrapping, and the express app's own `.use`/`.get` are used after boot
by the static-file and MetaGenerator branches, so the guard must cover *mutating
methods only* or it will fire on legitimate mounts.

## 2. Shape I would propose

A small module — `server/utils/boot/sealRouter.js` — exporting `sealRoutes(...targets)`
that replaces each target's `post`/`put`/`patch`/`delete`/`options` with a function
that throws, called once from `index.js` after `:208`.

- `get`/`head` are left alone: the sweep exempts them, and the static/Meta branches
  legitimately mount `app.get` after that point.
- The thrown error names the method, the path, and the fact that the route would have
  been ungated — an error a developer can act on without reading this document.
- It is not a `Proxy`: express reads these as own properties and the router is a
  plain object, so assignment is enough and a Proxy would add a layer to every lookup.

## 3. Evidence contract I would propose

- RED: the `setTimeout(…, 5000)` mount above must **throw** with the guard in place,
  and the test asserting that must fail without it — the probe in §0 is the fixture,
  already measured.
- The `setImmediate` case keeps failing the existing sweep (the guard does not replace
  it; both hold).
- Development boot still works: a test that loads `index.js` with
  `NODE_ENV=development` and finds `/v/:command` mounted. Without this, the obvious
  wrong arming point ships green.
- `app.get`/`app.use` after the seal still work — the static and MetaGenerator branches
  are real mounts after `:208` in production mode.
- Mutation: remove the seal call from `index.js` → the late-mount test goes red.
- Mutation: seal `get` as well → the development-boot test goes red.

## 4. Open question for PMO

**1b is a real decision, not a detail**: does a late mount kill the process in
production, or log? My recommendation is throw-always plus a loudly-logged env escape,
on the S3 precedent — but "the guard may take production down" deserves an explicit
ruling rather than my inference from an unrelated ruling about TLS.

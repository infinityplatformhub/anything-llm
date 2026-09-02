// #98: refuse route mounts after boot.
//
// `routeGateSweep` proves every mounted mutating route carries authorization, but
// it asserts at a MOMENT. Measured on `6b93aba1e` and re-measured for this issue:
// a `setImmediate` mount is caught (the sweep AND its snapshot-stability test both
// go red), a `setTimeout(…, 5000)` mount escapes with the suite green and an
// ungated POST reachable. Waiting longer only moves the boundary, so the residual
// cannot be closed by a better test — it needs a guard that outlives the assertion.
//
// Nothing exploits this today: no deferred mount exists in the tree. This prevents
// one from being added.
//
// WHAT THIS DOES AND DOES NOT CATCH. TL-2 drove four post-boot mounts over real
// HTTP and got 200 from every one, none of them needing a reference captured before
// the seal. Stated plainly, because a guard believed to cover more than it does is
// worse than a smaller guard understood correctly:
//
//   CAUGHT  app.all / apiRouter.all      — `all` writes to a Route directly and
//                                           never passes through `post`; unsealed it
//                                           mounts every verb at once
//   CAUGHT  .route(path).post(...)       — `.route()` hands out a FRESH Route whose
//                                           methods this seal never wrapped
//   CAUGHT  apiRouter.post / app.post …  — the plain case
//   NOT     use(subRouter)               — `use` is how all middleware mounts, so
//                                           sealing it refuses the static handler,
//                                           body parsers, and every legitimate late
//                                           `use`. A sub-router brings its own stack
//                                           and nothing in it crossed a sealed
//                                           method. Closing this means sealing
//                                           recursively at mount time, which changes
//                                           what `use` means — issue #119.
//   NOT     a sub-router captured earlier — the seal holds two references; anything
//                                           that grabbed a router before it keeps an
//                                           unsealed handle. No module does this today.
//
// Both uncovered cases have tests that assert they DO mount, so closing either one
// turns those red and forces a deliberate decision rather than leaving a stale claim.

/**
 * Mutating methods only.
 *
 * `get`/`head` are deliberately absent. The sweep exempts them, and index.js
 * legitimately mounts `app.get("/robots.txt")`, `app.get("/manifest.json")` and
 * `app.use("/")` AFTER the seal point in production — sealing those would make the
 * guard fire on correct code, and a guard that cries wolf gets removed.
 */
const SEALED_METHODS = Object.freeze([
  "post",
  "put",
  "patch",
  "delete",
  "options",
  // TL-2: `all` is NOT reducible to the others. express's `app.all` loops the
  // method table and writes to a Route directly — it never passes through
  // `app.post` — so an unsealed `all` mounts every verb at once. Measured on
  // express 4.22.1: with `all` absent from this list, `app.all("/probe", h)` and
  // `apiRouter.all(...)` both mounted with no throw. #40's own R3 mutation was
  // `apiRouter.all`, so this is the shape the guard most needs to catch.
  //
  // index.js therefore mounts its terminal 404 (`app.all("*")`) BEFORE the seal.
  "all",
]);

/**
 * The escape hatch, compared by exact value.
 *
 * NOT presence-based, and the asymmetry is the whole point. `EMBED_REQUIRE_*` flags
 * are presence-based because presence means the guard is ON, so a typo (`=false`)
 * fails toward safety — its worst case is an unexpected 401, visible in minutes.
 * A flag that DISABLES a guard inverts that: presence-based, `ROUTE_MOUNT_GUARD=false`
 * would switch the guard off for an operator who meant to switch it on, and the
 * failure is an ungated route mounting silently — exactly what this module exists to
 * prevent, and exactly the silent shape the embed comment says to avoid.
 *
 * So only the literal string `off` disables it. `false`, `0`, `no`, `OFF`, and an
 * empty value all leave the guard armed.
 */
function guardDisabled(env = process.env) {
  return env.ROUTE_MOUNT_GUARD === "off";
}

/**
 * Seal one or more route targets so mutating mounts after boot throw.
 *
 * Both `app` and `apiRouter` want sealing: they are different objects, and #40's
 * escaping mutation used `app.post`. Note that `endpoints/admin.js` declares
 * `adminEndpoints(app)` and calls `app.post` — but it is registered as a bare
 * function, so it RECEIVES apiRouter. The local name says nothing about which
 * object is being mounted on, which is why this seals by reference rather than by
 * anything resembling a name.
 *
 * @param {...Object} targets express app / router instances
 * @returns {{sealed: boolean, reason: string}}
 */
function sealRoutes(...targets) {
  if (guardDisabled()) {
    // Every boot, not once: a protection that degrades quietly is worse than one
    // that is absent, because the deployment believes it is protected. Same
    // reasoning as LDAP_ALLOW_INSECURE (S3) and SIMPLE_SSO_ISSUE_UNSAFE_ALLOW.
    console.error(
      "\x1b[31m[ROUTE MOUNT GUARD DISABLED]\x1b[0m ROUTE_MOUNT_GUARD=off — routes " +
        "mounted after boot will NOT be refused, and a route added that way is not " +
        "checked by the startup authorization sweep. Unset this as soon as the " +
        "situation that required it is over."
    );
    return { sealed: false, reason: "disabled_by_env" };
  }

  for (const target of targets) {
    // `.route(path)` returns a FRESH Route object whose own `.post`/`.all` were
    // never wrapped, so `app.route("/x").post(h)` mounted straight past an earlier
    // version of this seal — found by probing, not by reading. Sealing the factory
    // is what closes it: no Route can be handed out after boot to write on.
    if (typeof target.route === "function") {
      target.route = function refuseLateRoute(path) {
        throw new Error(
          `[route mount guard] .route(${String(path)}) was called after boot ` +
            `completed. A Route obtained this way mounts without passing through ` +
            `the sealed methods, so it would ship ungated and unnoticed. Register ` +
            `it in ENDPOINT_REGISTRATIONS instead. If a deployment genuinely must ` +
            `allow this, set ROUTE_MOUNT_GUARD=off — it logs an error every boot.`
        );
      };
    }

    for (const method of SEALED_METHODS) {
      const original = target[method];
      if (typeof original !== "function") continue;
      // Plain assignment, not a Proxy: express reads these as own properties on an
      // ordinary object, so a Proxy would add a trap to every property lookup on the
      // router for no gain.
      target[method] = function refuseLateMount(path) {
        throw new Error(
          `[route mount guard] ${method.toUpperCase()} ${String(path)} was mounted ` +
            `after boot completed. Routes added after startup are invisible to the ` +
            `authorization sweep (routeGateSweep.test.js), so this one would ship ` +
            `ungated and unnoticed. Register it in ENDPOINT_REGISTRATIONS instead. ` +
            `If a deployment genuinely must allow this, set ROUTE_MOUNT_GUARD=off — ` +
            `it logs an error on every boot.`
        );
      };
    }
  }
  return { sealed: true, reason: "sealed" };
}

module.exports = { sealRoutes, guardDisabled, SEALED_METHODS };

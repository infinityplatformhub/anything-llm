/**
 * #98: routes mounted after boot are refused.
 *
 * `routeGateSweep` asserts every mounted mutating route carries authorization, but
 * it asserts at a moment. Measured for the recon, not argued: a `setImmediate`
 * mount is caught by that sweep; a `setTimeout(…, 5000)` mount escapes it entirely,
 * leaving an ungated POST reachable while the suite reports 33/33 green. This is
 * the guard that closes what an assertion cannot.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "h98-guard-")
  );
process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER || "guard-test-api-key-pepper-32-bytes-min";
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "test-jwt-secret-at-least-12-chars";

const express = require("express");
const {
  sealRoutes,
  guardDisabled,
  SEALED_METHODS,
} = require("../../../utils/boot/sealRoutes");

describe("#98: the seal itself", () => {
  test("every mutating method throws after sealing, naming the method and path", () => {
    const router = express.Router();
    sealRoutes(router);

    for (const method of SEALED_METHODS) {
      expect(() => router[method]("/late", () => {})).toThrow(
        new RegExp(`${method.toUpperCase()} /late`)
      );
    }
  });

  test("the reproduction from the recon: a deferred mount throws instead of mounting", async () => {
    // The exact shape that escaped routeGateSweep — a mount scheduled past the
    // moment any assertion could take. Driven through a real timer rather than
    // called directly, so the test exercises what the residual actually is.
    const router = express.Router();
    sealRoutes(router);

    const attempt = new Promise((resolve) => {
      setTimeout(() => {
        try {
          router.post("/probe98-late", (_, response) => response.sendStatus(200));
          resolve({ mounted: true });
        } catch (error) {
          resolve({ mounted: false, message: error.message });
        }
      }, 10);
    });

    const result = await attempt;
    expect(result.mounted).toBe(false);
    expect(result.message).toMatch(/mounted after boot completed/);
    // And nothing was added: the refusal is a refusal, not a throw after the fact.
    const paths = (router.stack ?? [])
      .filter((layer) => layer.route)
      .map((layer) => layer.route.path);
    expect(paths).not.toContain("/probe98-late");
  });

  test("read methods still mount — index.js mounts app.get AFTER the seal point", () => {
    // In production index.js mounts /robots.txt, /manifest.json and the SPA
    // catch-all after the seal point. Sealing `get`/`use` would make the guard fire
    // on correct code, and a guard that fires on correct code gets deleted.
    const app = express();
    sealRoutes(app);
    expect(() => app.get("/robots.txt", () => {})).not.toThrow();
    expect(() => app.use("/", () => {})).not.toThrow();
  });

  test("both app and apiRouter are sealed — they are different objects", () => {
    // #40's escaping mutation used `app.post`, so a guard on the router alone
    // leaves the app open. Sealing is by reference: `endpoints/admin.js` declares
    // `adminEndpoints(app)` and calls `app.post`, but RECEIVES apiRouter — the
    // local name says nothing about which object is mounted on.
    const app = express();
    const router = express.Router();
    sealRoutes(app, router);
    expect(() => app.post("/a", () => {})).toThrow();
    expect(() => router.post("/b", () => {})).toThrow();
  });
});

describe("#98: the escape hatch is exact-valued, and fails toward the guard staying on", () => {
  // `EMBED_REQUIRE_*` flags are presence-based BECAUSE presence means the guard is
  // on: a typo (`=false`) then fails toward safety, worst case an unexpected 401.
  // A flag that DISABLES a guard inverts that reasoning — presence-based,
  // `ROUTE_MOUNT_GUARD=false` would switch the guard OFF for an operator who meant
  // to switch it on, and the failure would be an ungated route mounting silently.
  // So only the literal `off` disables it. Each value below is a typo somebody will
  // actually make.
  const stillArmed = ["false", "0", "no", "OFF", "Off", "off ", "", "true", "on"];

  test.each(stillArmed)("ROUTE_MOUNT_GUARD=%p leaves the guard armed", (value) => {
    expect(guardDisabled({ ROUTE_MOUNT_GUARD: value })).toBe(false);
  });

  test("an unset variable leaves the guard armed", () => {
    expect(guardDisabled({})).toBe(false);
  });

  test("only the exact string 'off' disables it", () => {
    expect(guardDisabled({ ROUTE_MOUNT_GUARD: "off" })).toBe(true);
  });

  test("disabling actually lets a late mount through, and says so on every boot", () => {
    const errors = [];
    const spy = jest.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args.join(" "));
    });
    const previous = process.env.ROUTE_MOUNT_GUARD;
    process.env.ROUTE_MOUNT_GUARD = "off";
    try {
      const router = express.Router();
      const result = sealRoutes(router);
      expect(result).toMatchObject({ sealed: false, reason: "disabled_by_env" });
      // The escape is real — otherwise it is not an escape hatch, it is a lie.
      expect(() => router.post("/allowed-through", () => {})).not.toThrow();
      // And it is loud. A protection that degrades quietly is worse than one that
      // is absent, because the deployment believes it is protected.
      expect(errors.join("\n")).toMatch(/ROUTE MOUNT GUARD DISABLED/);
    } finally {
      if (previous === undefined) delete process.env.ROUTE_MOUNT_GUARD;
      else process.env.ROUTE_MOUNT_GUARD = previous;
      spy.mockRestore();
    }
  });
});

describe("#98: the guard is actually wired into index.js", () => {
  // Defined, exported, and mounted nowhere is the defect QA-2 found twice on S11
  // (#71's invite limiter, #80's mailer-test limiter): in both cases the limiter
  // existed, the tests drove it directly, and removing the mount left the suite
  // green. Mounted and tested are two claims. These load the REAL index.js.

  // `jest.resetModules()`, not `delete require.cache[...]`. Jest keeps its own
  // module registry, so deleting from require.cache is a NO-OP under jest: the
  // second load silently returns the first load's module. That cost a red test
  // whose failure looked like the guard breaking development boot, when what had
  // actually happened was that development boot never ran.
  const loadServer = ({ nodeEnv }) => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = nodeEnv;
    jest.resetModules();
    try {
      return require("../../../index");
    } finally {
      process.env.NODE_ENV = previousEnv;
      jest.resetModules();
    }
  };

  const mountedPaths = (router) =>
    (router?.stack ?? []).filter((layer) => layer.route).map((layer) => layer.route.path);

  test("a late mutating mount on the REAL app is refused after boot", () => {
    const { app } = loadServer({ nodeEnv: "test" });
    expect(() => app.post("/probe98-wiring", (_, res) => res.sendStatus(200))).toThrow(
      /mounted after boot completed/
    );
  });

  test("development boot still mounts /v/:command — the guard is armed AFTER it", () => {
    // index.js:181 mounts `apiRouter.post("/v/:command")` in the development branch,
    // AFTER the registration loop. Arming at the end of that loop — the obvious
    // reading of "boot completed" — throws on every development boot, and without
    // this test that mistake ships green because no other suite runs in that mode.
    expect(() => loadServer({ nodeEnv: "development" })).not.toThrow();

    const { app } = loadServer({ nodeEnv: "development" });
    const apiLayer = (app._router?.stack ?? []).find(
      (layer) => layer.name === "router" && layer.handle?.stack
    );
    expect(apiLayer).toBeDefined();
    expect(mountedPaths(apiLayer.handle)).toContain("/v/:command");
  });

  test("production boots, and READ routes stay mountable on the real app afterwards", () => {
    // Note what this can and cannot prove. index.js mounts /robots.txt (:166) and
    // /manifest.json (:171) BEFORE the seal at :219, so their presence says nothing
    // about the seal's scope — a version that sealed `get` would still show them,
    // and an earlier draft of this test asserted exactly that and passed while
    // proving nothing (§7.9).
    //
    // What is worth asserting is the state the app is left in: after boot, a read
    // route can still be added and a mutating one cannot. That is the seal's actual
    // contract, and sealing `get` turns the first half red.
    const { app } = loadServer({ nodeEnv: "production" });
    const paths = (app._router?.stack ?? [])
      .filter((layer) => layer.route)
      .map((layer) => layer.route.path);
    expect(paths).toContain("/robots.txt");
    expect(paths).toContain("/manifest.json");

    expect(() => app.get("/late-read", () => {})).not.toThrow();
    expect(() => app.post("/late-write", () => {})).toThrow(
      /mounted after boot completed/
    );
  });
});

describe("#98 (TL-2): the ways a mount can dodge a naive seal", () => {
  // Every case here was MEASURED against express 4.22.1 before it was written.
  // With `all` absent from SEALED_METHODS and `.route` unsealed, all three mounted
  // with no throw — probe output recorded in the ledger.

  const loadReal = () => {
    jest.resetModules();
    const mod = require("../../../index");
    return mod;
  };

  const apiRouterOf = (app) => {
    // `apiRouter` is a `const` in index.js and exported nowhere, so the only honest
    // way to reach the real object is through the mounted layer. Asserting against
    // `app.post` and calling it an apiRouter test would be testing a different
    // object than the one that serves /api (TL-2 A2).
    const layer = (app._router?.stack ?? []).find(
      (l) => l.name === "router" && l.handle?.stack
    );
    expect(layer).toBeDefined();
    return layer.handle;
  };

  test("A1: app.all and apiRouter.all are refused — `all` does not route through `post`", () => {
    // express's `all` writes to a Route directly, so wrapping `post` alone leaves
    // it open, and an unsealed `all` mounts EVERY verb at once. #40's own R3
    // mutation was `apiRouter.all`.
    const { app } = loadReal();
    const apiRouter = apiRouterOf(app);

    expect(() => app.all("/late-all-app", () => {})).toThrow(
      /mounted after boot completed/
    );
    expect(() => apiRouter.all("/late-all-router", () => {})).toThrow(
      /mounted after boot completed/
    );

    // And nothing was mounted — a throw after the fact would still leave the route.
    const appPaths = (app._router?.stack ?? [])
      .filter((l) => l.route)
      .map((l) => l.route.path);
    expect(appPaths).not.toContain("/late-all-app");
    const routerPaths = (apiRouter.stack ?? [])
      .filter((l) => l.route)
      .map((l) => l.route.path);
    expect(routerPaths).not.toContain("/late-all-router");
  });

  test("the terminal 404 still exists and is still last, despite `all` being sealed", () => {
    // index.js mounts `app.all("*")` — so sealing `all` naively breaks boot. The
    // 404 moved ABOVE the seal instead. If someone later moves the seal back up,
    // this fails rather than the app silently losing its 404.
    const { app, terminalNotFound } = loadReal();
    const routeLayers = (app._router?.stack ?? []).filter((l) => l.route);
    const last = routeLayers.at(-1);
    expect(last.route.path).toBe("*");
    expect(last.route.stack.every(({ handle }) => handle === terminalNotFound)).toBe(
      true
    );
  });

  test("A2: the REAL apiRouter refuses a late mount — reached through the mounted layer", () => {
    const { app } = loadReal();
    const apiRouter = apiRouterOf(app);
    expect(() => apiRouter.post("/late-on-real-router", () => {})).toThrow(
      /mounted after boot completed/
    );
  });

  test("A3: the refusal is durable — a second attempt throws too", () => {
    // A wrapper that restored the original after firing once would refuse the first
    // late mount and admit every one after it, which is worse than no guard: the
    // failure would look handled.
    const { app } = loadReal();
    const apiRouter = apiRouterOf(app);
    expect(() => apiRouter.post("/late-1", () => {})).toThrow();
    expect(() => apiRouter.post("/late-2", () => {})).toThrow();
    expect(() => apiRouter.post("/late-3", () => {})).toThrow();
  });

  test(".route() is refused — it hands out a fresh Route the seal never wrapped", () => {
    // Found by probing rather than review: `app.route("/x").post(h)` mounted
    // straight past an earlier version of this seal, because `.route()` returns a
    // NEW object whose own `.post` was never touched.
    const { app } = loadReal();
    const apiRouter = apiRouterOf(app);
    expect(() => app.route("/late-route-app")).toThrow(/\.route\(/);
    expect(() => apiRouter.route("/late-route-router")).toThrow(/\.route\(/);
  });

  test("a READ route added after boot still works, on the real app", () => {
    // TL-2 (1): asserting that /robots.txt is present proves nothing, because it
    // mounts at :166 — BEFORE the seal. The claim worth testing is what the seal
    // leaves possible AFTERWARDS, so this calls app.get once boot has finished.
    const { app } = loadReal();
    expect(() => app.get("/late-read-after-boot", () => {})).not.toThrow();
    expect(() => app.use("/late-use-after-boot", () => {})).not.toThrow();
  });
});

describe("#119: use(subRouter) is sealed recursively; middleware is not", () => {
  // The two tests below REPLACE assertions that said these mounts succeed. #98
  // wrote them that way on purpose — "if someone later closes this hole, they go
  // red and force a deliberate decision instead of leaving a stale claim about
  // coverage lying around". This is that decision, and inverting them is how it
  // is recorded.

  const loadReal = () => {
    jest.resetModules();
    return require("../../../index");
  };
  const apiRouterOf = (app) =>
    (app._router?.stack ?? []).find((l) => l.name === "router" && l.handle?.stack)
      ?.handle;

  test("a sub-router use()d after boot is refused, on app and on apiRouter", () => {
    // Was: "RESIDUAL: use(subRouter) mounts after boot, and its routes are
    // reachable". A sub-router carries its own stack, so nothing inside it ever
    // crossed a sealed method and `routeGateSweep` cannot see it — the same
    // invisibility a late direct mount has.
    const express = require("express");
    const { app } = loadReal();
    const apiRouter = apiRouterOf(app);

    const sub = express.Router();
    sub.post("/inside", (_, response) => response.sendStatus(200));

    expect(() => apiRouter.use("/late-sub", sub)).toThrow(/after boot/i);
    expect(() => app.use("/late-sub-app", sub)).toThrow(/after boot/i);

    // and it did not mount despite throwing
    expect((apiRouter.stack ?? []).some((l) => l.handle === sub)).toBe(false);
  });

  test("ordinary middleware still mounts after boot", () => {
    // The half that makes the naive fix wrong, so it gets the most explicit
    // proof: `use` is how EVERY middleware mounts. A guard that refuses these
    // fires on correct code and gets deleted within a week.
    const express = require("express");
    const { app } = loadReal();

    expect(() => app.use(express.json())).not.toThrow();
    expect(() => app.use(express.urlencoded({ extended: true }))).not.toThrow();
    expect(() => app.use((_, __, next) => next())).not.toThrow();
    // A mounted path plus a plain function — the shape index.js uses for the
    // static handler and the SPA catch-all.
    expect(() => app.use("/static-ish", (_, __, next) => next())).not.toThrow();
  });

  test("index.js's own post-boot mounts still work on the real app", () => {
    // Not hypothetical middleware: the exact calls production makes after the
    // seal point. If these throw, the app does not boot.
    const express = require("express");
    const { app } = loadReal();

    expect(() =>
      app.use(express.static(require("path").resolve(__dirname, "..")))
    ).not.toThrow();
    expect(() => app.get("/robots.txt", (_, r) => r.send("ok"))).not.toThrow();
    expect(() => app.use("/", (_, r) => r.sendStatus(200))).not.toThrow();
  });

  test("DEPTH: a router mounted onto a router mounted after boot is sealed too", () => {
    // One level is not the contract. Sealing only the router handed to `use`
    // would leave `outer.use("/in", inner)` as the next bypass, one line longer
    // than the one being closed.
    const express = require("express");
    const { app } = loadReal();

    const outer = express.Router();
    const inner = express.Router();

    // The outer router is refused at mount — and the seal is applied to it on
    // the way in, so writing to it afterwards is refused as well.
    expect(() => app.use("/outer", outer)).toThrow(/after boot/i);
    expect(() => outer.post("/direct", () => {})).toThrow(/after boot/i);
    expect(() => outer.use("/in", inner)).toThrow(/after boot/i);
  });

  test("a router built and populated BEFORE being use()d is refused as a whole", () => {
    // The realistic shape: nobody mounts an empty router. The routes are added
    // first, then the router is mounted — so the seal has to refuse the MOUNT,
    // not merely the writes.
    const express = require("express");
    const { app } = loadReal();

    const sub = express.Router();
    sub.post("/a", () => {});
    sub.get("/b", () => {});
    expect(() => app.use("/prebuilt", sub)).toThrow(/after boot/i);
  });

  test("read-only mounts are unaffected, since index.js depends on them", () => {
    const { app } = loadReal();
    expect(() => app.get("/manifest.json", (_, r) => r.json({}))).not.toThrow();
  });

  test("F2: an express() SUB-APP is refused too, though it has no .stack", () => {
    // The fixture that kills the discriminator I first shipped. Measured on
    // express 4.22.1: a sub-app keeps its layers under `._router`, which does
    // not exist at all until its first route mounts, so `Array.isArray(.stack)`
    // reports FALSE for a sub-app and lets it straight through. A sub-app
    // mounts routes exactly like a Router does.
    const express = require("express");
    const { app } = loadReal();
    const apiRouter = apiRouterOf(app);

    const subApp = express();
    expect(Array.isArray(subApp.stack)).toBe(false); // why .stack cannot be the test
    subApp.post("/inside", (_, response) => response.sendStatus(200));

    expect(() => apiRouter.use("/late-subapp", subApp)).toThrow(/after boot/i);
    expect(() => subApp.post("/after", () => {})).toThrow(/after boot/i);
  });

  test("F3: a router mounted EMPTY and filled afterwards is refused at both moments", () => {
    // The shape that recursion alone cannot catch, and the reason the argument
    // is SEALED as well as refused: walking `.stack` at mount time reads an
    // empty array and finds nothing, while the object is still held and its
    // `.post()` still works. TL-2 drove this to 200 over HTTP on the #98 SHA.
    const express = require("express");
    const { app } = loadReal();
    const apiRouter = apiRouterOf(app);

    const empty = express.Router();
    expect(empty.stack.length).toBe(0); // nothing to recurse into

    expect(() => apiRouter.use("/late-empty", empty)).toThrow(/after boot/i);
    expect(() => empty.post("/deep", () => {})).toThrow(/after boot/i);
    expect(() => empty.all("/deep-all", () => {})).toThrow(/after boot/i);
  });

  test("F9: .route() on a refused sub-router is sealed too", () => {
    // #98 closed `.route(path).post()` on app and apiRouter because `.route()`
    // hands out a FRESH Route whose methods this seal never wrapped. A
    // sub-router that only got SEALED_METHODS would leave the identical hole
    // one level down.
    const express = require("express");
    const { app } = loadReal();

    const sub = express.Router();
    expect(() => app.use("/late-route", sub)).toThrow(/after boot/i);
    expect(() => sub.route("/x")).toThrow(/after boot/i);
  });

  test("F7: nesting is sealed at depth, through a router that was ALREADY populated", () => {
    // Two levels, built before the mount so the recursion has something real to
    // walk: use(A) where A already carries B, and B carries a POST. Sealing only
    // the argument would leave B writable.
    const express = require("express");
    const { app } = loadReal();

    const outer = express.Router();
    const inner = express.Router();
    inner.post("/deep", (_, response) => response.sendStatus(200));
    outer.use("/in", inner); // built before boot's seal is applied to them

    expect(() => app.use("/outer2", outer)).toThrow(/after boot/i);
    expect(() => inner.post("/deeper", () => {})).toThrow(/after boot/i);
    expect(() => inner.route("/deeper")).toThrow(/after boot/i);
  });

  test("F4: none of the refused shapes ANSWERS over HTTP", async () => {
    // #98's lesson, restated: "it threw" and "it is not reachable" are
    // different questions, and only the second one is the security claim. A
    // throw that happened AFTER express had already pushed the layer would pass
    // every assertion above and still serve the route.
    //
    // The oracle is the HANDLER'''S OWN RESPONSE, not the status code. Measured:
    // `POST /api/never-mounted-at-all/deep` answers 200 on this app, because
    // index.js mounts a terminal `app.all("*")` before the seal — so
    // `expect(status).not.toBe(200)` passes for a route that does not exist AND
    // for one that does, which is no assertion at all. Each handler below
    // therefore returns a marker only it can produce.
    const express = require("express");
    const request = require("supertest");
    const { app } = loadReal();
    const apiRouter = apiRouterOf(app);

    const populated = express.Router();
    populated.post("/deep", (_, response) => response.json({ pwned: "router" }));
    const subApp = express();
    subApp.post("/deep", (_, response) => response.json({ pwned: "sub-app" }));
    const empty = express.Router();

    for (const [path, handler] of [
      ["/sub-router", populated],
      ["/sub-app", subApp],
      ["/late-empty", empty],
    ])
      expect(() => apiRouter.use(path, handler)).toThrow(/after boot/i);
    // the empty one is filled after its refused mount — the shape that served
    // 200 on the #98 SHA
    expect(() =>
      empty.post("/deep", (_, response) => response.json({ pwned: "late" }))
    ).toThrow(/after boot/i);

    // Control: the marker really is distinguishing. A route mounted BEFORE the
    // seal would return its own body, so the assertion below can fail.
    const unmounted = await request(app).post("/api/never-mounted-at-all/deep");
    expect(unmounted.text ?? "").not.toContain("pwned");

    for (const path of ["/sub-router", "/sub-app", "/late-empty"]) {
      const response = await request(app).post(`/api${path}/deep`);
      expect(response.text ?? "").not.toContain("pwned");
      expect(response.body?.pwned).toBeUndefined();
    }
  });
});

describe("#119 (QA-2): app._router is the object express actually mounts on", () => {
  // `app` is a FACADE. QA-2 drove this on `c44b059d3`, where only the facade was
  // sealed: `app._router.post`, `.all`, `.route().post` and `.use(subRouter)`
  // all mounted with no throw, and splicing the new layer in front of the
  // terminal `app.all("*")` served the handler's own marker with a 200.
  const loadReal = () => {
    jest.resetModules();
    return require("../../../index");
  };

  test("the four shapes QA-2 mounted are all refused", () => {
    const express = require("express");
    const { app } = loadReal();
    const internal = app._router;
    expect(internal).toBeDefined(); // the object under test must exist

    expect(() => internal.post("/qa2-post", () => {})).toThrow(/after boot/i);
    expect(() => internal.all("/qa2-all", () => {})).toThrow(/after boot/i);
    expect(() => internal.route("/qa2-route").post(() => {})).toThrow(
      /after boot/i
    );
    expect(() => internal.use("/qa2-use", express.Router())).toThrow(
      /after boot/i
    );
  });

  test("HTTP: a route forced onto _router does not answer with its own marker", async () => {
    // The assertion that matters, and it cannot be a status code: `index.js`
    // mounts a terminal `app.all("*")` before the seal, so
    // `POST /api/never-mounted` answers 200 too. Measured. The oracle is
    // therefore the handler's own marker.
    const request = require("supertest");
    const { app } = loadReal();

    expect(() =>
      app._router.post("/qa2-internal", (_, response) =>
        response.send("QA2-MARKER")
      )
    ).toThrow(/after boot/i);

    const response = await request(app).post("/qa2-internal");
    expect(response.text ?? "").not.toContain("QA2-MARKER");
  });

  test("the legitimate post-boot mounts index.js makes all still work", () => {
    // The half that makes the naive fix wrong. `app.get` is implemented as
    // `this._router.route(path).get(...)`, so sealing `_router.route` by
    // REFUSING it refuses every read mount too and the app does not boot —
    // measured: robots.txt, manifest.json and the SPA catch-all (index.js:171,
    // 175, mounted after the seal) all threw. `_router.route` therefore hands
    // back a SEALED Route instead of refusing the call.
    const express = require("express");
    const { app } = loadReal();

    expect(() => app.get("/robots.txt", (_, r) => r.send("ok"))).not.toThrow();
    expect(() => app.head("/robots.txt", (_, r) => r.end())).not.toThrow();
    expect(() =>
      app.use(express.static(require("path").resolve(__dirname, "..")))
    ).not.toThrow();
    expect(() => app.use("/", (_, r) => r.sendStatus(200))).not.toThrow();
    // and plain middleware straight onto the internal router
    expect(() => app._router.use((_, __, next) => next())).not.toThrow();
  });

  test("a Route from the sealed factory takes reads and refuses writes", () => {
    // What "sealed Route" means, asserted directly rather than inferred from
    // app.get working: the same object must accept `get` and refuse `post`.
    const { app } = loadReal();
    const route = app._router.route("/qa2-factory");
    expect(() => route.get(() => {})).not.toThrow();
    expect(() => route.post(() => {})).toThrow(/after boot/i);
    expect(() => route.all(() => {})).toThrow(/after boot/i);
  });

  test("sealRoutes skips a target with no internal router, rather than throwing", () => {
    // `_router` is created lazily by express on the first route, so an app
    // sealed before it has any is a real shape — and a guard that crashes boot
    // on it is worse than the hole it closes.
    const express = require("express");
    const fresh = express();
    expect(fresh._router).toBeUndefined();
    expect(() => sealRoutes(fresh)).not.toThrow();
    expect(() => fresh.post("/late", () => {})).toThrow(/after boot/i);
  });
});

describe("#119: what remains uncovered on _router — recorded, not implied", () => {
  const loadReal = () => {
    jest.resetModules();
    return require("../../../index");
  };

  test("RESIDUAL: param() is not sealed, on the app or on a router", () => {
    // `param` registers a callback for a route parameter; it mounts no route
    // and adds no verb, so it cannot make an ungated endpoint reachable — which
    // is why it is left alone rather than swept in for symmetry. Recorded so
    // the guard's reach is not overstated, and it inverts if anyone closes it.
    const express = require("express");
    const { app } = loadReal();
    expect(() => app.param("id", () => {})).not.toThrow();

    const router = express.Router();
    sealRoutes(router);
    expect(() => router.param("id", () => {})).not.toThrow();
  });
});

describe("#119: the escape hatch turns the recursion off too", () => {
  // An escape hatch that disables only the top layer leaves a deployment that
  // set the flag to get moving still throwing from a sealed sub-router, in a way
  // nothing in the message explains.
  let previous;
  beforeEach(() => {
    previous = process.env.ROUTE_MOUNT_GUARD;
    process.env.ROUTE_MOUNT_GUARD = "off";
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.ROUTE_MOUNT_GUARD;
    else process.env.ROUTE_MOUNT_GUARD = previous;
  });

  test("ROUTE_MOUNT_GUARD=off leaves a use()d sub-router mountable AND writable", () => {
    const express = require("express");
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = express();
      const sub = express.Router();
      sealRoutes(app);
      expect(() => app.use("/sub", sub)).not.toThrow();
      expect(() => sub.post("/deep", () => {})).not.toThrow();
      expect(() => sub.route("/other")).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("#119: what remains uncovered — recorded, not implied", () => {
  const loadReal = () => {
    jest.resetModules();
    return require("../../../index");
  };

  test("RESIDUAL: a sub-router captured BEFORE the seal is still writable after it", () => {
    // The seal holds references to exactly two objects. Anything that grabbed a
    // sub-router earlier keeps an unsealed handle to it. #119 does not close
    // this: the router is never handed to `use` while the seal is armed, so
    // there is no moment at which to seal it. Closing it means sealing at
    // CONSTRUCTION, which is a different change.
    //
    // No module in the tree does this. Recorded so the guard's reach is not
    // overstated — and it inverts, like the two above, if anyone closes it.
    const express = require("express");
    const sub = express.Router();
    loadReal();
    expect(() => sub.post("/still-open", () => {})).not.toThrow();
  });
});

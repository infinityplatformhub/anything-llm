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

describe("#98: what the seal does NOT cover — recorded, not implied", () => {
  // TL-2 drove these over real HTTP after boot and got 200s. Three of the four they
  // found are now sealed (`app.all`, `apiRouter.all`, `.route()` — see the suite
  // above). This one is not, and cannot be without breaking the app.
  //
  // These tests assert WHAT IS, not what should be. If someone later closes this
  // hole, they go red and force a deliberate decision instead of leaving a stale
  // claim about coverage lying around.

  const loadReal = () => {
    jest.resetModules();
    return require("../../../index");
  };
  const apiRouterOf = (app) =>
    (app._router?.stack ?? []).find((l) => l.name === "router" && l.handle?.stack)
      ?.handle;

  test("RESIDUAL: use(subRouter) mounts after boot, and its routes are reachable", () => {
    // `use` is how ALL middleware mounts, so sealing it would refuse the express
    // static handler, body parsers, and every legitimate late `app.use` — the guard
    // would fire on correct code and be deleted within a week. A sub-router carries
    // its own stack, and nothing in that stack passed through a sealed method.
    //
    // Mitigating, but not a fix: the routes inside are still ungated as far as the
    // startup sweep is concerned, which is exactly the hole. Closing it means
    // sealing recursively at mount time — issue #119, because it changes what `use`
    // means rather than adding a refusal. When #119 lands, this assertion inverts.
    const express = require("express");
    const { app } = loadReal();
    const apiRouter = apiRouterOf(app);

    const sub = express.Router();
    sub.post("/inside", (_, response) => response.sendStatus(200));

    expect(() => apiRouter.use("/late-sub", sub)).not.toThrow();
    expect(() => app.use("/late-sub-app", sub)).not.toThrow();

    // And it really did mount — this is a live bypass, not a theoretical one.
    const mountedSub = (apiRouter.stack ?? []).some(
      (layer) => layer.handle === sub
    );
    expect(mountedSub).toBe(true);
  });

  test("RESIDUAL: a sub-router captured BEFORE the seal is still writable after it", () => {
    // The seal holds references to exactly two objects. Anything that grabbed a
    // sub-router earlier keeps an unsealed handle to it. No module in the tree does
    // this today; recorded so the guard's reach is not overstated.
    const express = require("express");
    const sub = express.Router();
    loadReal();
    expect(() => sub.post("/still-open", () => {})).not.toThrow();
  });
});

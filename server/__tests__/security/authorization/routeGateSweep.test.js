/**
 * #52: every mutating route reachable with a session must ask something.
 *
 * The two holes this hotfix closed were not found by reading endpoint files —
 * they were found by asking the ROUTER what it had registered. A grep-based
 * check counts whatever files it happens to open: sweeping four endpoint
 * modules reported 6 ungated routes, the full router reported 20. So this
 * enumerates `app._router.stack` after mounting every module `index.js` mounts,
 * and no route can hide by living in a file nobody thought to grep.
 *
 * A route passes if it carries `requirePermission` (the engine decides),
 * `requireSelfSession` (self-service, #52), or is named in one of the two
 * allowlists below WITH a reason. The allowlists are the point: a new mutating
 * route added without a gate fails this test, and the author has to either gate
 * it or say in writing why it does not need one.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "h52-sweep-")
  );
process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER || "sweep-test-api-key-pepper-32-bytes-min";
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "test-jwt-secret-at-least-12-chars";

const fs = require("fs");
const path = require("path");
const { parse } = require("hermes-eslint");
const { buildRouter } = require("../../../utils/test/routeGateSweepHelper");
const { isApiKeyGuard } = require("../../../utils/middleware/validApiKey");
const {
  isPermissionGate,
} = require("../../../utils/middleware/requirePermission");
const {
  isOrgResolver,
  isWorkspaceResolver,
  isDynamicResolver,
} = require("../../../utils/middleware/resourceResolvers");

const SERVER_DIR = path.join(__dirname, "../../..");

function mountedRouteLayers(stack) {
  return (stack || []).flatMap((layer) => [
    ...(layer.route ? [layer] : []),
    ...mountedRouteLayers(layer.handle?.stack),
  ]);
}

const EXPECTED_SKIPPED_REGISTRARS = new Set(["agentWebsocket"]);

function collectImports(ast) {
  const imports = [];
  const endpointLiterals = [];

  const visit = (node, parent, grandparent, greatGrandparent) => {
    if (!node || typeof node !== "object") return;
    const literal =
      node.type === "Literal" && typeof node.value === "string"
        ? node.value
        : node.type === "TemplateLiteral" && node.expressions.length === 0
          ? node.quasis[0]?.value.cooked
          : null;
    if (literal?.startsWith("./endpoints/")) {
      endpointLiterals.push({ node, parent, grandparent, greatGrandparent });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value))
        value.forEach((child) => visit(child, node, parent, grandparent));
      else if (value && typeof value === "object")
        visit(value, node, parent, grandparent);
    }
  };
  visit(ast, null, null);

  for (const {
    node,
    parent: call,
    grandparent: declaration,
    greatGrandparent: variableDeclaration,
  } of endpointLiterals) {
    const bareRequire =
      call?.type === "CallExpression" &&
      call.callee?.type === "Identifier" &&
      call.callee.name === "require" &&
      call.arguments[0] === node &&
      node.type === "Literal";
    const topLevel =
      bareRequire &&
      declaration?.type === "VariableDeclarator" &&
      declaration.init === call &&
      variableDeclaration?.type === "VariableDeclaration" &&
      ast.body.includes(variableDeclaration);
    const properties =
      declaration?.id?.type === "ObjectPattern"
        ? declaration.id.properties
        : null;
    const unaliased = properties?.every(
      (property) =>
        property.key.type === "Identifier" &&
        property.value.type === "Identifier" &&
        property.key.name === property.value.name
    );
    if (!topLevel || !unaliased) {
      throw new Error(
        `Unsupported endpoint import at line ${node.loc?.start.line ?? "unknown"}: use top-level unaliased destructuring, e.g. const { exampleEndpoints } = require("./endpoints/example"); if this string is not a module path, move it out of index.js or declare an exception`
      );
    }
    imports.push(
      ...properties.map((property) => ({ local: property.value.name }))
    );
  }
  return imports;
}

function directRegistrarCalls(ast, imports) {
  const calls = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "CallExpression") {
      const local =
        node.callee?.type === "Identifier"
          ? node.callee.name
          : node.callee?.type === "MemberExpression" &&
              node.callee.object?.type === "Identifier"
            ? node.callee.object.name
            : null;
      if (imports.some((entry) => entry.local === local)) calls.push(local);
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast);
  return calls;
}

/**
 * Single-user-only routes. These configure a personal instance; in multi-user
 * mode the handler (or an `isSingleUserMode` middleware) refuses with 401
 * before doing anything. Listed rather than gated because the permission model
 * describes an org with members, and a single-user instance has neither.
 */
const SINGLE_USER_ONLY_ROUTES = new Set([
  "POST /system/update-password",
  "POST /system/generate-api-key",
  "DELETE /system/api-key/:id",
  "POST /telegram/connect",
  "POST /telegram/disconnect",
  "POST /telegram/approve-user",
  "POST /telegram/deny-user",
  "POST /telegram/revoke-user",
  "POST /telegram/update-config",
  "POST /scheduled-jobs/runs/:runId/:action",
  "POST /scheduled-jobs/new",
  "PUT /scheduled-jobs/:id",
  "DELETE /scheduled-jobs/:id",
  "POST /scheduled-jobs/:id/toggle",
  "POST /scheduled-jobs/:id/trigger",
  "POST /admin/agent-skills/outlook/auth-url",
  "POST /admin/agent-skills/outlook/revoke",
]);

/**
 * Self-service routes: they act on the caller's OWN account, and no seeded
 * action expresses "acting as yourself" (`user.write` is super_admin's;
 * `member` holds only `chat.send`). #53 adds that action, and when it lands
 * these move to `requirePermission` and this list should empty.
 */
const SELF_SERVICE_ROUTES = new Set([
  "POST /system/user",
  "POST /web-push/subscribe",
]);

// Routes outside the org/workspace permission model. Every entry names why its
// own authentication boundary is intentional; unknown mutating routes fail.
const INTENTIONAL_NON_PERMISSION_MUTATIONS = new Map([
  ...[...SINGLE_USER_ONLY_ROUTES].map((route) => [
    route,
    "single-user deployment only; isSingleUserMode or handler shape refuses multi-user requests",
  ]),
  ...[...SELF_SERVICE_ROUTES].map((route) => [
    route,
    "self-service on caller account; requireSelfSession constrains identity",
  ]),
  ["POST /request-token", "unauthenticated login ingress"],
  // S3 (#60): LDAP login. No principal exists before authenticate, so there is
  // nothing for the engine to decide on. Plaintext-bind and rate-limit
  // protections live in the LDAP driver (#60), not at this gate.
  // GET /sso/ldap/enabled never reaches this map: non-mutating methods are
  // filtered out before the allowlist is consulted.
  [
    "POST /sso/ldap/login",
    "unauthenticated LDAP login ingress; provisions a user + default grant on first bind. Identity is bounded by the directory; rate limit + plaintext refusal are ours (ldap.js:173,198)",
  ],
  ["POST /system/recover-account", "unauthenticated account-recovery ingress"],
  ["POST /system/reset-password", "recovery-token completion ingress"],
  ["POST /invite/:code", "invite-code acceptance ingress"],
  ["POST /mobile/register", "mobile registration token authenticates request"],
  [
    "POST /mobile/send/:command",
    "registered mobile-device token authenticates request",
  ],
  ["POST /sso/saml/acs", "SAML identity-provider callback ingress"],
  [
    "POST /embed/:embedId/stream-chat",
    "public embed configuration authenticates embed access",
  ],
  [
    "DELETE /embed/:embedId/:sessionId",
    "embed session access middleware owns authorization",
  ],
  // issue 49: session-open ingress. Unauthenticated by nature — a site visitor has no
  // identity yet, and the token this route mints is what gives them one, so there is no
  // principal for the engine to decide about. It is not ungoverned: embedSessionOpen
  // enforces the embed's enabled flag and origin allowlist, and embedHistoryRateLimit
  // bounds it per caller IP. It writes nothing.
  [
    "POST /embed/:embedId/session",
    "unauthenticated session-open ingress; embedSessionOpen enforces enabled + origin allowlist, embedHistoryRateLimit bounds it, and it persists nothing",
  ],
  [
    "DELETE /browser-extension/disconnect",
    "browser extension key middleware authenticates request",
  ],
  [
    "POST /browser-extension/embed-content",
    "browser extension key middleware authenticates request",
  ],
  [
    "POST /browser-extension/upload-content",
    "browser extension key middleware authenticates request",
  ],
]);

module.exports = {
  SINGLE_USER_ONLY_ROUTES,
  SELF_SERVICE_ROUTES,
  buildRouter,
};

describe("issue 52: every session-authenticated mutating route asks something", () => {
  const { app, registrations, skipped } = buildRouter();
  const mountedRoutesAtTestLoad = mountedRouteLayers(app._router?.stack);
  const { terminalNotFound } = require("../../../index");
  const wildcardRoutes = mountedRoutesAtTestLoad.filter(
    (layer) => layer.route.path === "*"
  );
  const terminalWildcard = wildcardRoutes.find((layer) =>
    layer.route.stack.every(({ handle }) => handle === terminalNotFound)
  );

  test("the sweep actually mounted the router (guards the guard)", () => {
    // Without this, a sweep that silently mounted nothing would report zero
    // ungated routes and pass forever — the failure mode the §7.9 rulings are
    // about, in the one test whose whole job is to catch omissions.
    expect(registrations.length).toBeGreaterThanOrEqual(31);
    // 317 counts each route layer once. A 363-line dump expands app.all("*")
    // into 35 method handlers; both measure the same mounted router tree.
    //
    // 316 -> 317 with issue 49: POST /embed/:embedId/session. The number is pinned rather
    // than computed precisely so that adding a route is a deliberate edit here — this line
    // is the one that made me declare the new route's exemption instead of letting an
    // unauthenticated mutating route mount unnoticed.
    //
    // 317 -> 318 with O2b (#112): GET /system/preflight. It is a READ, so the
    // mutating-route sweep below does not cover it and it needs no exemption
    // there; its own gate — answer pre-user OR with system.write, never
    // otherwise — is held by __tests__/endpoints/preflightHttp.test.js,
    // including that the transition closes inside one process and that an
    // unreadable users table fails closed.
    // 318 -> 319 with S12 slice 1 (#136): DELETE
    // /admin/group/:groupId/member/:userId, the first production caller of
    // `removeGroupMember`. It is a MUTATION, so unlike #112's read it must also
    // appear in the gated set below — carrying `user.manage` on the org, since
    // no `group.*` permission is seeded.
    expect(mountedRoutesAtTestLoad).toHaveLength(319);
    const directRoutes = (app._router?.stack || []).filter(
      (layer) => layer.route
    );
    const nestedRoutes = (app._router?.stack || []).flatMap((layer) =>
      layer.handle?.stack ? mountedRouteLayers(layer.handle.stack) : []
    );
    expect(directRoutes.length).toBeGreaterThan(0);
    expect(nestedRoutes.length).toBeGreaterThan(300);
    expect(
      skipped.filter(
        (entry) => !EXPECTED_SKIPPED_REGISTRARS.has(entry.split(":")[0])
      )
    ).toEqual([]);
  });

  test("every imported endpoint registrar appears in the production list", () => {
    const source = fs.readFileSync(path.join(SERVER_DIR, "index.js"), "utf8");
    const ast = parse(source, { sourceType: "script" });
    const imports = collectImports(ast);
    const listed = new Set(
      registrations.map((entry) =>
        typeof entry === "function" ? entry.name : entry.register.name
      )
    );

    expect(imports.length).toBe(listed.size);
    expect(
      imports.filter(
        ({ local }) =>
          !listed.has(local) && !EXPECTED_SKIPPED_REGISTRARS.has(local)
      )
    ).toEqual([]);
    expect(directRegistrarCalls(ast, imports)).toEqual([]);
  });

  test.each([
    {
      name: "normal top-level destructuring",
      source: 'const { normalEndpoints } = require("./endpoints/normal");',
      expected: [{ local: "normalEndpoints" }],
      reason: null,
    },
    {
      name: "non-endpoint path",
      source: 'const { helper } = require("./utils/helper");',
      expected: [],
      reason: null,
    },
    {
      name: "alias",
      source:
        '\nconst { hiddenEndpoints: probe } = require("./endpoints/hidden");',
      reason: "Unsupported endpoint import at line 2",
    },
    {
      name: "second declarator",
      source:
        'const harmless = 1, { probeEndpoints } = require("./endpoints/probe");',
      expected: [{ local: "probeEndpoints" }],
      reason: null,
    },
    {
      name: "module.require",
      source:
        '\nconst { probeEndpoints } = module.require("./endpoints/probe");',
      reason: "Unsupported endpoint import at line 2",
    },
    {
      name: "computed module require",
      source:
        '\nconst { probeEndpoints } = module["require"]("./endpoints/probe");',
      reason: "Unsupported endpoint import at line 2",
    },
    {
      name: "aliased require function",
      source:
        '\nconst req = require; const { probeEndpoints } = req("./endpoints/probe");',
      reason: "Unsupported endpoint import at line 2",
    },
    {
      name: "single-part template literal",
      source: "\nconst { probeEndpoints } = require(`./endpoints/probe`);",
      reason: "Unsupported endpoint import at line 2",
    },
    {
      name: "ESM import",
      source: '\nimport { probeEndpoints } from "./endpoints/probe";',
      reason: "Unsupported endpoint import at line 2",
    },
    {
      name: "member access",
      source: '\nconst probe = require("./endpoints/probe").mountProbeRoutes;',
      reason: "Unsupported endpoint import at line 2",
    },
    {
      name: "namespace/default binding",
      source: '\nconst ep = require("./endpoints/probe");',
      reason: "Unsupported endpoint import at line 2",
    },
    {
      name: "array binding",
      source: '\nconst [probe] = require("./endpoints/probe");',
      reason: "Unsupported endpoint import at line 2",
    },
    {
      name: "nested block",
      source:
        '\nif (true) { const { probeEndpoints } = require("./endpoints/probe"); }',
      reason: "Unsupported endpoint import at line 2",
    },
    {
      name: "assignment outside a declaration",
      source: '\n({ probeEndpoints } = require("./endpoints/probe"));',
      reason: "Unsupported endpoint import at line 2",
    },
    {
      name: "computed require",
      source: '\nconst { probeEndpoints } = require("./endpoints/" + name);',
      reason: "Unsupported endpoint import at line 2",
    },
    {
      name: "indirect require",
      source:
        '\nconst path = "./endpoints/probe"; const { probeEndpoints } = require(path);',
      reason: "Unsupported endpoint import at line 2",
    },
  ])("collectImports: $name", ({ source, expected, reason }) => {
    const collect = () =>
      collectImports(
        parse(source, {
          sourceType: "script",
          enableExperimentalComponentSyntax: true,
        })
      );
    if (reason) expect(collect).toThrow(reason);
    else expect(collect()).toEqual(expected);
  });

  test("direct endpoint calls are formatting and binding independent", () => {
    const ast = parse(
      `const { hiddenEndpoints } = require("./endpoints/hidden");
       hiddenEndpoints (apiRouter);`,
      { sourceType: "script" }
    );
    expect(directRegistrarCalls(ast, collectImports(ast))).toEqual([
      "hiddenEndpoints",
    ]);
  });

  test("mutating means every method except GET/HEAD; catch-all 404 is excluded", () => {
    expect(
      ["post", "put", "patch", "delete", "options"].every(
        (method) => method !== "get" && method !== "head"
      )
    ).toBe(true);
    expect(
      mountedRoutesAtTestLoad.some((layer) => layer.route.path === "*")
    ).toBe(true);
  });

  test("the only wildcard is the final terminal 404 handler", () => {
    expect(wildcardRoutes).toHaveLength(1);
    expect(terminalWildcard).toBe(mountedRoutesAtTestLoad.at(-1));
    expect(terminalWildcard.route.stack.length).toBeGreaterThan(1);
    expect(
      terminalWildcard.route.stack.every(
        ({ handle }) => handle === terminalNotFound
      )
    ).toBe(true);
  });

  test("mounted route snapshot stays stable through immediate timers", async () => {
    const before = mountedRouteLayers(app._router?.stack);
    await new Promise(setImmediate);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const after = mountedRouteLayers(app._router?.stack);
    expect(after).toEqual(before);
  });

  test("every mounted mutating route has identity-verified authorization", () => {
    // Snapshot at assertion execution. The stability test above proves nothing
    // mounts through setImmediate or a 0ms timer, so the residual window is
    // narrower than "asynchronous": what escapes is a mount scheduled to land
    // AFTER this test body runs (a longer timer, or an awaited I/O round trip).
    // Nothing in the tree does that today; a runtime guard that refuses late
    // apiRouter mounts is tracked separately.
    const routesAtAssertion = mountedRouteLayers(app._router?.stack);
    const ungated = [];
    for (const layer of routesAtAssertion) {
      // Exempt only the one terminal 404 by mounted layer identity. Earlier
      // wildcards pass through normal authorization checks.
      if (layer === terminalWildcard) continue;
      const methods = Object.keys(layer.route.methods).filter(
        (method) => method !== "get" && method !== "head"
      );
      for (const method of methods) {
        const signature = `${method.toUpperCase()} ${layer.route.path}`;
        const gated = layer.route.stack.some(
          ({ handle }) =>
            isApiKeyGuard(handle) ||
            (isPermissionGate(handle) &&
              [isOrgResolver, isWorkspaceResolver, isDynamicResolver].some(
                (classify) => classify(handle.resolveResource)
              ))
        );
        if (!gated && !INTENTIONAL_NON_PERMISSION_MUTATIONS.has(signature)) {
          ungated.push(signature);
        }
      }
    }
    expect(ungated).toEqual([]);
    for (const [signature, reason] of INTENTIONAL_NON_PERMISSION_MUTATIONS) {
      expect(reason.length).toBeGreaterThan(10);
      const matches = routesAtAssertion.filter((layer) =>
        Object.keys(layer.route.methods).some(
          (method) =>
            `${method.toUpperCase()} ${layer.route.path}` === signature
        )
      );
      // One signature exempts exactly one mounted layer; collisions never inherit
      // another route's reason.
      expect(matches).toHaveLength(1);
    }
  });

  test("production endpoint registration list is immutable", () => {
    expect(Object.isFrozen(registrations)).toBe(true);
    expect(() => registrations.push(() => {})).toThrow(TypeError);
  });

  test("no mutating route carries validatedRequest alone", () => {
    const ungated = [];
    for (const layer of mountedRoutesAtTestLoad) {
      if (!layer.route) continue;
      const methods = Object.keys(layer.route.methods).filter(
        (m) => m !== "get" && m !== "head"
      );
      if (methods.length === 0) continue;

      const middlewareNames = layer.route.stack.map((s) => s.name);
      if (!middlewareNames.includes("validatedRequest")) continue;

      const signature = `${methods[0].toUpperCase()} ${layer.route.path}`;
      const gated =
        middlewareNames.includes("permissionRequired") ||
        middlewareNames.includes("requireSelfSession") ||
        SINGLE_USER_ONLY_ROUTES.has(signature) ||
        SELF_SERVICE_ROUTES.has(signature);
      if (!gated) ungated.push(signature);
    }

    expect(ungated).toEqual([]);
  });

  test("every mutating developer route carries validApiKey", () => {
    const ungated = [];
    for (const layer of mountedRoutesAtTestLoad) {
      if (!layer.route || !String(layer.route.path).startsWith("/v1/"))
        continue;
      const methods = Object.keys(layer.route.methods).filter(
        (method) => method !== "get" && method !== "head"
      );
      if (methods.length === 0) continue;

      const guarded = layer.route.stack.some((handler) =>
        isApiKeyGuard(handler.handle)
      );
      if (!guarded) {
        ungated.push(`${methods[0].toUpperCase()} ${layer.route.path}`);
      }
    }
    expect(ungated).toEqual([]);
  });

  test("permission gate metadata cannot impersonate requirePermission", () => {
    const fakeGate = Object.assign((_request, _response, next) => next(), {
      action: "settings.write",
      resolveResource: () => null,
    });
    expect(isPermissionGate(fakeGate)).toBe(false);
    for (const value of [undefined, null, "gate", 1]) {
      expect(isPermissionGate(value)).toBe(false);
    }
    const key = Symbol.for("anything-llm.authorization.permissionGates");
    const registry = globalThis[key];
    Reflect.defineProperty(globalThis, key, { value: new WeakSet() });
    expect(globalThis[key]).toBe(registry);
  });

  test("API guard metadata cannot impersonate validApiKey", () => {
    const fakeGuard = Object.assign((_request, _response, next) => next(), {
      isApiKeyGuard: true,
    });
    expect(isApiKeyGuard(fakeGuard)).toBe(false);
  });

  test("API guard registry rejects invalid input and replacement", () => {
    for (const value of [undefined, null, "guard", 1]) {
      expect(isApiKeyGuard(value)).toBe(false);
    }
    const key = Symbol.for("anything-llm.authorization.apiKeyGuards");
    const registry = globalThis[key];
    expect(() =>
      Reflect.defineProperty(globalThis, key, { value: new WeakSet() })
    ).not.toThrow();
    expect(globalThis[key]).toBe(registry);
  });

  test("the self-service routes really carry requireSelfSession", () => {
    // An allowlist entry alone would let someone remove the middleware and
    // stay green — the list would excuse the very route it names.
    const bySignature = new Map();
    for (const layer of mountedRoutesAtTestLoad) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        bySignature.set(
          `${method.toUpperCase()} ${layer.route.path}`,
          layer.route.stack.map((s) => s.name)
        );
      }
    }
    for (const signature of SELF_SERVICE_ROUTES) {
      expect(bySignature.get(signature)).toContain("requireSelfSession");
    }
  });

  test("issue 53: no org-scoped action is paired with a workspace resolver", async () => {
    // Rule 1 of #53: `org.member` may only be asked against orgResource. Every
    // user holds an org-wide `member` grant, and evaluate() reads a
    // NULL-workspace grant as matching EVERY workspace — so an org-scoped action
    // answering a workspace question is the migration-044000 hole again.
    //
    // The engine now refuses this at runtime (AuthorizationContractError), which
    // is the enforcement. This is the second layer: it names the offending route
    // at test time instead of leaving it to a 500 in production.
    const { ACTION_SCOPES } = require("../../../prisma/seeds/permissions");
    const orgScoped = Object.entries(ACTION_SCOPES)
      .filter(([, scope]) => scope === "org")
      .map(([action]) => action);
    expect(orgScoped).toContain("org.member");

    const violations = [];
    let checked = 0;
    for (const layer of mountedRoutesAtTestLoad) {
      if (!layer.route) continue;
      for (const handler of layer.route.stack) {
        const action = handler.handle?.action;
        if (!action || !orgScoped.includes(action)) continue;
        checked += 1;
        // BEHAVIOURAL, not identity: another suite in this run calls
        // jest.resetModules(), so `resourceResolvers` can be a second module
        // instance and `!== orgResource` would flag correctly-wired routes. What
        // matters is not which function it is but what it produces — a resource
        // that names no workspace. Resolved with an empty request: orgResource
        // ignores its arguments, and any resolver that reads the request throws
        // or returns null, which is equally disqualifying here.
        let resolved = null;
        try {
          resolved = await handler.handle.resolveResource({}, {});
        } catch {
          resolved = null;
        }
        if (!resolved || resolved.workspaceId != null) {
          violations.push(
            `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path} -> ${action}`
          );
        }
      }
    }

    expect(violations).toEqual([]);
    // The sweep must actually have found the gates. Zero checked would pass the
    // assertion above while proving nothing — the failure mode this file exists
    // to avoid.
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  test("issue 53: chat.send is left on the three routes that mean it", () => {
    // The other half of the same ruling. `chat.send` stays on the real chat
    // mutations and on PUT /workspace/workspace-chats/:id (a mutation on a chat
    // the caller owns, whose resolver names a workspace). Converting those would
    // be the same category error in the other direction, and DoD 2 requires an
    // impersonated session to keep getting 403 on them.
    //
    // Paths taken from the MOUNTED router, not from the recon: the recon said
    // `POST /workspace/:slug/chat`, and no such route exists — both chat gates
    // are stream-chat (workspace and thread), and workspaces.js mounts its chat
    // route under a /workspace prefix. A grep-built expectation would have
    // asserted routes that are not there.
    const chatSendRoutes = [];
    for (const layer of mountedRoutesAtTestLoad) {
      if (!layer.route) continue;
      for (const handler of layer.route.stack) {
        if (handler.handle?.action !== "chat.send") continue;
        chatSendRoutes.push(
          `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`
        );
      }
    }
    expect(chatSendRoutes.sort()).toEqual([
      "POST /workspace/:slug/stream-chat",
      "POST /workspace/:slug/thread/:threadSlug/stream-chat",
      "PUT /workspace/workspace-chats/:id",
    ]);
  });

  test("single-user-only routes refuse in multi-user mode", () => {
    // The claim that earns their place on the list. Each either carries the
    // isSingleUserMode middleware or checks multiUserMode in its handler; a
    // route that does neither is not single-user-only, it is unguarded.
    // Paths spelled out rather than guessed: a filename that does not exist
    // would silently contribute an empty string, and every route would then be
    // "not found" — which this test would report as a failure, but a laxer one
    // would report as a pass.
    const sourceFiles = [
      "endpoints/system.js",
      "endpoints/telegram.js",
      "endpoints/scheduledJobs.js",
      "endpoints/utils/outlookAgentUtils.js",
    ].map((relative) => path.join(SERVER_DIR, relative));
    for (const file of sourceFiles) expect(fs.existsSync(file)).toBe(true);
    const sources = sourceFiles
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");

    for (const signature of SINGLE_USER_ONLY_ROUTES) {
      const routePath = signature.split(" ")[1];
      const index = sources.indexOf(`"${routePath}"`);
      expect(index).toBeGreaterThan(-1);
      const body = sources.slice(index, index + 1200);
      expect(
        /isSingleUserMode|multiUserMode\(response\)|locals\.multiUserMode/.test(
          body
        )
      ).toBe(true);
    }
  });
});

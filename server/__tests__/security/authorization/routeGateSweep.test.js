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
const { buildRouter } = require("../../../utils/test/routeGateSweepHelper");

const SERVER_DIR = path.join(__dirname, "../../..");

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

module.exports = {
  SINGLE_USER_ONLY_ROUTES,
  SELF_SERVICE_ROUTES,
  buildRouter,
};

describe("issue 52: every session-authenticated mutating route asks something", () => {
  const { app, registrations, skipped } = buildRouter();

  test("the sweep actually mounted the router (guards the guard)", () => {
    // Without this, a sweep that silently mounted nothing would report zero
    // ungated routes and pass forever — the failure mode the §7.9 rulings are
    // about, in the one test whose whole job is to catch omissions.
    expect(registrations).toHaveLength(31);
    expect(app._router.stack.filter((l) => l.route).length).toBeGreaterThan(
      100
    );
    // Only the websocket registration may fail to mount.
    expect(
      skipped.filter((entry) => !entry.startsWith("agentWebsocket"))
    ).toEqual([]);
  });

  test("no mutating route carries validatedRequest alone", () => {
    const ungated = [];
    for (const layer of app._router.stack) {
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

  test("the self-service routes really carry requireSelfSession", () => {
    // An allowlist entry alone would let someone remove the middleware and
    // stay green — the list would excuse the very route it names.
    const bySignature = new Map();
    for (const layer of app._router.stack) {
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
    for (const layer of app._router.stack) {
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
    for (const layer of app._router.stack) {
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

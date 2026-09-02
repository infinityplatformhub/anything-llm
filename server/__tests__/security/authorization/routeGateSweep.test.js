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
const express = require("express");

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

function buildRouter() {
  const app = express();
  const indexSource = fs.readFileSync(path.join(SERVER_DIR, "index.js"), "utf8");
  const registrations = indexSource.match(/^[a-zA-Z]+\(apiRouter\);$/gm) ?? [];
  const skipped = [];

  for (const line of registrations) {
    const fnName = line.replace("(apiRouter);", "");
    const requireMatch = indexSource.match(
      new RegExp(`\\{[^}]*\\b${fnName}\\b[^}]*\\}\\s*=\\s*require\\("([^"]+)"\\)`)
    );
    if (!requireMatch) {
      skipped.push(fnName);
      continue;
    }
    try {
      require(path.join(SERVER_DIR, requireMatch[1]))[fnName](app);
    } catch (error) {
      // agentWebsocket needs express-ws; it registers no plain HTTP routes.
      skipped.push(`${fnName}: ${error.message}`);
    }
  }
  return { app, registrations, skipped };
}

describe("#52: every session-authenticated mutating route asks something", () => {
  const { app, registrations, skipped } = buildRouter();

  test("the sweep actually mounted the router (guards the guard)", () => {
    // Without this, a sweep that silently mounted nothing would report zero
    // ungated routes and pass forever — the failure mode the §7.9 rulings are
    // about, in the one test whose whole job is to catch omissions.
    expect(registrations.length).toBeGreaterThan(20);
    expect(app._router.stack.filter((l) => l.route).length).toBeGreaterThan(100);
    // Only the websocket registration may fail to mount.
    expect(skipped.length).toBeLessThanOrEqual(1);
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
        /isSingleUserMode|multiUserMode\(response\)|locals\.multiUserMode/.test(body)
      ).toBe(true);
    }
  });
});

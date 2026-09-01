/**
 * P0-4 PR-0b (issue #10): every /v1 developer-API route MUST carry an auth
 * middleware. Guards against routes registered without a middleware array —
 * the way GET /v1/system/env-dump shipped unauthenticated.
 */
// Some endpoint modules resolve STORAGE_DIR at require time.
process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();

const { validApiKey } = require("../../utils/middleware/validApiKey");

const ENDPOINT_MODULES = {
  "api/admin": require("../../endpoints/api/admin").apiAdminEndpoints,
  "api/auth": require("../../endpoints/api/auth").apiAuthEndpoints,
  "api/document": require("../../endpoints/api/document").apiDocumentEndpoints,
  "api/embed": require("../../endpoints/api/embed").apiEmbedEndpoints,
  "api/openai": require("../../endpoints/api/openai")
    .apiOpenAICompatibleEndpoints,
  "api/system": require("../../endpoints/api/system").apiSystemEndpoints,
  "api/userManagement": require("../../endpoints/api/userManagement")
    .apiUserManagementEndpoints,
  "api/workspace": require("../../endpoints/api/workspace")
    .apiWorkspaceEndpoints,
  "api/workspaceThread": require("../../endpoints/api/workspaceThread")
    .apiWorkspaceThreadEndpoints,
};

/** Collect every registered route across all developer API endpoint files. */
function collectRoutes() {
  const routes = [];
  for (const [module, register] of Object.entries(ENDPOINT_MODULES)) {
    const record = (method) => (path, middlewares, handler) => {
      // Express allows app.get(path, handler) with no middleware array —
      // normalize so the assertion below can see the difference.
      const hasMiddlewareArray = Array.isArray(middlewares);
      routes.push({
        module,
        method,
        path,
        middlewares: hasMiddlewareArray ? middlewares : [],
        handler: hasMiddlewareArray ? handler : middlewares,
      });
    };
    register({
      get: record("get"),
      post: record("post"),
      delete: record("delete"),
      put: record("put"),
      patch: record("patch"),
      all: record("all"),
    });
  }
  return routes;
}

describe("developer API route auth sweep (P0-4 PR-0b)", () => {
  const routes = collectRoutes();

  it("registers the expected number of routes (update deliberately when adding routes)", () => {
    expect(routes.length).toBe(63);
  });

  it("every route carries validApiKey middleware", () => {
    const unguarded = routes.filter(
      (route) => !route.middlewares.includes(validApiKey)
    );
    expect(
      unguarded.map((r) => `${r.method.toUpperCase()} ${r.path} (${r.module})`)
    ).toEqual([]);
  });

  it("env-dump specifically is guarded", () => {
    const envDump = routes.find((r) => r.path === "/v1/system/env-dump");
    expect(envDump).toBeDefined();
    expect(envDump.middlewares).toContain(validApiKey);
  });
});

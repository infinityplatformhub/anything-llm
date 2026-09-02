/**
 * #50: simple-SSO is gone, and `GET /v1/users/:id/issue-auth-token` goes with it.
 *
 * Renamed from `ssoIssuanceHotfix.test.js`. The original asserted that the
 * route's FIRST middleware was the one that refuses — a property that mattered
 * while the route existed. PMO ruling (A) deleted the route instead: it minted
 * a temporary token whose ONLY exchange point was `GET /request-token/sso/simple`,
 * so keeping it would have left an endpoint that mints a credential nothing can
 * redeem, plus a `loginPath` in its response pointing at a 404.
 *
 * What this file asserts now is that the deletion was total, in both directions:
 * the route is absent from the table, and `sso.issue` no longer maps to anything.
 */

process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER || "issue-auth-token-wiring-pepper-32-bytes";
process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "s50-wiring-")
  );

const {
  apiUserManagementEndpoints,
} = require("../../endpoints/api/userManagement");
const { ROUTE_SCOPES, scopeFor } = require("../../utils/apiKeySecurity/scopes");

describe("issue-auth-token is gone (#50)", () => {
  const routes = {};
  const fakeApp = {
    get: (path, middlewares, handler) => {
      routes[path] = { middlewares, handler };
    },
    post: (path, middlewares, handler) => {
      routes[path] = { middlewares, handler };
    },
    delete: (path, middlewares, handler) => {
      routes[path] = { middlewares, handler };
    },
  };
  apiUserManagementEndpoints(fakeApp);

  it("the route is not registered at all", () => {
    expect(routes["/v1/users/:id/issue-auth-token"]).toBeUndefined();
  });

  it("sibling routes in the same file still register", () => {
    // Without this, an exception thrown while mounting would delete every route
    // in the file and the assertion above would pass for the wrong reason.
    expect(routes["/v1/users"]).toBeDefined();
    expect(routes["/v1/users"].middlewares[0].name).toBe("apiKeyRequired");
  });

  it("sso.issue maps to no route", () => {
    // The scope string survives in the seeded vocabulary and in already-issued
    // keys (see ssoIssueScopeInert.test.js). What must not survive is a route
    // that answers to it.
    expect(Object.values(ROUTE_SCOPES)).not.toContain("sso.issue");
    expect(scopeFor("GET", "/v1/users/:id/issue-auth-token")).toBeUndefined();
  });
});

const {
  apiUserManagementEndpoints,
} = require("../../endpoints/api/userManagement");
const {
  ssoIssuanceLock,
} = require("../../utils/middleware/ssoIssuanceLock");

describe("issue-auth-token route wiring (P0-4 PR-0 hotfix)", () => {
  const routes = {};
  const fakeApp = {
    get: (path, middlewares, handler) => {
      routes[path] = { middlewares, handler };
    },
  };
  apiUserManagementEndpoints(fakeApp);

  it("registers ssoIssuanceLock as the FIRST middleware on issue-auth-token", () => {
    const route = routes["/v1/users/:id/issue-auth-token"];
    expect(route).toBeDefined();
    expect(route.middlewares[0]).toBe(ssoIssuanceLock);
  });

  it("blocks the request before any other middleware runs when flag is absent", async () => {
    delete process.env.SIMPLE_SSO_ISSUE_UNSAFE_ALLOW;
    const route = routes["/v1/users/:id/issue-auth-token"];
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    await route.middlewares[0]({}, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
  });
});

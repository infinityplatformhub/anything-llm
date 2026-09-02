// issue 46, QA-2 note — the same guarantee, asserted through the REAL swallow.
//
// The sibling suite (validatedRequestSingleUser.test.js) replaces
// `SystemSettings.isMultiUserMode` with a jest.fn. That is fine for driving the branches,
// but it means the actual error-swallowing code never runs: the thing that made this bug
// invisible is precisely that `SystemSettings.get` catches and returns null
// (systemSettings.js:647-655), and `isMultiUserMode` then reads `null?.value === "true"`
// as a confident `false` (:747-755). A mock at the top of that chain proves the branch
// works while proving nothing about the swallow underneath it.
//
// So this suite mocks NOTHING above prisma. The real SystemSettings runs, the real double
// swallow happens, and the only injected failure is at the database boundary — which is
// where a real outage or a missing row actually appears.
//
// RED on the unfixed middleware: the request is waved through with no auth.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();

jest.mock("../../../utils/prisma", () => ({
  system_settings: { findFirst: jest.fn() },
  users: { count: jest.fn() },
}));
jest.mock("../../../models/user", () => ({ User: { get: jest.fn() } }));

const prisma = require("../../../utils/prisma");
const {
  validatedRequest,
} = require("../../../utils/middleware/validatedRequest");

const makeRequest = () => ({ header: () => null, headers: {} });
const makeResponse = () => ({
  locals: {},
  statusCode: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json() {
    return this;
  },
});

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  // The passthrough shape: a dev box, or any deployment that never set these.
  process.env.NODE_ENV = "development";
  delete process.env.AUTH_TOKEN;
  delete process.env.JWT_SECRET;
});
afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV;
  process.env.AUTH_TOKEN = ORIGINAL_ENV.AUTH_TOKEN;
  process.env.JWT_SECRET = ORIGINAL_ENV.JWT_SECRET;
  jest.resetAllMocks();
});

describe("issue 46: the guarantee holds through the real swallow, not just a mocked branch", () => {
  test("a throwing system_settings read does not admit an unauthenticated request", async () => {
    // SystemSettings.get catches this and returns null; isMultiUserMode turns that into
    // false. Nothing above prisma is mocked, so that whole path executes for real.
    prisma.system_settings.findFirst.mockRejectedValue(new Error("db down"));
    prisma.users.count.mockResolvedValue(3);
    const next = jest.fn();
    const response = makeResponse();

    await validatedRequest(makeRequest(), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
  });

  test("a missing multi_user_mode row does not admit one either", async () => {
    // findFirst resolves null rather than throwing — the partial-restore shape, which
    // needs no outage at all.
    prisma.system_settings.findFirst.mockResolvedValue(null);
    prisma.users.count.mockResolvedValue(3);
    const next = jest.fn();
    const response = makeResponse();

    await validatedRequest(makeRequest(), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
  });

  test("a genuine single-user deployment still passes through", async () => {
    // Regression guard: the branch exists for deployments with no user rows, and the fix
    // must not take those offline.
    prisma.system_settings.findFirst.mockResolvedValue(null);
    prisma.users.count.mockResolvedValue(0);
    const next = jest.fn();
    const response = makeResponse();

    await validatedRequest(makeRequest(), response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  test("a real multi_user_mode=true row is still multi-user", async () => {
    prisma.system_settings.findFirst.mockResolvedValue({
      label: "multi_user_mode",
      value: "true",
    });
    prisma.users.count.mockResolvedValue(3);
    const next = jest.fn();
    const response = makeResponse();

    await validatedRequest(makeRequest(), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
    expect(response.locals.multiUserMode).toBe(true);
  });
});

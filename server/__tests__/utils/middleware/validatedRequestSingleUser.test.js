// #46 hotfix — `validatedRequest` trusts isMultiUserMode() the same way T-4b FINDING-1 did.
//
// `SystemSettings.isMultiUserMode()` catches its own errors and returns `false`
// (systemSettings.js:747), so an unreachable database — or a missing multi_user_mode row —
// lands in the single-user branch. That branch calls `next()` with no check at all when
// NODE_ENV=development or AUTH_TOKEN/JWT_SECRET are unset, which is the default shape of a
// dev box and of any deployment that never set those.
//
// This is the session-auth twin of the API-key hole QA-2 drove in #29: same swallowed
// error, same false conclusion, different door. Pre-existing on main — T-4b did not cause
// it and did not close it.
//
// Fix under test: single-user must be CONFIRMED (setting says single-user AND
// users.count() === 0), and any read failure means "not confirmed", so an unauthenticated
// request is refused rather than waved through.
// RED on main: the first four cases call next().

process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();

jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: { isMultiUserMode: jest.fn() },
}));
jest.mock("../../../models/user", () => ({ User: { get: jest.fn() } }));
jest.mock("../../../utils/prisma", () => ({ users: { count: jest.fn() } }));

const { SystemSettings } = require("../../../models/systemSettings");
const prisma = require("../../../utils/prisma");
const {
  validatedRequest,
} = require("../../../utils/middleware/validatedRequest");

const makeRequest = (headers = {}) => ({
  header: (name) => headers[name] ?? null,
  headers,
});
const makeResponse = () => {
  const response = {
    locals: {},
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return response;
};

const ORIGINAL_ENV = { ...process.env };
afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV;
  process.env.AUTH_TOKEN = ORIGINAL_ENV.AUTH_TOKEN;
  process.env.JWT_SECRET = ORIGINAL_ENV.JWT_SECRET;
  jest.resetAllMocks();
});

/** The passthrough shape: dev mode, or a deployment with no token configured. */
function passthroughEnv() {
  process.env.NODE_ENV = "development";
  delete process.env.AUTH_TOKEN;
  delete process.env.JWT_SECRET;
}

describe("issue 46: validatedRequest confirms single-user before waving a request through", () => {
  test("an unreadable settings table does not admit an unauthenticated request", async () => {
    passthroughEnv();
    SystemSettings.isMultiUserMode.mockResolvedValue(false); // swallowed error
    prisma.users.count.mockResolvedValue(3);
    const next = jest.fn();
    const response = makeResponse();

    await validatedRequest(makeRequest(), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
  });

  test("a thrown settings error does not admit an unauthenticated request", async () => {
    passthroughEnv();
    SystemSettings.isMultiUserMode.mockRejectedValue(new Error("db down"));
    prisma.users.count.mockResolvedValue(3);
    const next = jest.fn();
    const response = makeResponse();

    await validatedRequest(makeRequest(), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
  });

  test("a missing multi_user_mode row with real users does not admit either", async () => {
    // No outage needed: a partial restore or a migration that drops the row is enough.
    passthroughEnv();
    SystemSettings.isMultiUserMode.mockResolvedValue(false);
    prisma.users.count.mockResolvedValue(1);
    const next = jest.fn();
    const response = makeResponse();

    await validatedRequest(makeRequest(), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
  });

  test("an unreadable users table denies too — absence of evidence is not evidence", async () => {
    passthroughEnv();
    SystemSettings.isMultiUserMode.mockResolvedValue(false);
    prisma.users.count.mockRejectedValue(new Error("db down"));
    const next = jest.fn();
    const response = makeResponse();

    await validatedRequest(makeRequest(), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
  });

  test("a genuine single-user deployment still passes through in dev", async () => {
    // The fix must not break the case the branch exists for: no user rows at all.
    passthroughEnv();
    SystemSettings.isMultiUserMode.mockResolvedValue(false);
    prisma.users.count.mockResolvedValue(0);
    const next = jest.fn();
    const response = makeResponse();

    await validatedRequest(makeRequest(), response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBeNull();
  });

  test("multi-user mode is untouched — no token is still 401, and users are not counted", async () => {
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    prisma.users.count.mockImplementation(() => {
      throw new Error("users must not be counted when the mode is already multi-user");
    });
    const next = jest.fn();
    const response = makeResponse();

    await validatedRequest(makeRequest(), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
  });

  test("response.locals.multiUserMode reflects the confirmed answer, not the raw setting", async () => {
    // Handlers branch on this flag. If it still says "single-user" while the resolver has
    // decided otherwise, the two halves of the request disagree about what mode they are in.
    passthroughEnv();
    SystemSettings.isMultiUserMode.mockResolvedValue(false);
    prisma.users.count.mockResolvedValue(3);
    const response = makeResponse();

    await validatedRequest(makeRequest(), response, jest.fn());

    expect(response.locals.multiUserMode).toBe(true);
  });
});

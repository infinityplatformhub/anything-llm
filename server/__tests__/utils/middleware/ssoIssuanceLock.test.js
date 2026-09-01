const {
  ssoIssuanceLock,
} = require("../../../utils/middleware/ssoIssuanceLock");

describe("ssoIssuanceLock middleware (P0-4 PR-0 hotfix)", () => {
  const FLAG = "SIMPLE_SSO_ISSUE_UNSAFE_ALLOW";
  const originalValue = process.env[FLAG];
  const hadValue = FLAG in process.env;

  afterEach(() => {
    if (hadValue) {
      process.env[FLAG] = originalValue;
    } else {
      delete process.env[FLAG];
    }
  });

  const makeResponse = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  });

  it("returns 403 by default (flag absent) — endpoint is closed even for a valid API key", () => {
    delete process.env[FLAG];
    const next = jest.fn();
    const response = makeResponse();

    ssoIssuanceLock({}, response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({
      error:
        "Temporary auth token issuance is disabled pending the API key scope rollout. See release notes.",
    });
  });

  // QA-2 finding: plain JS truthiness let "false"/"0"/"no"/"off"/" " reopen the
  // endpoint. Every value an operator would set MEANING "off" must stay closed.
  for (const offValue of ["", "0", "false", "no", "off", " ", "FALSE", " Off "]) {
    it(`returns 403 when flag is set to ${JSON.stringify(offValue)}`, () => {
      process.env[FLAG] = offValue;
      const next = jest.fn();
      const response = makeResponse();

      ssoIssuanceLock({}, response, next);

      expect(next).not.toHaveBeenCalled();
      expect(response.status).toHaveBeenCalledWith(403);
    });
  }

  it("calls next only when flag is explicitly set to a truthy value, and warns loudly", () => {
    process.env[FLAG] = "1";
    const next = jest.fn();
    const response = makeResponse();
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

    ssoIssuanceLock({}, response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("SIMPLE_SSO_ISSUE_UNSAFE_ALLOW")
    );
    warn.mockRestore();
  });
});

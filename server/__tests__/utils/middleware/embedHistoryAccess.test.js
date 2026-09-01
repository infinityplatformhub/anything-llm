/**
 * PR-0d (issue #12, G12): GET/DELETE /embed/:embedId/:sessionId ran with only
 * validEmbedConfig — no enabled check, no origin allowlist, no sessionId format
 * check. Anyone holding the public embedId could read or invalidate any
 * session's chat history cross-origin. This middleware applies the same gates
 * the chat path already enforces.
 */
process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();

const {
  embedHistoryAccess,
} = require("../../../utils/middleware/embedMiddleware");

describe("embedHistoryAccess middleware (PR-0d / G12)", () => {
  const SESSION = "123e4567-e89b-42d3-a456-426614174000";

  const makeResponse = (embed) => ({
    locals: { embedConfig: embed },
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    sendStatus: jest.fn().mockReturnThis(),
    end: jest.fn(),
  });
  const makeRequest = (overrides = {}) => ({
    params: { sessionId: SESSION },
    headers: { origin: "https://allowed.example" },
    ...overrides,
  });
  const baseEmbed = {
    id: 1,
    enabled: true,
    allowlist_domains: JSON.stringify(["https://allowed.example"]),
  };

  it("rejects a non-UUID sessionId with 404", async () => {
    const response = makeResponse(baseEmbed);
    const next = jest.fn();

    await embedHistoryAccess(
      makeRequest({ params: { sessionId: "not-a-uuid" } }),
      response,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(404);
  });

  it("rejects when the embed is disabled", async () => {
    const response = makeResponse({ ...baseEmbed, enabled: false });
    const next = jest.fn();

    await embedHistoryAccess(makeRequest(), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(503);
  });

  it("rejects an origin outside the allowlist", async () => {
    const response = makeResponse(baseEmbed);
    const next = jest.fn();

    await embedHistoryAccess(
      makeRequest({
        params: { sessionId: SESSION },
        headers: { origin: "https://evil.example" },
      }),
      response,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(401);
  });

  it("passes a valid UUID session on an enabled embed from an allowed origin", async () => {
    const response = makeResponse(baseEmbed);
    const next = jest.fn();

    await embedHistoryAccess(makeRequest(), response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("allows any origin when the embed has no allowlist configured", async () => {
    const response = makeResponse({ ...baseEmbed, allowlist_domains: null });
    const next = jest.fn();

    await embedHistoryAccess(
      makeRequest({
        params: { sessionId: SESSION },
        headers: { origin: "https://anywhere.example" },
      }),
      response,
      next
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  // F-12a: canRespond denies allowlist-less embeds under EMBED_REQUIRE_ALLOWLIST;
  // the history gate used to let them through — half-applied hardening.
  describe("EMBED_REQUIRE_ALLOWLIST set (F-12a)", () => {
    const FLAG = "EMBED_REQUIRE_ALLOWLIST";
    const hadFlag = FLAG in process.env;

    afterEach(() => {
      if (hadFlag) process.env[FLAG] = "1";
      else delete process.env[FLAG];
    });

    it("denies an embed with no allowlist", async () => {
      process.env[FLAG] = "1";
      const response = makeResponse({ ...baseEmbed, allowlist_domains: null });
      const next = jest.fn();

      await embedHistoryAccess(makeRequest(), response, next);

      expect(next).not.toHaveBeenCalled();
      expect(response.status).toHaveBeenCalledWith(401);
    });

    it("still allows an embed whose allowlist matches the origin", async () => {
      process.env[FLAG] = "1";
      const response = makeResponse(baseEmbed);
      const next = jest.fn();

      await embedHistoryAccess(makeRequest(), response, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});

describe("route wiring (PR-0d)", () => {
  it("both history routes carry embedHistoryAccess after validEmbedConfig", () => {
    const source = require("fs").readFileSync(
      require("path").resolve(__dirname, "../../../endpoints/embed/index.js"),
      "utf8"
    );
    const matches = source.match(
      /\[validEmbedConfig, embedHistoryAccess\]/g
    );
    expect(matches).toHaveLength(2);
  });
});

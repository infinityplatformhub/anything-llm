const crypto = require("crypto");
const { makeSecret, digestSecret, matchesDigest, API_KEY_PREFIX, BROWSER_KEY_PREFIX, assertApiKeyPepper } = require("../../../utils/apiKeySecurity");
const { requireScope } = require("../../../utils/middleware/requireScope");

describe("API key security primitives", () => {
  beforeEach(() => { process.env.API_KEY_PEPPER = "test-pepper-32-bytes-minimum-value"; });

  test.each([API_KEY_PREFIX, BROWSER_KEY_PREFIX])("generates 256-bit prefixed secret %s", (prefix) => {
    const secret = makeSecret(prefix);
    expect(secret.startsWith(prefix)).toBe(true);
    expect(Buffer.from(secret.slice(prefix.length), "base64url")).toHaveLength(32);
  });

  test("HMAC digest matches correct secret and rejects malformed digest without throwing", () => {
    const secret = makeSecret(API_KEY_PREFIX);
    expect(matchesDigest(secret, digestSecret(secret))).toBe(true);
    expect(matchesDigest(`${secret}x`, digestSecret(secret))).toBe(false);
    expect(() => matchesDigest(secret, Buffer.alloc(3))).not.toThrow();
    expect(matchesDigest(secret, Buffer.alloc(3))).toBe(false);
  });

  test("missing pepper fails closed", () => {
    delete process.env.API_KEY_PEPPER;
    expect(assertApiKeyPepper).toThrow("API_KEY_PEPPER is required");
  });
});

test("requireScope defaults deny and accepts exact or wildcard scope", () => {
  const next = jest.fn();
  const response = { locals: {}, status: jest.fn().mockReturnThis(), json: jest.fn() };
  requireScope("workspace.write")({}, response, next);
  expect(response.status).toHaveBeenCalledWith(403);
  response.locals.actor = { scopes: ["document.read"] };
  requireScope("workspace.write")({}, response, next);
  expect(next).not.toHaveBeenCalled();
  response.locals.actor.scopes = ["*"];
  requireScope("workspace.write")({}, response, next);
  expect(next).toHaveBeenCalledTimes(1);
});

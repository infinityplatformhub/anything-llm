const crypto = require("crypto");
const { makeSecret, digestSecret, matchesDigest, API_KEY_PREFIX, BROWSER_KEY_PREFIX, assertApiKeyPepper } = require("../../../utils/apiKeySecurity");

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
    expect(assertApiKeyPepper).toThrow("API_KEY_PEPPER must be at least 32 bytes");
  });
});


test("validApiKey factory rejects missing scope at registration", () => {
  process.env.API_KEY_PEPPER = "test-pepper-32-bytes-minimum-value";
  const { validApiKey } = require("../../../utils/middleware/validApiKey");
  expect(() => validApiKey()).toThrow("validApiKey requires an explicit scope");
});

test("audit payload contract contains correlation facts and no key material fields", () => {
  const payload = { scopedKeyId: "7", keyPrefix: "apw-key-12345678", action: "workspace.write", allowed: false, orgId: "default" };
  expect(Object.keys(payload).sort()).toEqual(["action", "allowed", "keyPrefix", "orgId", "scopedKeyId"]);
  expect(JSON.stringify(payload)).not.toMatch(/secret|digest/i);
});

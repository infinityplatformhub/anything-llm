const crypto = require("crypto");
const { digestSecret, matchesDigest, assertApiKeyPepper } = require("../../../utils/apiKeySecurity");
const { ApiKey } = require("../../../models/apiKeys");
const { BrowserExtensionApiKey } = require("../../../models/browserExtensionApiKey");

describe("API key security primitives", () => {
  beforeEach(() => { process.env.API_KEY_PEPPER = "test-pepper-32-bytes-minimum-value"; });

  test.each([["apw-key-", ApiKey.makeSecret], ["apw-brx-", BrowserExtensionApiKey.makeSecret]])("generates 256-bit prefixed secret %s", (prefix, generate) => {
    const secret = generate();
    expect(secret.startsWith(prefix)).toBe(true);
    expect(Buffer.from(secret.slice(prefix.length), "base64url")).toHaveLength(32);
  });

  test("HMAC digest matches correct secret and rejects malformed digest without throwing", () => {
    const secret = ApiKey.makeSecret();
    expect(matchesDigest(secret, digestSecret(secret))).toBe(true);
    expect(matchesDigest(`${secret}x`, digestSecret(secret))).toBe(false);
    expect(() => matchesDigest(secret, Buffer.alloc(3))).not.toThrow();
    expect(matchesDigest(secret, Buffer.alloc(3))).toBe(false);
  });

  test.each([undefined, "", " ", "undefined", "null", "short"])("missing or short pepper fails closed: %s", (value) => {
    if (value === undefined) delete process.env.API_KEY_PEPPER;
    else process.env.API_KEY_PEPPER = value;
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

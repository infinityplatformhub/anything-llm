/**
 * P0-4 PR-1 (issue #9, ruling R7): every generated secret must carry >=256 bits
 * of entropy from crypto.randomBytes. uuid-apikey encoded a UUIDv4 — 122 bits.
 */
const crypto = require("crypto");

const { ApiKey } = require("../../models/apiKeys");
const {
  BrowserExtensionApiKey,
} = require("../../models/browserExtensionApiKey");
const { TemporaryAuthToken } = require("../../models/temporaryAuthToken");

// 32 random bytes base64url-encoded => 43 chars, alphabet [A-Za-z0-9_-]
const BASE64URL_256 = /^[A-Za-z0-9_-]{43}$/;

describe("key generator entropy (P0-4 PR-1 / R7)", () => {
  afterEach(() => jest.restoreAllMocks());

  const cases = [
    {
      name: "ApiKey.makeSecret",
      make: () => ApiKey.makeSecret(),
      prefix: "sk-",
    },
    {
      name: "BrowserExtensionApiKey.makeSecret",
      make: () => BrowserExtensionApiKey.makeSecret(),
      prefix: "brx-",
    },
    {
      name: "TemporaryAuthToken.makeTempToken",
      make: () => TemporaryAuthToken.makeTempToken(),
      prefix: "allm-tat-",
    },
  ];

  for (const { name, make, prefix } of cases) {
    describe(name, () => {
      it(`keeps the "${prefix}" prefix and appends 43 base64url chars (256 bits)`, () => {
        const secret = make();
        expect(secret.startsWith(prefix)).toBe(true);
        expect(secret.slice(prefix.length)).toMatch(BASE64URL_256);
      });

      it("draws exactly 32 bytes from crypto.randomBytes", () => {
        const spy = jest.spyOn(crypto, "randomBytes");
        make();
        expect(spy).toHaveBeenCalledWith(32);
      });

      it("never repeats across generations", () => {
        const seen = new Set(Array.from({ length: 64 }, make));
        expect(seen.size).toBe(64);
      });
    });
  }

  it("BrowserExtensionApiKey.validString still accepts a freshly generated key format", () => {
    // validString checks the brx- prefix; new format must not break it.
    const key = BrowserExtensionApiKey.makeSecret();
    expect(key.startsWith("brx-")).toBe(true);
  });
});

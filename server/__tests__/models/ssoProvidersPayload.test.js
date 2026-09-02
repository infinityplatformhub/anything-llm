/**
 * #50: `SSOProviders` tells the login screen where to send a user when
 * SIMPLE_SSO_NO_LOGIN forbids credential login.
 *
 * `GET /setup-complete` (SystemSettings.currentSettings) is UNAUTHENTICATED —
 * the login page reads it before anyone has signed in. So this field may carry
 * provider ids and nothing else: an issuer URL names internal infrastructure and
 * a client id is half of a credential pair, and neither is needed to start a
 * login. The test asserts the absence, because a future edit adding "just the
 * issuer, it's public anyway" is exactly how this leaks.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "s50-ssoproviders-")
  );

const {
  SystemSettings,
} = require("../../models/systemSettings");

const OIDC_ENV = [
  "SSO_OIDC_ENABLED",
  "SSO_OIDC_ISSUER",
  "SSO_OIDC_CLIENT_ID",
  "SSO_OIDC_CLIENT_SECRET",
];

describe("#50: SSOProviders exposes ids only", () => {
  afterEach(() => {
    for (const key of OIDC_ENV) delete process.env[key];
  });

  it("lists an enabled provider by id", () => {
    process.env.SSO_OIDC_ENABLED = "1";
    expect(SystemSettings.ssoEnabledProviders()).toEqual(["oidc"]);
  });

  it("omits a provider that is configured but switched off", () => {
    // Configured-but-disabled must not appear: the login page would send users
    // to a route that answers 404.
    process.env.SSO_OIDC_ISSUER = "https://idp.internal.example.com";
    process.env.SSO_OIDC_CLIENT_ID = "client-abc";
    expect(SystemSettings.ssoEnabledProviders()).toEqual([]);
  });

  it("accepts the same truthy spellings the login route does", () => {
    // providerConfig() in endpoints/identity.js treats these as on. If this
    // list disagreed, the page would offer a provider the route refuses (or
    // hide one that works).
    for (const value of ["1", "true", "yes", "on", "TRUE", " On "]) {
      process.env.SSO_OIDC_ENABLED = value.trim();
      expect(SystemSettings.ssoEnabledProviders()).toEqual(["oidc"]);
    }
    for (const value of ["0", "false", "no", "off", ""]) {
      process.env.SSO_OIDC_ENABLED = value;
      expect(SystemSettings.ssoEnabledProviders()).toEqual([]);
    }
  });

  it("carries no issuer, client id, or secret — only the id", () => {
    process.env.SSO_OIDC_ENABLED = "1";
    process.env.SSO_OIDC_ISSUER = "https://idp.internal.example.com";
    process.env.SSO_OIDC_CLIENT_ID = "client-abc";
    process.env.SSO_OIDC_CLIENT_SECRET = "super-secret-value";

    const providers = SystemSettings.ssoEnabledProviders();
    const serialized = JSON.stringify(providers);

    expect(providers).toEqual(["oidc"]);
    // Every entry is a bare string, so there is no object to hide a field in.
    expect(providers.every((p) => typeof p === "string")).toBe(true);
    expect(serialized).not.toMatch(/idp\.internal\.example\.com/);
    expect(serialized).not.toMatch(/client-abc/);
    expect(serialized).not.toMatch(/super-secret-value/);
  });
});

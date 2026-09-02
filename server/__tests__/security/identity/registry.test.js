// S1 (#36) T4 — the provider registry. Callers import THIS, never a driver
// class directly (code-standards §5), so S2 adds one line here and every call
// site picks it up. A route that reached for OidcIdentityProvider itself would
// be the thing that makes adding SAML a fifteen-file change.

const {
  identityProviders,
  getIdentityProvider,
  isKnownProvider,
} = require("../../../utils/identityProviders");
const {
  OidcIdentityProvider,
} = require("../../../utils/identityProviders/OidcIdentityProvider");
const {
  SamlIdentityProvider,
} = require("../../../utils/identityProviders/SamlIdentityProvider");
const {
  IdentityConfigurationError,
} = require("../../../utils/identityProviders/errors");
const { IDP_ORIGIN } = require("../../../__testHelpers__/identity/urls");

describe("identity provider registry", () => {
  test("oidc is registered under its own providerId", () => {
    // Keyed by the driver's own providerId(), not a hand-written string: a
    // registry key that drifts from the id stored in identity_links would
    // orphan every existing link for that provider.
    expect(identityProviders.oidc).toBe(OidcIdentityProvider);
    expect(OidcIdentityProvider.providerId()).toBe("oidc");
  });

  test("saml is registered under its own providerId", () => {
    // S2 (#43): the one line adding a driver. `saml` was asserted UNREGISTERED
    // here while S1 was the only driver; now it must be present, and keyed by
    // the same id that goes into identity_links.
    expect(identityProviders.saml).toBe(SamlIdentityProvider);
    expect(SamlIdentityProvider.providerId()).toBe("saml");
  });

  test("isKnownProvider answers for registered and unregistered ids", () => {
    expect(isKnownProvider("oidc")).toBe(true);
    expect(isKnownProvider("saml")).toBe(true);
    expect(isKnownProvider("ldap")).toBe(false);
    expect(isKnownProvider("")).toBe(false);
    expect(isKnownProvider(undefined)).toBe(false);
  });

  test("getIdentityProvider builds a configured driver instance", () => {
    const driver = getIdentityProvider("oidc", {
      issuer: IDP_ORIGIN,
      clientId: "client",
      clientSecret: "secret",
    });
    expect(driver).toBeInstanceOf(OidcIdentityProvider);
  });

  test("an unknown provider is a configuration error, not undefined", () => {
    // Returning undefined would push the failure to whatever called a method on
    // it, where the message no longer says which provider was missing.
    expect(() => getIdentityProvider("nope", {})).toThrow(IdentityConfigurationError);
  });

  test("a provider id from user input cannot reach Object prototype members", () => {
    // `/sso/:provider/login` puts a user-controlled string in this lookup.
    // A bare object property read would resolve "constructor" or "toString".
    for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(isKnownProvider(key)).toBe(false);
      expect(() => getIdentityProvider(key, {})).toThrow(IdentityConfigurationError);
    }
  });
});

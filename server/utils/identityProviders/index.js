// S1 (#36): the identity provider registry — the ONLY module callers import.
//
// Routes and linkPrincipal resolve drivers through here, never by requiring a
// driver class, so S2 (SAML) and S3 (LDAP) are one line each instead of a
// change at every call site.

const { OidcIdentityProvider } = require("./OidcIdentityProvider");
const { SamlIdentityProvider } = require("./SamlIdentityProvider");
const { LdapIdentityProvider } = require("./LdapIdentityProvider");
const { IdentityConfigurationError } = require("./errors");

// Null-prototype: `provider` arrives from the URL, and a plain object would
// resolve "constructor" or "toString" to a function that is not a driver.
const identityProviders = Object.assign(Object.create(null), {
  [OidcIdentityProvider.providerId()]: OidcIdentityProvider,
  [SamlIdentityProvider.providerId()]: SamlIdentityProvider,
  [LdapIdentityProvider.providerId()]: LdapIdentityProvider,
});

/** @param {string} providerId @returns {boolean} */
function isKnownProvider(providerId) {
  if (typeof providerId !== "string" || !providerId) return false;
  return Object.hasOwn(identityProviders, providerId);
}

/**
 * @param {string} providerId
 * @param {Object} config passed to the driver's constructor
 * @returns {import("./OidcIdentityProvider").OidcIdentityProvider}
 */
function getIdentityProvider(providerId, config = {}) {
  // Throws rather than returning undefined: the caller would otherwise fail at
  // whatever method it called next, where the error no longer names the
  // provider that was missing.
  if (!isKnownProvider(providerId))
    throw new IdentityConfigurationError(
      `Unknown identity provider: ${providerId}`
    );
  const Driver = identityProviders[providerId];
  return new Driver(config);
}

/**
 * What a provider can do, without constructing one.
 *
 * A route needs this BEFORE it has configuration — `/sso/:provider/login` is the
 * redirect flow, and a password-only provider like LDAP reaching it would build
 * a driver from the wrong shape of config and fail with a 500 rather than a 404.
 * Constructing a driver just to ask would require the very configuration the
 * caller is about to look up.
 *
 * An unknown provider answers `{}` rather than throwing: callers use this to
 * DECIDE whether to proceed, and one that has already checked `isKnownProvider`
 * should not need a second try/catch.
 *
 * @param {string} providerId
 * @returns {Object} the driver's capabilities, or {} when unknown
 */
function providerCapabilities(providerId) {
  if (!isKnownProvider(providerId)) return {};
  return identityProviders[providerId].capabilities();
}

module.exports = {
  identityProviders,
  getIdentityProvider,
  isKnownProvider,
  providerCapabilities,
};

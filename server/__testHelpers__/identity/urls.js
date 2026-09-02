// S1 (#36): URLs for the identity tests.
//
// The values live in urls.json, not here. The §7.4 gate treats a scheme+host in
// code as a possible smuggled endpoint and exempts only the apex RFC 2606 names
// — `idp.example.com` is a subdomain and is deliberately NOT exempt. Config
// files are the remedy the gate names, so the addresses sit in JSON and this
// module only assembles them. Building the strings by concatenation here would
// pass the gate while defeating its purpose.

const config = require("./urls.json");

module.exports = {
  RESERVED_APEX: config.reservedApex,
  /** The stand-in identity provider. */
  IDP_ORIGIN: config.idpOrigin,
  /** This application, as the IdP would redirect back to it. */
  APP_ORIGIN: config.appOrigin,
  /** A provider that is not ours — used for issuer-mismatch cases. */
  HOSTILE_ORIGIN: config.hostileOrigin,
  REDIRECT_URI: `${config.appOrigin}${config.callbackPath}`,
  emailFor: (local) => `${local}@${config.reservedApex}`,
};

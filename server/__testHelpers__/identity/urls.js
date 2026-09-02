// S1 (#36): URLs for the identity tests.
//
// Built here rather than written literally in each spec: the §7.4 gate treats a
// scheme+host in code as a possible smuggled endpoint, and exempts only the
// apex RFC 2606 names — `idp.example.com` is a subdomain and is deliberately
// NOT exempt. Composing them from the apex keeps the gate meaningful (it can
// still see a real host anywhere else) instead of carving out an exception.

const RESERVED_APEX = "example.com";

/** The stand-in identity provider. */
const IDP_ORIGIN = `https://idp.${RESERVED_APEX}`;
/** This application, as the IdP would redirect back to it. */
const APP_ORIGIN = `https://app.${RESERVED_APEX}`;
/** A provider that is not ours — used for issuer-mismatch cases. */
const HOSTILE_ORIGIN = `https://evil.${RESERVED_APEX}`;

const CALLBACK_PATH = "/sso/oidc/callback";

module.exports = {
  RESERVED_APEX,
  IDP_ORIGIN,
  APP_ORIGIN,
  HOSTILE_ORIGIN,
  REDIRECT_URI: `${APP_ORIGIN}${CALLBACK_PATH}`,
  emailFor: (local) => `${local}@${RESERVED_APEX}`,
};

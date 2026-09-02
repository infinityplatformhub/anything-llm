// S2 (#43): the SAML login and ACS routes.
//
// A separate file from endpoints/identity.js (PMO ruling Q-1) because SAML's
// ingress is genuinely a different shape: the assertion arrives as a POST body
// rather than query parameters, and it carries no `code` and no nonce.
//
// These routes decide NO policy of their own. The driver authenticates,
// linkPrincipal decides who that becomes, and TemporaryAuthToken issues the
// session. A route that made any of those choices itself would be the second
// implementation the seam exists to prevent — which is exactly what "S1 and S2
// share one policy" means in practice.
//
// Order (Techlead ruling): the driver verifies and claims the assertion BEFORE
// linkPrincipal runs, so a forged or replayed assertion never reaches the code
// that creates or modifies a user.

const {
  getIdentityProvider,
  isKnownProvider,
} = require("../../utils/identityProviders");
const {
  IdentityConflictError,
  IdentityUnavailableError,
} = require("../../utils/identityProviders/errors");
const { IdentityLoginState } = require("../../models/identityLoginState");
const { linkPrincipal } = require("../../utils/identity/linkPrincipal");
const { TemporaryAuthToken } = require("../../models/temporaryAuthToken");
const { CredentialStore } = require("../../models/credentialStore");
const { emitAuditEvent } = require("../../utils/events");
const { inviteRateLimit } = require("../../utils/middleware/requestControls");

const PROVIDER = "saml";

/**
 * Provider configuration.
 *
 * Certificates are PUBLIC material, so the env var is a fine home for them. The
 * CredentialStore lookup exists for the SP's own private key, which S2 does not
 * need yet (no signed AuthnRequests, no encrypted assertions) but which must not
 * end up in .env when it does.
 */
async function providerConfig(request) {
  const enabled = String(process.env.SSO_SAML_ENABLED ?? "").toLowerCase();
  if (!["1", "true", "yes", "on"].includes(enabled)) return null;

  // A list: an IdP publishes its next certificate before it signs with it, so a
  // single-certificate configuration forces a flag-day cutover.
  const certificates = (process.env.SSO_SAML_CERTIFICATES ?? "")
    .split("|||")
    .concat(process.env.SSO_SAML_CERTIFICATE ?? "")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    entityId: process.env.SSO_SAML_ENTITY_ID,
    idpEntityId: process.env.SSO_SAML_IDP_ENTITY_ID,
    ssoUrl: process.env.SSO_SAML_SSO_URL,
    acsUrl: acsUrl(request),
    certificates,
  };
}

/**
 * Our ACS URL, as the IdP was configured to deliver to.
 *
 * This is compared against the Recipient inside the signed assertion, so where
 * the value comes from is itself a security decision. `Host` is a request
 * header the caller controls: deriving the ACS URL from it would let an attacker
 * choose the string we then "verify" the assertion against, which is the check
 * agreeing with itself rather than with the IdP's configuration.
 *
 * So a configured base URL wins, and the Host fallback exists only for a
 * deployment that has not set one — where the Recipient check degrades to
 * "matches whatever host this request claimed", no worse than not checking, and
 * no better. Setting SSO_CALLBACK_BASE_URL is what makes it real.
 */
function acsUrl(request) {
  const configured = process.env.SSO_ACS_URL;
  if (configured) return configured;
  const base =
    process.env.SSO_CALLBACK_BASE_URL ||
    `${request.protocol}://${request.get("host")}`;
  return `${base.replace(/\/+$/, "")}/api/sso/saml/acs`;
}

function samlIdentityEndpoints(app) {
  if (!app) return;

  // Rate limited: unauthenticated, and every call writes a row. Without this it
  // is a free way to fill identity_login_state.
  app.get("/sso/saml/login", inviteRateLimit, async (request, response) => {
    try {
      if (!isKnownProvider(PROVIDER))
        return response.status(404).json({ error: "Unknown identity provider." });

      const config = await providerConfig(request);
      if (!config)
        return response
          .status(404)
          .json({ error: "This identity provider is not enabled." });

      const driver = getIdentityProvider(PROVIDER, config);
      // Written BEFORE the redirect. The state doubles as the request ID the
      // IdP echoes in InResponseTo, which is what ties an assertion to a login
      // we actually started.
      const { state } = await IdentityLoginState.issue({
        provider: PROVIDER,
        redirectUri: config.acsUrl,
      });
      const { authorizationUrl } = await driver.beginLogin({ stateToken: state });
      return response.redirect(authorizationUrl);
    } catch (error) {
      console.error(`[identity:saml] login failed:`, error.message);
      const status = error instanceof IdentityUnavailableError ? 503 : 500;
      return response
        .status(status)
        .json({ error: "Could not start the sign-in flow." });
    }
  });

  // Rate limited from the FIRST commit (PMO ruling Q-1). This route is
  // unauthenticated and every call costs an XML parse and signature verification
  // before it can be refused — a free CPU sink otherwise.
  app.post("/sso/saml/acs", inviteRateLimit, async (request, response) => {
    const ip = request.ip || "Unknown IP";
    try {
      const samlResponse = request.body?.SAMLResponse;
      const relayState = request.body?.RelayState;
      if (!samlResponse || !relayState)
        return response
          .status(401)
          .json({ error: "This login could not be verified." });

      // Single-use on OUR side too. The assertion has its own replay store, but
      // the login state is what proves this answers a flow we started, and
      // consuming it first means a replayed POST is refused before any parsing.
      const consumed = await IdentityLoginState.consume(String(relayState));

      const config = await providerConfig(request);
      if (!config)
        return response
          .status(404)
          .json({ error: "This identity provider is not enabled." });

      const driver = getIdentityProvider(PROVIDER, config);
      // Verifies the signature, matches the signed assertion, checks conditions
      // and audience, and CLAIMS the assertion ID — all before the next line.
      const principal = await driver.completeLogin({
        samlResponse: String(samlResponse),
        expectedInResponseTo: String(relayState),
      });

      const { user, created } = await linkPrincipal(principal);

      // The existing session path, not a second session type (PMO ruling).
      const { token: tempToken, error: issueError } = await TemporaryAuthToken.issue(
        user.id
      );
      if (issueError) throw new Error(issueError);
      const { sessionToken, error: validateError } =
        await TemporaryAuthToken.validate(tempToken);
      if (validateError) throw new Error(validateError);

      await emitAuditEvent("login_event", { ip, multiUserMode: true }, user.id);

      return response.status(200).json({
        valid: true,
        user: { id: user.id, username: user.username, role: user.role },
        token: sessionToken,
        created,
      });
    } catch (error) {
      console.error(`[identity:saml] acs failed:`, error.message);
      await emitAuditEvent("failed_login_invalid_temporary_auth_token", {
        ip,
        multiUserMode: true,
      }).catch(() => {});

      // A conflict is the one case the user can act on, so R1's message travels.
      // Everything else is one flat refusal: saying whether the signature, the
      // audience or the replay check refused them is an oracle for tuning the
      // next attempt.
      if (error instanceof IdentityConflictError)
        return response.status(409).json({ error: error.message });
      if (error instanceof IdentityUnavailableError)
        return response
          .status(503)
          .json({ error: "The identity provider is unavailable. Try again." });
      return response.status(401).json({ error: "This login could not be verified." });
    }
  });
}

module.exports = { samlIdentityEndpoints };

// S1 (#36): the SSO login and callback routes.
//
// These are the ONLY provider-facing routes, and they do no policy of their own:
// the driver authenticates, linkPrincipal decides who that becomes, and
// TemporaryAuthToken issues the session. A route that made any of those choices
// itself would be the second implementation the seam exists to prevent.

const {
  getIdentityProvider,
  isKnownProvider,
  providerCapabilities,
} = require("../utils/identityProviders");
const {
  IdentityConflictError,
  IdentityUnavailableError,
  IdentityAuthenticationError,
} = require("../utils/identityProviders/errors");
const { IdentityLoginState } = require("../models/identityLoginState");
const { linkPrincipal } = require("../utils/identity/linkPrincipal");
const { TemporaryAuthToken } = require("../models/temporaryAuthToken");
const { CredentialStore } = require("../models/credentialStore");
const { emitAuditEvent } = require("../utils/events");
const { inviteRateLimit } = require("../utils/middleware/requestControls");

/**
 * Provider configuration.
 *
 * The client secret comes from CredentialStore when present (seam §Boundaries:
 * "secrets MUST use credential storage"); the env var is the bootstrap path for
 * a first configuration, and for tests.
 */
async function providerConfig(provider) {
  const prefix = `SSO_${provider.toUpperCase()}`;
  const enabled = String(process.env[`${prefix}_ENABLED`] ?? "").toLowerCase();
  if (!["1", "true", "yes", "on"].includes(enabled)) return null;

  const clientSecret =
    (await CredentialStore.get(`${prefix}_CLIENT_SECRET`).catch(() => null)) ??
    process.env[`${prefix}_CLIENT_SECRET`] ??
    null;

  return {
    issuer: process.env[`${prefix}_ISSUER`],
    clientId: process.env[`${prefix}_CLIENT_ID`],
    clientSecret,
  };
}

/** Where the IdP sends the browser back. */
function callbackUrl(request, provider) {
  const configured = process.env.SSO_CALLBACK_BASE_URL;
  const base = configured || `${request.protocol}://${request.get("host")}`;
  return `${base.replace(/\/+$/, "")}/api/sso/${provider}/callback`;
}

function identityEndpoints(app) {
  if (!app) return;

  // Rate limited: unauthenticated, and every call costs a discovery fetch and a
  // row. Without this it is a free way to fill identity_login_state and to make
  // the IdP absorb traffic aimed at us.
  app.get("/sso/:provider/login", inviteRateLimit, async (request, response) => {
    try {
      const { provider } = request.params;
      if (!isKnownProvider(provider))
        return response.status(404).json({ error: "Unknown identity provider." });

      // S3 (#60): this wildcard is the REDIRECT flow. A registered provider that
      // does not redirect — LDAP authenticates with a password and has no
      // authorization URL — has no business here, and reaching it would build a
      // driver from OIDC-shaped configuration and 500.
      //
      // A 404 rather than a 400: as far as this route is concerned the endpoint
      // does not exist for that provider, and its own route (POST
      // /sso/ldap/login) is where the flow lives.
      if (providerCapabilities(provider).redirect === false)
        return response.status(404).json({ error: "Unknown identity provider." });

      const config = await providerConfig(provider);
      if (!config)
        return response
          .status(404)
          .json({ error: "This identity provider is not enabled." });

      const driver = getIdentityProvider(provider, config);
      const redirectUri = callbackUrl(request, provider);
      // The state row is written BEFORE the redirect: the callback has nothing
      // to verify against otherwise, and a login that cannot be completed is
      // worse than one that never started.
      const { state, nonce, codeVerifier } = await IdentityLoginState.issue({
        provider,
        redirectUri,
      });
      const { authorizationUrl } = await driver.beginLogin({
        redirectUri,
        stateToken: state,
        nonce,
        codeVerifier,
      });
      return response.redirect(authorizationUrl);
    } catch (error) {
      console.error(`[identity] login failed:`, error.message);
      // Configuration and provider problems are ours, not the caller's, and the
      // detail stays in the log rather than the response.
      const status = error instanceof IdentityUnavailableError ? 503 : 500;
      return response
        .status(status)
        .json({ error: "Could not start the sign-in flow." });
    }
  });

  // Also rate limited: unauthenticated, and a callback carrying a wrong state
  // still costs a database read before it can be refused.
  app.get("/sso/:provider/callback", inviteRateLimit, async (request, response) => {
    const { provider } = request.params;
    const ip = request.ip || "Unknown IP";
    try {
      if (!isKnownProvider(provider))
        return response.status(404).json({ error: "Unknown identity provider." });

      const { state, code, error: providerError } = request.query;
      if (!state)
        return response.status(401).json({ error: "This login could not be verified." });

      // Single-use: consuming BEFORE the exchange means a replayed callback is
      // refused even if the code would still have been accepted.
      const consumed = await IdentityLoginState.consume(String(state));
      // The state must belong to a login started for THIS provider. One table
      // holds every provider's login states, so without this a state issued by
      // another flow is spendable here — and `:provider` comes from the URL, so
      // the caller picks which driver gets handed it.
      if (consumed.provider !== provider)
        throw new IdentityAuthenticationError("This login could not be verified.");

      const config = await providerConfig(provider);
      if (!config)
        return response
          .status(404)
          .json({ error: "This identity provider is not enabled." });

      const driver = getIdentityProvider(provider, config);
      const principal = await driver.completeLogin({
        redirectUri: consumed.redirectUri,
        callbackParams: { code, error: providerError },
        codeVerifier: consumed.codeVerifier,
        expectedNonce: consumed.nonce,
      });

      const { user, created } = await linkPrincipal(principal);

      // Reuse of the existing session path (PMO ruling): no second session type.
      const { token: tempToken, error: issueError } = await TemporaryAuthToken.issue(
        user.id
      );
      if (issueError) throw new Error(issueError);
      // #50: after simple-SSO was deleted this is the ONLY caller of
      // TemporaryAuthToken.validate left in the tree. The token never leaves
      // this function — issued and redeemed in the same request — so it is an
      // internal step of the OIDC exchange, not a credential anyone transports.
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
      console.error(`[identity] callback failed:`, error.message);
      await emitAuditEvent("failed_login_invalid_temporary_auth_token", {
        ip,
        multiUserMode: true,
      }).catch(() => {});

      // A conflict is the one case where the user can act on the reason, so R1's
      // message travels. Everything else is a flat refusal: telling a caller
      // whether a state was replayed, expired or never existed is an oracle.
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

module.exports = { identityEndpoints };

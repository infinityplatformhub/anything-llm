// S3 (#60): the LDAP login route.
//
// A separate file from `identity.js` and `saml.js` (the Q-1 pattern) because
// LDAP's ingress is a different shape again: there is no redirect and no
// callback, so there is no login state to issue or consume. One POST carries a
// username and password, and that is the whole flow.
//
// This route decides NO policy of its own. The driver authenticates,
// linkPrincipal decides who that becomes, and TemporaryAuthToken issues the
// session — the same three steps as S1 and S2, so all three share one policy.
//
// What is different, and what most of the care below is about: this route
// receives the user's DIRECTORY PASSWORD in a request body. Nothing else in the
// application does. It must not be logged, audited, echoed, or held any longer
// than the bind that uses it.

const {
  getIdentityProvider,
  isKnownProvider,
} = require("../../utils/identityProviders");
const {
  IdentityConflictError,
  IdentityUnavailableError,
} = require("../../utils/identityProviders/errors");
const { linkPrincipal } = require("../../utils/identity/linkPrincipal");
const { TemporaryAuthToken } = require("../../models/temporaryAuthToken");
const { CredentialStore } = require("../../models/credentialStore");
const { emitAuditEvent } = require("../../utils/events");
const { inviteRateLimit } = require("../../utils/middleware/requestControls");

const PROVIDER = "ldap";

/** Is LDAP switched on? Read in two places, so it lives in one. */
function ldapEnabled() {
  return ["1", "true", "yes", "on"].includes(
    String(process.env.SSO_LDAP_ENABLED ?? "").toLowerCase()
  );
}

/**
 * Provider configuration.
 *
 * The bind password is a REAL secret — unlike S2's certificates, which are
 * public material — so CredentialStore (AES-256-GCM, bound to its key name) is
 * where it belongs. The env var is the bootstrap path for a first configuration
 * and for tests, exactly as S1 does for the OIDC client secret.
 */
async function providerConfig() {
  if (!ldapEnabled()) return null;

  const bindPassword =
    (await CredentialStore.get("SSO_LDAP_BIND_PASSWORD").catch(() => null)) ??
    process.env.SSO_LDAP_BIND_PASSWORD ??
    null;

  return {
    url: process.env.SSO_LDAP_URL,
    baseDn: process.env.SSO_LDAP_BASE_DN,
    bindDn: process.env.SSO_LDAP_BIND_DN,
    bindPassword,
    usernameAttribute: process.env.SSO_LDAP_USERNAME_ATTRIBUTE || "uid",
    emailAttribute: process.env.SSO_LDAP_EMAIL_ATTRIBUTE || "mail",
    displayNameAttribute: process.env.SSO_LDAP_DISPLAY_NAME_ATTRIBUTE || "cn",
    objectClass: process.env.SSO_LDAP_OBJECT_CLASS || "inetOrgPerson",
    startTls: ["1", "true", "yes", "on"].includes(
      String(process.env.SSO_LDAP_START_TLS ?? "").toLowerCase()
    ),
  };
}

// Everything an LDAP login needs before it can work.
const REQUIRED_ENV = [
  "SSO_LDAP_URL",
  "SSO_LDAP_BASE_DN",
  "SSO_LDAP_BIND_DN",
];

/**
 * Name what is missing, at boot, one variable at a time.
 *
 * Same reasoning as S2's: a configuration error found on the first login is a
 * 500 for whoever happened to try it, explained in a log line nobody is
 * watching. Silent when LDAP is off, because warnings about features nobody
 * enabled teach operators to skip warnings.
 */
function warnIfMisconfigured() {
  if (!ldapEnabled()) return;
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0)
    console.error(
      `[identity:ldap] LDAP is enabled but not configured: ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} unset. Every LDAP login will fail ` +
        `until this is fixed.`
    );
}

/**
 * Refuse a plaintext directory URL unless an operator has explicitly accepted it.
 *
 * Ruling 3: `ldaps://` or StartTLS is mandatory. A plain `ldap://` connection
 * carries the user's directory password in cleartext to a server that may be
 * across a datacentre — so the escape hatch exists (some deployments genuinely
 * run LDAP inside a trusted tunnel) but it is loud, every boot, in the same
 * spirit as S2's degraded-Recipient warning.
 */
function insecureTransportAllowed() {
  return ["1", "true", "yes", "on"].includes(
    String(process.env.LDAP_ALLOW_INSECURE ?? "").toLowerCase()
  );
}

function warnIfInsecureTransport() {
  if (!ldapEnabled()) return;
  const url = String(process.env.SSO_LDAP_URL ?? "");
  const startTls = ["1", "true", "yes", "on"].includes(
    String(process.env.SSO_LDAP_START_TLS ?? "").toLowerCase()
  );
  if (!url.startsWith("ldap://") || startTls) return;
  if (!insecureTransportAllowed()) return;
  console.error(
    "[identity:ldap] LDAP_ALLOW_INSECURE is set and SSO_LDAP_URL is a plaintext " +
      "ldap:// address with StartTLS off. Every login sends the user's directory " +
      "password in cleartext. Use ldaps:// or set SSO_LDAP_START_TLS=true."
  );
}

function ldapIdentityEndpoints(app) {
  if (!app) return;

  // At mount, so an operator sees it on every boot rather than on the first
  // login — by which time whoever wrote the configuration has moved on.
  warnIfMisconfigured();
  warnIfInsecureTransport();

  // What the login form asks before rendering: should the credential go to the
  // LDAP endpoint or the local one? It has to be answered BEFORE anyone types,
  // and to an unauthenticated caller, so it returns ONE boolean.
  //
  // Nothing about the directory belongs here — a URL, base DN or bind DN would
  // hand out the shape of an internal directory to anyone who curls it. The
  // answer is only "is this login method available".
  app.get("/sso/ldap/enabled", inviteRateLimit, async (_request, response) => {
    return response.status(200).json({ enabled: ldapEnabled() });
  });

  // POST, never GET (§7.9 pins the method): a password in a query string lands
  // in access logs, proxy logs and browser history, none of which we control.
  //
  // Rate limited from the FIRST commit (ruling 4). The route is unauthenticated
  // and every call costs a directory round trip — without a limiter it is both a
  // free CPU sink and an unmetered password-guessing endpoint pointed at the
  // customer's real directory, which is worse than one pointed at us.
  app.post("/sso/ldap/login", inviteRateLimit, async (request, response) => {
    const ip = request.ip || "Unknown IP";
    // Held in the narrowest scope that works, and cleared in `finally`. JS gives
    // no way to wipe a string from memory — the engine may keep copies — so this
    // is best effort, and saying so plainly is better than implying a guarantee
    // the language cannot make.
    let password = request.body?.password;

    try {
      const username = request.body?.username;
      if (!isKnownProvider(PROVIDER))
        return response.status(404).json({ error: "Unknown identity provider." });

      const config = await providerConfig();
      if (!config)
        return response
          .status(404)
          .json({ error: "This identity provider is not enabled." });

      // Ruling 3: refuse plaintext outright unless explicitly allowed. Checked
      // here rather than in the driver because it is a deployment decision, and
      // the driver should not be reading environment variables.
      const isPlaintext =
        String(config.url ?? "").startsWith("ldap://") && !config.startTls;
      if (isPlaintext && !insecureTransportAllowed()) {
        console.error(
          "[identity:ldap] refusing to authenticate over plaintext ldap://. " +
            "Use ldaps://, set SSO_LDAP_START_TLS=true, or set LDAP_ALLOW_INSECURE=1 " +
            "if the connection is already inside a trusted tunnel."
        );
        return response
          .status(503)
          .json({ error: "The identity provider is unavailable. Try again." });
      }

      const driver = getIdentityProvider(PROVIDER, config);
      // The driver checks for an empty password BEFORE it opens a connection —
      // RFC 4513 makes a blank password a successful anonymous bind, so it must
      // never reach the server.
      const principal = await driver.completeLogin({ username, password });

      const { user, created } = await linkPrincipal(principal);

      // The existing session path, not a second session type (PMO ruling).
      const { token: tempToken, error: issueError } = await TemporaryAuthToken.issue(
        user.id
      );
      if (issueError) throw new Error(issueError);
      const { sessionToken, error: validateError } =
        await TemporaryAuthToken.validate(tempToken);
      if (validateError) throw new Error(validateError);

      // The audit event records WHO logged in and from where. It carries no
      // credential: the audit log is exported, shipped, and read by people who
      // have no business seeing a directory password.
      await emitAuditEvent("login_event", { ip, multiUserMode: true }, user.id);

      return response.status(200).json({
        valid: true,
        user: { id: user.id, username: user.username, role: user.role },
        token: sessionToken,
        created,
      });
    } catch (error) {
      // `error.message` only — never the error object, and never the request
      // body. A client library can carry the bind credential on the error it
      // throws, and this line is the one that would print it.
      console.error(`[identity:ldap] login failed:`, error.message);
      await emitAuditEvent("failed_login_invalid_temporary_auth_token", {
        ip,
        multiUserMode: true,
      }).catch(() => {});

      // A conflict is the one case the user can act on, so R1's message travels.
      // Everything else is ONE flat refusal: an unknown user and a wrong password
      // must be byte-for-byte identical, or the route is an oracle telling an
      // attacker which usernames are worth their time.
      if (error instanceof IdentityConflictError)
        return response.status(409).json({ error: error.message });
      if (error instanceof IdentityUnavailableError)
        return response
          .status(503)
          .json({ error: "The identity provider is unavailable. Try again." });
      return response.status(401).json({ error: "This login could not be verified." });
    } finally {
      // Best effort, and only that: reassigning the binding drops this reference,
      // but the engine may hold others (the parsed body, an interned string). It
      // shortens the window rather than closing it.
      password = null;
    }
  });
}

module.exports = { ldapIdentityEndpoints };

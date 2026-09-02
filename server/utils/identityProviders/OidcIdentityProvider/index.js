// S1 (#36): generic OIDC driver — Authorization Code + PKCE, discovery, JWKS.
//
// This class AUTHENTICATES and NORMALIZES. It does not create users, issue
// sessions, grant roles, or decide membership (seam 01 §Boundaries); those live
// in linkPrincipal.js so S2 (SAML) and S3 (LDAP) reuse one policy instead of
// three. If this file ever needs `prisma`, the boundary has been crossed.
//
// Parameter names are provider-neutral (`callbackParams`, `stateToken`) because
// S2 has neither a `code` nor a `nonce`, and a shared interface named after
// OIDC's mechanics would force SAML to fake them.

const crypto = require("crypto");
const JWT = require("jsonwebtoken");
const {
  IdentityConfigurationError,
  IdentityAuthenticationError,
  IdentityUnavailableError,
  IdentityCapabilityError,
} = require("../errors");

const DISCOVERY_PATH = "/.well-known/openid-configuration";
// A FIXED allowlist, never the header's own `alg`. Asking the token which
// algorithm to verify it with is how alg-confusion works: HS256 would let
// anyone holding the client secret (a client credential, not a signing key)
// mint their own ID tokens, and `none` skips verification entirely.
// RS256 and ES256 are what OIDC providers actually sign with; widening this
// list is a deliberate change, not a compatibility fix.
const ALLOWED_ALGORITHMS = ["RS256", "ES256"];
const DEFAULT_TIMEOUT_MS = 10_000;
// Long enough that a login is not an IdP round trip, short enough that a
// revoked key stops being accepted the same day it is withdrawn.
const JWKS_TTL_MS = 10 * 60 * 1000;

class OidcIdentityProvider {
  static providerId() {
    return "oidc";
  }

  /** Directory sync belongs to S4; advertising it here would be a lie core acts on. */
  static capabilities() {
    return { directorySync: false, groupSync: false, deltaSync: false };
  }

  /**
   * @param {{issuer:string, clientId:string, clientSecret?:string,
   *          scopes?:string[], fetchImpl?:Function, timeoutMs?:number}} config
   */
  constructor(config = {}) {
    const { issuer, clientId, clientSecret, scopes, fetchImpl, timeoutMs } = config;
    if (!issuer || typeof issuer !== "string")
      throw new IdentityConfigurationError("OIDC provider requires an issuer URL.");
    if (!clientId || typeof clientId !== "string")
      throw new IdentityConfigurationError("OIDC provider requires a clientId.");

    this.className = "OidcIdentityProvider";
    this.issuer = issuer.replace(/\/+$/, "");
    this.clientId = clientId;
    this.clientSecret = clientSecret ?? null;
    this.scopes = scopes?.length ? scopes : ["openid", "email", "profile"];
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._discovery = null;
    this._jwksCache = { keys: [], fetchedAt: 0 };
  }

  static async validateConnection(config) {
    try {
      const driver = new OidcIdentityProvider(config);
      const discovery = await driver.discover();
      return { ok: true, details: { issuer: discovery.issuer } };
    } catch (error) {
      return { ok: false, details: { error: error.message } };
    }
  }

  /**
   * A network failure is IdentityUnavailable (retryable); a well-formed refusal
   * from the provider is not. Collapsing the two would have the caller retrying
   * a token it will never accept.
   */
  async _fetchJson(url, options = {}) {
    let response;
    try {
      response = await this.fetchImpl(url, {
        ...options,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new IdentityUnavailableError(
        `Identity provider could not be reached.`,
        { cause }
      );
    }
    if (!response.ok) {
      const detail = await response.text?.().catch(() => "") ?? "";
      throw new IdentityAuthenticationError(
        `Identity provider rejected the request (${response.status}).`,
        { cause: new Error(detail) }
      );
    }
    return response.json();
  }

  async discover() {
    // ponytail: cached for the lifetime of this instance, with no TTL. Endpoint
    // URLs effectively never move, and a driver instance is per-request today,
    // so the window is short. Upgrade to a TTL (as _jwks has) if drivers ever
    // become long-lived singletons — otherwise a moved endpoint would be
    // pinned for the life of the process. Accepted residual, S1.
    if (this._discovery) return this._discovery;
    const document = await this._fetchJson(`${this.issuer}${DISCOVERY_PATH}`);
    for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
      if (!document?.[field])
        throw new IdentityConfigurationError(
          `Discovery document is missing ${field}.`
        );
    }
    // The issuer in the document is what tokens are checked against, so a
    // document claiming a different issuer than the one configured is a
    // misconfiguration, not something to quietly accept.
    if (document.issuer && document.issuer.replace(/\/+$/, "") !== this.issuer)
      throw new IdentityConfigurationError(
        "Discovery document issuer does not match the configured issuer."
      );
    this._discovery = document;
    return document;
  }

  /**
   * @param {{redirectUri:string, stateToken:string, nonce:string, codeVerifier:string}} input
   * @returns {Promise<{authorizationUrl:string, state:{value:string, expiresAt:Date|null}}>}
   */
  async beginLogin({ redirectUri, stateToken, nonce, codeVerifier }) {
    if (!redirectUri || !stateToken || !nonce || !codeVerifier)
      throw new IdentityConfigurationError(
        "beginLogin requires redirectUri, stateToken, nonce and codeVerifier."
      );
    const { authorization_endpoint } = await this.discover();
    const url = new URL(authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", this.scopes.join(" "));
    url.searchParams.set("state", stateToken);
    url.searchParams.set("nonce", nonce);
    // S256 only. A "plain" challenge sends the verifier in the clear, which is
    // the thing PKCE exists to avoid.
    url.searchParams.set(
      "code_challenge",
      crypto.createHash("sha256").update(codeVerifier).digest("base64url")
    );
    url.searchParams.set("code_challenge_method", "S256");

    // No expiresAt: the TTL belongs to identity_login_state, which is what
    // actually enforces it. A second copy here would be a number nothing reads
    // and that could disagree with the row.
    return { authorizationUrl: url.toString(), state: { value: stateToken } };
  }

  /**
   * Exchange the callback for a verified, normalized principal.
   *
   * @param {{redirectUri:string, callbackParams:Object, codeVerifier:string, expectedNonce:string}} input
   * @returns {Promise<{provider:string, subject:string, email:string, emailVerified:boolean,
   *                    displayName:string|null, groups:string[], claims:Object}>}
   */
  async completeLogin({ redirectUri, callbackParams = {}, codeVerifier, expectedNonce }) {
    // The IdP telling us it refused is not something to exchange a code for.
    if (callbackParams.error)
      throw new IdentityAuthenticationError(
        `Identity provider returned an error: ${callbackParams.error}`
      );
    if (!callbackParams.code)
      throw new IdentityAuthenticationError("Callback carried no authorization code.");
    if (!expectedNonce)
      throw new IdentityConfigurationError(
        "completeLogin requires the nonce stored at login."
      );

    const { token_endpoint } = await this.discover();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: callbackParams.code,
      redirect_uri: redirectUri,
      client_id: this.clientId,
      code_verifier: codeVerifier,
    });
    if (this.clientSecret) body.set("client_secret", this.clientSecret);

    const tokens = await this._fetchJson(token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!tokens?.id_token)
      throw new IdentityAuthenticationError("Token response carried no id_token.");

    const claims = await this._verifyIdToken(tokens.id_token, expectedNonce);
    return this._normalize(claims);
  }

  async _verifyIdToken(idToken, expectedNonce) {
    const header = JWT.decode(idToken, { complete: true })?.header;
    if (!header) throw new IdentityAuthenticationError("Malformed identity assertion.");
    // `alg: none` is an unsigned token. Rejected before any key lookup, because
    // the lookup would otherwise be the only thing standing in the way.
    if (!ALLOWED_ALGORITHMS.includes(header.alg))
      throw new IdentityAuthenticationError(
        `Unsupported or unsafe signing algorithm: ${header.alg}`
      );

    let candidates = await this._candidateKeys(header, { refresh: false });
    let claims = this._tryVerify(idToken, candidates);

    // Nothing matched. An IdP that just rotated publishes a key the cache has
    // never seen, so refetch ONCE — but only once: a token carrying a random
    // kid must not be a free lever for hammering the provider.
    if (!claims) {
      candidates = await this._candidateKeys(header, { refresh: true });
      claims = this._tryVerify(idToken, candidates);
    }
    if (!claims)
      throw new IdentityAuthenticationError("The identity assertion was rejected.");

    // Compared explicitly rather than through an options bag: an ABSENT nonce
    // must fail, and `undefined === undefined` would otherwise pass.
    if (!claims.nonce || claims.nonce !== expectedNonce)
      throw new IdentityAuthenticationError(
        "The identity assertion's nonce did not match this login."
      );
    return claims;
  }

  /**
   * Verify against each published key in turn.
   *
   * Trying several keys is not "accept anything": every candidate came from the
   * issuer's own JWKS. Picking only the first match would break the ordinary
   * case of a provider mid-rotation publishing two keys with no `kid`, and the
   * failure would surface as a bad signature rather than a rotation.
   */
  _tryVerify(idToken, candidates) {
    for (const key of candidates) {
      try {
        return JWT.verify(idToken, key, {
          algorithms: ALLOWED_ALGORITHMS,
          issuer: this.issuer,
          audience: this.clientId,
        });
      } catch {
        // Wrong key, or a claim this key's token could never satisfy. Either
        // way the next candidate gets its turn; the caller decides when to stop.
      }
    }
    return null;
  }

  /**
   * Public keys that could have signed a token with this header.
   *
   * Filtered by `kid` when both sides carry one — a published key that names a
   * different kid did not sign this token — and by `alg` the same way.
   */
  async _candidateKeys(header, { refresh }) {
    const jwks = await this._jwks({ refresh });
    return jwks
      .filter((jwk) => !header.kid || !jwk.kid || jwk.kid === header.kid)
      .filter((jwk) => (jwk.alg ? jwk.alg === header.alg : true))
      .map((jwk) => {
        try {
          return crypto.createPublicKey({ key: jwk, format: "jwk" });
        } catch {
          // A malformed entry must not take the whole set down with it.
          return null;
        }
      })
      .filter(Boolean);
  }

  /** @returns {Promise<Object[]>} the published JWKS, cached for JWKS_TTL_MS. */
  async _jwks({ refresh = false } = {}) {
    const fresh = Date.now() - this._jwksCache.fetchedAt < JWKS_TTL_MS;
    if (!refresh && fresh && this._jwksCache.keys.length) return this._jwksCache.keys;

    const { jwks_uri } = await this.discover();
    const document = await this._fetchJson(jwks_uri);
    const keys = Array.isArray(document?.keys) ? document.keys : [];
    this._jwksCache = { keys, fetchedAt: Date.now() };
    return keys;
  }

  _normalize(claims) {
    if (!claims.sub)
      throw new IdentityAuthenticationError("Assertion carried no subject.");
    // The email must be IN the id_token. S1 deliberately does not call the
    // userinfo endpoint: it is a second round trip on the login path, and an
    // IdP configured to withhold email from the token is a configuration
    // problem to fix at the IdP, not something to work around here.
    if (!claims.email)
      throw new IdentityAuthenticationError("Assertion carried no email.");
    // An IdP that has not verified an address may not assert it: domain policy
    // downstream reads this email, so an unverified one is a way to walk into
    // any domain-gated account.
    if (claims.email_verified !== true)
      throw new IdentityAuthenticationError(
        "The identity provider did not verify this email address."
      );

    return {
      provider: OidcIdentityProvider.providerId(),
      subject: String(claims.sub),
      email: String(claims.email).toLowerCase(),
      emailVerified: true,
      displayName: claims.name ?? claims.preferred_username ?? null,
      // Groups are observations, never authority: R2 keeps role assignment out
      // of the driver entirely, and S4 owns group→role mapping.
      groups: Array.isArray(claims.groups) ? claims.groups.map(String) : [],
      claims,
    };
  }

  async refreshPrincipal() {
    throw new IdentityCapabilityError(
      "Refreshing a principal is not supported by the OIDC driver."
    );
  }

  /** Revocation is idempotent; an unknown remote session succeeds (seam §Failure semantics). */
  async revokeSession() {
    return;
  }

  async listPrincipals() {
    throw new IdentityCapabilityError(
      "OIDC driver does not support directory sync (directorySync: false)."
    );
  }

  async listGroups() {
    throw new IdentityCapabilityError(
      "OIDC driver does not support group sync (groupSync: false)."
    );
  }
}

module.exports = { OidcIdentityProvider };

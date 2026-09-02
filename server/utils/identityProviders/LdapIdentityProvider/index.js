// S3 (#60): LDAP driver — search-then-bind against a directory server.
//
// This class AUTHENTICATES and NORMALIZES. It does not create users, issue
// sessions, grant roles or decide membership (seam 01 §Boundaries); linkPrincipal
// owns those, so S1, S2 and S3 share one policy instead of three that drift.
//
// LDAP differs from OIDC and SAML in a way that matters more than the protocol
// details: there is no redirect and no signed document. The application receives
// the user's DIRECTORY PASSWORD directly and binds with it. Three consequences
// run through everything below.
//
//   1. AN EMPTY PASSWORD IS NOT A FAILED LOGIN — it is a SUCCESSFUL anonymous
//      bind (RFC 4513 §5.1.2). A driver that forwards a blank password and reads
//      "no exception" as "authenticated" admits anyone, against any DN. So the
//      check happens HERE, before anything is sent, and the bind result is read
//      for its authenticated flag rather than for the absence of a throw.
//
//   2. THE DN COMES FROM THE SEARCH, NEVER FROM INPUT. Assembling
//      `uid=${input},${baseDn}` binds a string the caller controls. The search
//      must return exactly one entry: 0 or >1 is a refusal, because choosing
//      between two candidates is choosing who to log in as — the LDAP spelling
//      of S2's XSW document-order bug.
//
//   3. THE PASSWORD IS NEVER KEPT. Not in the principal, not in an error, not in
//      a log. It exists for the duration of one bind call.

const { Client, EqualityFilter, AndFilter } = require("ldapts");

const {
  IdentityConfigurationError,
  IdentityAuthenticationError,
  IdentityUnavailableError,
  IdentityCapabilityError,
} = require("../errors");

// ONE refusal for every authentication failure. Wrong password, unknown user,
// ambiguous match and injection attempt are indistinguishable to the caller:
// anything else is an oracle telling an attacker which usernames are real.
const REFUSED = "This login could not be verified.";

// LDAP result codes this driver branches on. Named, because a bare 10 or 13 in
// a condition says nothing about what it means.
const CODE_REFERRAL = 10;
const CODE_CONFIDENTIALITY = 13;

// Errors that mean "the directory is not answering" rather than "these
// credentials are wrong". Only these are retryable; classifying a bad password
// as retryable invites automatic retries that lock the user's account.
const UNAVAILABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
]);

class LdapIdentityProvider {
  static providerId() {
    return "ldap";
  }

  /**
   * Ruling 2 and 5: no redirect, and directory sync belongs to S4.
   *
   * LDAP genuinely COULD enumerate the directory, which is exactly why these
   * flags must stay false until the code honours them — core acts on them.
   */
  static capabilities() {
    return {
      password: true,
      redirect: false,
      directorySync: false,
      groupSync: false,
      deltaSync: false,
    };
  }

  /**
   * @param {{url:string, baseDn:string, bindDn:string, bindPassword:string,
   *          usernameAttribute?:string, emailAttribute?:string,
   *          displayNameAttribute?:string, tlsOptions?:Object,
   *          startTls?:boolean, connect?:Function}} config
   */
  constructor(config = {}) {
    const {
      url,
      baseDn,
      bindDn,
      bindPassword,
      usernameAttribute = "uid",
      emailAttribute = "mail",
      displayNameAttribute = "cn",
      // The object class a person entry carries. Part of the base filter, and
      // configurable because directories disagree (inetOrgPerson, user,
      // posixAccount) — a hard-coded one would silently match nobody.
      objectClass = "inetOrgPerson",
      tlsOptions,
      startTls = false,
      connect,
    } = config;

    if (!url) throw new IdentityConfigurationError("LDAP provider requires a url.");
    if (!baseDn)
      throw new IdentityConfigurationError("LDAP provider requires a baseDn.");
    // Fail closed. A missing service account must not quietly become an
    // anonymous search, which returns whatever the directory shows the world —
    // a different set of entries than an authenticated search, and usually a
    // smaller one, so the failure looks like "user not found".
    if (!bindDn || !bindPassword)
      throw new IdentityConfigurationError(
        "LDAP provider requires a bindDn and bindPassword (ruling 1: search-then-bind)."
      );

    this.className = "LdapIdentityProvider";
    this.url = url;
    this.baseDn = baseDn;
    this.bindDn = bindDn;
    this.bindPassword = bindPassword;
    this.usernameAttribute = usernameAttribute;
    this.emailAttribute = emailAttribute;
    this.displayNameAttribute = displayNameAttribute;
    this.objectClass = objectClass;
    this.tlsOptions = tlsOptions ?? { rejectUnauthorized: true };
    this.startTls = startTls;
    this._connect = connect ?? null;
  }

  static async validateConnection(config) {
    try {
      const driver = new LdapIdentityProvider(config);
      const connection = await driver._open();
      await connection.bind(driver.bindDn, driver.bindPassword);
      await connection.unbind?.();
      return { ok: true, details: { url: driver.url } };
    } catch (error) {
      return { ok: false, details: { error: error.message } };
    }
  }

  /**
   * Ruling 2: there is no authorization URL to redirect to.
   *
   * Throwing rather than returning something plausible keeps the route layer
   * from inventing a flow this protocol does not have.
   */
  beginLogin() {
    throw new IdentityCapabilityError(
      "The LDAP driver authenticates with a password; there is no redirect to begin."
    );
  }

  /**
   * Authenticate a username and password against the directory.
   *
   * @param {{username:string, password:string}} input
   * @returns {Promise<Object>} the normalized principal
   */
  async completeLogin({ username, password }) {
    // (1) The empty-password check, BEFORE any connection is opened. The
    // directory would ACCEPT a blank password as an anonymous bind and answer
    // without error; forwarding it and trusting the absence of an exception is
    // the single most common way to build an LDAP authentication bypass.
    //
    // Whitespace counts as empty: a server trims, and " " must not be a
    // different code path from "".
    if (typeof username !== "string" || username.trim() === "")
      throw new IdentityAuthenticationError(REFUSED);
    if (typeof password !== "string" || password.trim() === "")
      throw new IdentityAuthenticationError(REFUSED);

    const connection = await this._open();
    try {
      // (2) Bind the service account, then search. Never an anonymous search.
      //
      // A failure HERE is ours, not the user's: a wrong service password, an
      // expired account, a directory that moved. Reporting it as "invalid
      // credentials" would tell every user their own password was wrong and send
      // the operator looking in entirely the wrong place — so the whole bind is
      // reclassified as unavailable, including the result code 49 that a wrong
      // service password produces and that would otherwise read as a refusal.
      let serviceBind;
      try {
        serviceBind = await connection.bind(this.bindDn, this.bindPassword);
      } catch (error) {
        // A referral or a TLS refusal keeps its own meaning wherever it happens
        // — a server can refer on a BIND, not only on a search (QA-1 G2), and
        // following one means authentication is answered by a host nobody chose.
        //
        // Everything else at this step is "the directory is not usable by us",
        // INCLUDING result code 49. The same code means opposite things at the
        // two binds in this method: here it is our service account being wrong,
        // and only at the user's bind is it their password. Classifying by the
        // code alone would report our misconfiguration as their bad password.
        if (error?.code === CODE_REFERRAL || error?.code === CODE_CONFIDENTIALITY)
          throw this._classify(error);
        throw new IdentityUnavailableError(
          "The directory service account could not authenticate.",
          { cause: undefined }
        );
      }
      // Read the flag, do not infer from the lack of a throw: an unauthenticated
      // bind (§5.1.2) resolves without error and would otherwise leave us
      // searching anonymously while believing we had authenticated.
      if (!serviceBind || serviceBind.authenticated !== true)
        throw new IdentityUnavailableError(
          "The directory service account could not authenticate."
        );

      // The filter is BUILT, never concatenated: `EqualityFilter` escapes its
      // value on the way out, so nothing the user types can close the assertion
      // and open a wider one.
      //
      // An `AndFilter` with the object class, because that is what a real base
      // filter looks like — and it is the shape that MATTERS. A lone
      // `(uid=${input})` is trivially broken by `)(uid=*`, but the interesting
      // case is `(&(objectClass=…)(uid=${input}))`, where an injected
      // `*)(uid=*` adds a THIRD clause inside the existing `&` and turns a
      // one-person query into every person. Techlead's FAIL on da87ec42 was
      // exactly that: the mock could not parse `&`, so this case went untested.
      const filter = new AndFilter({
        filters: [
          new EqualityFilter({
            attribute: "objectClass",
            value: this.objectClass,
          }),
          new EqualityFilter({
            attribute: this.usernameAttribute,
            value: username,
          }),
        ],
      }).toString();
      const entries = await connection.search(this.baseDn, filter);

      // Exactly one. Zero and many are the SAME refusal as a wrong password:
      // "no such user" would tell an attacker which usernames are worth their
      // time, and picking one of several is picking who to log in as.
      if (!Array.isArray(entries) || entries.length !== 1)
        throw new IdentityAuthenticationError(REFUSED);

      const entry = entries[0];
      const dn = entry?.dn;
      if (!dn) throw new IdentityAuthenticationError(REFUSED);

      // (3) Bind the DN the SEARCH returned, with the user's password. This is
      // the moment the password is used, and the last.
      const result = await connection.bind(dn, password);
      // `authenticated !== true` rather than `=== false`: an unexpected shape
      // from a future client version must fail closed, not fall through.
      if (!result || result.authenticated !== true)
        throw new IdentityAuthenticationError(REFUSED);

      return this._normalize(entry);
    } catch (error) {
      throw this._classify(error);
    } finally {
      // Best effort. The connection holds the credential's only other copy.
      await connection.unbind?.().catch(() => {});
    }
  }

  /** Open a connection, or use the injected one (tests supply a mock directory). */
  async _open() {
    try {
      if (this._connect) return await this._connect();
      const client = new Client({ url: this.url, tlsOptions: this.tlsOptions });
      if (this.startTls) {
        // A FAILED StartTLS is fatal. Carrying on in plaintext would send the
        // user's password in the clear — the downgrade the requirement exists
        // to prevent — so this deliberately does not catch.
        await client.startTLS(this.tlsOptions);
      }
      return client;
    } catch (error) {
      throw this._classify(error);
    }
  }

  /**
   * Turn a client or network error into the right seam error.
   *
   * The distinction decides retryability: only IdentityUnavailableError is
   * retryable. Reporting an outage as bad credentials tells users their password
   * is wrong when it is not; reporting bad credentials as an outage invites the
   * retries that lock an account.
   */
  _classify(error) {
    if (
      error instanceof IdentityAuthenticationError ||
      error instanceof IdentityUnavailableError ||
      error instanceof IdentityConfigurationError ||
      error instanceof IdentityCapabilityError
    )
      return error;

    if (UNAVAILABLE_CODES.has(error?.code))
      return new IdentityUnavailableError(
        "The directory could not be reached.",
        { cause: error }
      );

    // LDAP result 10 is a REFERRAL: "ask that other server instead". Following
    // one would let authentication be answered by a host nobody configured, so
    // it is a refusal rather than a redirect.
    if (error?.code === CODE_REFERRAL)
      return new IdentityAuthenticationError(REFUSED);
    // 13, confidentialityRequired: the server refused an unencrypted bind. That
    // is our configuration to fix, and it is not a credential problem — but it
    // also is not retryable, since retrying changes nothing.
    if (error?.code === CODE_CONFIDENTIALITY)
      return new IdentityConfigurationError(
        "The directory requires an encrypted connection. Configure ldaps:// or StartTLS."
      );
    // 49, invalidCredentials, and everything else: one flat refusal. The
    // original error carries the user's password in some client versions, so it
    // is deliberately NOT attached as a cause.
    return new IdentityAuthenticationError(REFUSED);
  }

  /** Build the principal from the directory entry — never from the input. */
  _normalize(entry) {
    const email = entry?.[this.emailAttribute];
    // linkPrincipal keys on email. Deriving one from the uid would create an
    // account under an address this person may not own.
    if (!email || typeof email !== "string")
      throw new IdentityAuthenticationError(REFUSED);

    const displayName = entry?.[this.displayNameAttribute];

    return {
      provider: LdapIdentityProvider.providerId(),
      // The DN is the subject: it survives a change of uid or mail, which is
      // what makes a returning user the same person rather than a new one.
      subject: String(entry.dn),
      email: String(email).toLowerCase(),
      // The directory asserting an address IS the verification — there is no
      // separate verified flag in LDAP, and the bind just proved the account.
      emailVerified: true,
      displayName: displayName ? String(displayName) : null,
      // ALWAYS empty, deliberately — not "not implemented yet".
      //
      // LDAP group membership is a second query (memberOf, or a reverse search
      // of groupOfNames), and this driver does not make it. Returning [] rather
      // than omitting the field keeps the principal shape identical across all
      // three drivers, so core never has to ask which one produced it.
      //
      // Ruling 5: S4 owns group→role mapping. Populating this before the code
      // that consumes it exists would put a claim in front of core that nothing
      // validates — and groups are observations, never authority (R2).
      groups: [],
      // Deliberately NOT the whole entry: it can carry attributes an operator
      // never meant to export, and the principal is logged and audited.
      claims: { dn: String(entry.dn) },
    };
  }

  async refreshPrincipal() {
    throw new IdentityCapabilityError(
      "Refreshing a principal is not supported by the LDAP driver."
    );
  }

  /** Revocation is idempotent; there is no remote session to end. */
  async revokeSession() {
    return;
  }

  async listPrincipals() {
    throw new IdentityCapabilityError(
      "LDAP driver does not support directory sync (directorySync: false)."
    );
  }

  async listGroups() {
    throw new IdentityCapabilityError(
      "LDAP driver does not support group sync (groupSync: false)."
    );
  }
}

module.exports = { LdapIdentityProvider };

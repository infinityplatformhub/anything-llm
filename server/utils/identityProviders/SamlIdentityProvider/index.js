// S2 (#43): SAML 2.0 driver (Entra and any other SAML IdP), Web Browser SSO.
//
// This class AUTHENTICATES and NORMALIZES. It does not create users, issue
// sessions, grant roles or decide membership (seam 01 §Boundaries) — linkPrincipal
// owns those, so S1 and S2 share one policy instead of two that drift.
//
// The one exception is the replay store: SAML has no PKCE and no nonce, so the
// bearer assertion IS the credential and single use has to be enforced where the
// assertion is parsed. It is a claim against a unique constraint, nothing more.
//
// Two rules run through everything below, both of them learned the hard way:
//
//   1. THE ELEMENT READ MUST BE THE ELEMENT SIGNED. Once the signed assertion is
//      identified, every read is anchored at it with `./`. A `//` read against
//      the document is an XSW hole even when the signature is valid and there is
//      exactly one assertion — a forged element that is not an Assertion slips
//      past all of those guards and wins on document order.
//
//   2. THE ID IS CLAIMED LAST. Every check runs first. Claiming earlier would let
//      anyone burn a victim's assertion ID with XML that never had to verify,
//      and the victim's genuine login would then fail as a replay.

const { SignedXml } = require("xml-crypto");
const { DOMParser } = require("@xmldom/xmldom");
const xpath = require("xpath");

const { AssertionReplay } = require("../../../models/assertionReplay");
const {
  IdentityConfigurationError,
  IdentityAuthenticationError,
  IdentityCapabilityError,
} = require("../errors");

const select = xpath.useNamespaces({
  saml: "urn:oasis:names:tc:SAML:2.0:assertion",
  samlp: "urn:oasis:names:tc:SAML:2.0:protocol",
  ds: "http://www.w3.org/2000/09/xmldsig#",
});

// Clocks disagree; attackers do not need five minutes. Wide enough that a
// correctly configured IdP never trips it, narrow enough that an expired
// assertion is not usefully revivable.
const CLOCK_SKEW_MS = 3 * 60 * 1000;

/** One refusal for every failure. Detail goes to logs, never to the caller. */
const REFUSED = "This login could not be verified.";

/**
 * Read from a VERIFIED assertion, and from nothing else.
 *
 * Techlead ruling: every read after the ID match goes through here. The point is
 * structural — this function closes over no document, so a document-wide read is
 * not something a caller can express, rather than something they are asked not
 * to write. `//foo` passed in still evaluates against `node` as its context, and
 * the leading `./` in every call site says so at a glance.
 *
 * A `//` read against the whole document is an XSW hole even when the signature
 * verifies and there is exactly one assertion: a forged element that is not an
 * Assertion passes every one of those guards and wins on document order.
 */
function readFromAssertion(node, expression) {
  return select(expression, node);
}

/** The same, for expressions that yield a string. */
function readStringFromAssertion(node, expression) {
  return String(select(expression, node) ?? "").trim();
}

class SamlIdentityProvider {
  static providerId() {
    return "saml";
  }

  /** Directory and group sync are S4's; claiming them here would be a lie core acts on. */
  static capabilities() {
    return { directorySync: false, groupSync: false, deltaSync: false };
  }

  /**
   * @param {{entityId:string, idpEntityId:string, ssoUrl:string, acsUrl:string,
   *          certificates:string[]}} config
   */
  constructor(config = {}) {
    const { entityId, idpEntityId, ssoUrl, acsUrl, certificates } = config;
    if (!entityId || !idpEntityId || !ssoUrl || !acsUrl)
      throw new IdentityConfigurationError(
        "SAML provider requires entityId, idpEntityId, ssoUrl and acsUrl."
      );
    // Fail closed. An empty trust list must never read as "accept anything" —
    // that is a driver that verifies nothing while looking configured.
    if (!Array.isArray(certificates) || certificates.length === 0)
      throw new IdentityConfigurationError(
        "SAML provider requires at least one signing certificate."
      );

    this.className = "SamlIdentityProvider";
    this.entityId = entityId;
    this.idpEntityId = idpEntityId;
    this.ssoUrl = ssoUrl;
    this.acsUrl = acsUrl;
    this.certificates = certificates;
  }

  static async validateConnection(config) {
    try {
      const driver = new SamlIdentityProvider(config);
      return { ok: true, details: { entityId: driver.idpEntityId } };
    } catch (error) {
      return { ok: false, details: { error: error.message } };
    }
  }

  /**
   * Where to send the browser to start a login.
   *
   * `stateToken` becomes the request ID the IdP echoes back in InResponseTo,
   * which is what ties an assertion to a login WE started.
   */
  async beginLogin({ stateToken }) {
    if (!stateToken)
      throw new IdentityConfigurationError("beginLogin requires a stateToken.");
    const url = new URL(this.ssoUrl);
    url.searchParams.set("RelayState", stateToken);
    return { authorizationUrl: url.toString(), state: { value: stateToken } };
  }

  /**
   * Verify a SAML Response and return a normalized principal.
   *
   * The order below is the security property, not a style choice:
   *
   *   1. signature verifies against a CONFIGURED certificate
   *   2. the assertion read is the assertion signed
   *   3. conditions, audience and InResponseTo — all read from that assertion
   *   4. only then, claim the ID
   *
   * @param {{samlResponse:string, expectedInResponseTo:string, db?:Object}} input
   * @returns {Promise<Object>} the normalized principal
   */
  async completeLogin({ samlResponse, expectedInResponseTo, db }) {
    if (!samlResponse)
      throw new IdentityAuthenticationError(REFUSED);
    if (!expectedInResponseTo)
      throw new IdentityConfigurationError(
        "completeLogin requires the request ID stored at login."
      );

    const xml = Buffer.from(samlResponse, "base64").toString("utf8");
    const doc = new DOMParser().parseFromString(xml, "text/xml");

    // (1) The signature, against a key from CONFIG.
    const assertion = this._verifiedAssertion(xml, doc);

    // (2)–(3) Everything from here reads `assertion`, never `doc`.
    this._checkIssuer(assertion);
    this._checkConditions(assertion);
    this._checkAudience(assertion);
    this._checkInResponseTo(assertion, expectedInResponseTo);
    this._checkRecipient(assertion);

    // (4) Last. See rule 2 at the top of this file.
    await AssertionReplay.claim({
      provider: SamlIdentityProvider.providerId(),
      assertionId: assertion.getAttribute("ID"),
      expiresAt: this._notOnOrAfter(assertion),
      db,
    });

    return this._normalize(assertion);
  }

  /**
   * The assertion this document's signature actually vouches for.
   *
   * Returns the element, so callers physically cannot read from `doc` by
   * accident — the XSW variants all work by making those two different things.
   */
  _verifiedAssertion(xml, doc) {
    const signatures = select("//ds:Signature", doc);
    // More than one signature means "which one covers what I am about to read?"
    // is ambiguous, and ambiguity here is the attack.
    if (signatures.length !== 1) throw new IdentityAuthenticationError(REFUSED);

    // The key comes from CONFIG, never from the document's own KeyInfo. A
    // self-signed assertion carrying its own certificate is internally
    // consistent — which is exactly the trap, since anyone can make a keypair.
    const signedIds = this._verifyAgainstConfiguredKeys(xml, signatures[0]);
    if (signedIds.length !== 1) throw new IdentityAuthenticationError(REFUSED);

    const assertions = select("//saml:Assertion", doc);
    if (assertions.length !== 1) {
      // NIT-1: a Response with no assertion usually means the IdP REFUSED —
      // account disabled, MFA declined, unknown user — and it says so in Status.
      // That goes to the log, where an operator can act on it, and never to the
      // response, where it would tell an attacker which accounts exist.
      const status = String(
        select("string(//samlp:StatusCode/@Value)", doc) ?? ""
      ).trim();
      if (status)
        console.error(`[identity:saml] provider returned status: ${status}`);
      throw new IdentityAuthenticationError(REFUSED);
    }

    // The heart of it: the element we are about to read must be the element the
    // signature covers.
    if (assertions[0].getAttribute("ID") !== signedIds[0])
      throw new IdentityAuthenticationError(REFUSED);

    return assertions[0];
  }

  /**
   * Try every configured certificate; return the IDs the winning one signed.
   *
   * Every certificate, not the first: an IdP publishes its next certificate
   * before it starts signing with it, and a driver that tried only one would
   * fail every login between the rotation and someone noticing.
   */
  _verifyAgainstConfiguredKeys(xml, signatureNode) {
    for (const certificate of this.certificates) {
      const verifier = new SignedXml({ publicCert: certificate });
      try {
        verifier.loadSignature(signatureNode);
        if (!verifier.checkSignature(xml)) continue;
      } catch {
        continue;
      }
      const references = verifier.getReferences?.() ?? verifier.references ?? [];
      return references
        .map((reference) => String(reference.xpath ?? reference.uri ?? ""))
        // xml-crypto reports a reference either as a bare URI ("#_id") or as the
        // xpath it resolved, which spells the attribute out as
        // `@*[local-name(.)='ID']='_id'`. Take the last quoted value either way.
        .map((value) => {
          const quoted = value.match(/'([^']+)'\s*\]?\s*$/);
          return quoted ? quoted[1] : value.replace(/^#/, "");
        })
        .filter(Boolean);
    }
    throw new IdentityAuthenticationError(REFUSED);
  }

  /**
   * NotBefore/NotOnOrAfter, read from the verified assertion.
   *
   * This and `_checkAudience` carry weight for each other; neither is redundant.
   * Conditions bound WHEN an assertion is usable, audience bounds WHERE. Drop
   * the time check and a captured assertion for this service works forever; drop
   * the audience check and a current assertion for a different service works
   * here. A reviewer removing "the duplicate" opens one of those two holes.
   */
  _checkConditions(assertion) {
    const notBefore = readStringFromAssertion(
      assertion,
      "string(./saml:Conditions/@NotBefore)"
    );
    const notOnOrAfter = this._notOnOrAfter(assertion);
    if (!notOnOrAfter) throw new IdentityAuthenticationError(REFUSED);

    const now = Date.now();
    if (now >= notOnOrAfter.getTime() + CLOCK_SKEW_MS)
      throw new IdentityAuthenticationError(REFUSED);
    if (notBefore && now < new Date(String(notBefore)).getTime() - CLOCK_SKEW_MS)
      throw new IdentityAuthenticationError(REFUSED);
  }

  _notOnOrAfter(assertion) {
    const raw = readStringFromAssertion(
      assertion,
      "string(./saml:Conditions/@NotOnOrAfter)"
    );
    if (!raw) return null;
    const parsed = new Date(String(raw));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  /**
   * The assertion must name US.
   *
   * Without this, an assertion minted for another service behind the same IdP is
   * a valid login here: the signature is genuine, it was simply never for us.
   *
   * Paired with `_checkConditions` (see there): audience bounds WHERE, conditions
   * bound WHEN, and neither substitutes for the other. `_checkRecipient` is a
   * third axis again — where the IdP was told to DELIVER it, which naming us as
   * the audience does not pin down.
   */
  _checkAudience(assertion) {
    const audiences = readFromAssertion(
      assertion,
      "./saml:Conditions/saml:AudienceRestriction/saml:Audience"
    ).map((node) => String(node.textContent).trim());
    if (!audiences.includes(this.entityId))
      throw new IdentityAuthenticationError(REFUSED);
  }

  /** The assertion must answer a login WE started. */
  _checkInResponseTo(assertion, expected) {
    const inResponseTo = readStringFromAssertion(
      assertion,
      "string(./saml:Subject/saml:SubjectConfirmation/saml:SubjectConfirmationData/@InResponseTo)"
    );
    if (String(inResponseTo) !== String(expected))
      throw new IdentityAuthenticationError(REFUSED);
  }

  /**
   * The assertion must come from the provider we think we are talking to.
   *
   * "Some trusted key signed this" is not enough. A trust list holds several
   * certificates during a rotation, and a deployment may configure more than one
   * provider — so without this, any IdP whose certificate we hold could mint
   * assertions in another's name.
   */
  _checkIssuer(assertion) {
    const issuer = readStringFromAssertion(assertion, "string(./saml:Issuer/text())");
    if (issuer !== this.idpEntityId) throw new IdentityAuthenticationError(REFUSED);
  }

  /**
   * The IdP must have been told to deliver this HERE.
   *
   * A third axis beyond audience and conditions: an assertion can name us as its
   * audience, be perfectly in date, and still have been aimed at a different
   * endpoint — intercepted in transit to another SP, or one the IdP was induced
   * to send elsewhere.
   *
   * Read from INSIDE the signed assertion, which is what makes it worth
   * trusting. The Response's own `@Destination` sits outside the signature: fine
   * for a fast refusal, never something a decision may rest on.
   */
  _checkRecipient(assertion) {
    const recipient = readStringFromAssertion(
      assertion,
      "string(./saml:Subject/saml:SubjectConfirmation/saml:SubjectConfirmationData/@Recipient)"
    );
    if (recipient !== this.acsUrl) throw new IdentityAuthenticationError(REFUSED);
  }

  /** Read the principal — again, only from the verified assertion. */
  _normalize(assertion) {
    const nameId = readStringFromAssertion(
      assertion,
      "string(./saml:Subject/saml:NameID/text())"
    );
    if (!nameId) throw new IdentityAuthenticationError(REFUSED);

    const displayName = readStringFromAssertion(
      assertion,
      "string(./saml:AttributeStatement/saml:Attribute[@Name='displayName']/saml:AttributeValue/text())"
    );

    return {
      provider: SamlIdentityProvider.providerId(),
      // NameID is the subject. SAML has no separate `sub`, and using the email
      // instead would mean a changed address became a different person.
      subject: nameId,
      email: nameId.toLowerCase(),
      // SAML has no email_verified claim: the IdP asserting an address IS the
      // verification, which is what the signature just established.
      emailVerified: true,
      displayName: displayName || null,
      // Observations, never authority. R2 keeps role assignment out of drivers
      // entirely and S4 owns group→role mapping.
      groups: readFromAssertion(
        assertion,
        "./saml:AttributeStatement/saml:Attribute[@Name='groups']/saml:AttributeValue"
      ).map((node) => String(node.textContent)),
      claims: { nameId },
    };
  }

  async refreshPrincipal() {
    throw new IdentityCapabilityError(
      "Refreshing a principal is not supported by the SAML driver."
    );
  }

  /** Revocation is idempotent; an unknown remote session succeeds (seam §Failure semantics). */
  async revokeSession() {
    return;
  }

  async listPrincipals() {
    throw new IdentityCapabilityError(
      "SAML driver does not support directory sync (directorySync: false)."
    );
  }

  async listGroups() {
    throw new IdentityCapabilityError(
      "SAML driver does not support group sync (groupSync: false)."
    );
  }
}

module.exports = { SamlIdentityProvider };

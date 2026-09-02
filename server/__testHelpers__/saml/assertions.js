// S2 (#43): SAML assertion fixtures — written BEFORE any library is chosen.
//
// Recon §5 makes these the SELECTION CRITERION: pick the library that refuses
// them, rather than picking one and validating it afterwards. XML Signature
// Wrapping is the attack SAML libraries exist to prevent and hand-rolled
// parsers fail, so a library that accepts any of the XSW variants below is
// disqualified regardless of how popular it is.
//
// Every fixture is generated, not pasted: the signing key is made per-run, so a
// verifier that "passes" by skipping signature checks cannot pass here.

const crypto = require("crypto");
const { SignedXml } = require("xml-crypto");

const config = require("../identity/urls.json");

const IDP_ENTITY_ID = `${config.idpOrigin}/saml`;
const SP_ENTITY_ID = `${config.appOrigin}/saml/metadata`;
const ACS_URL = `${config.appOrigin}/api/sso/saml/acs`;

/** A self-signed IdP certificate, generated per run. */
function makeIdpKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

/**
 * The assertion element. Everything an IdP asserts about a person lives here,
 * and it is the element a signature is supposed to cover.
 */
function assertionXml({
  assertionId = `_assert-${crypto.randomBytes(8).toString("hex")}`,
  nameId = "person@example.com",
  inResponseTo = "_req-1",
  notBefore = iso(-60_000),
  notOnOrAfter = iso(5 * 60_000),
  audience = SP_ENTITY_ID,
  issuer = IDP_ENTITY_ID,
} = {}) {
  return `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" IssueInstant="${iso()}" Version="2.0">
  <saml:Issuer>${issuer}</saml:Issuer>
  <saml:Subject>
    <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>
    <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
      <saml:SubjectConfirmationData InResponseTo="${inResponseTo}" NotOnOrAfter="${notOnOrAfter}" Recipient="${ACS_URL}"/>
    </saml:SubjectConfirmation>
  </saml:Subject>
  <saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">
    <saml:AudienceRestriction>
      <saml:Audience>${audience}</saml:Audience>
    </saml:AudienceRestriction>
  </saml:Conditions>
  <saml:AttributeStatement>
    <saml:Attribute Name="email">
      <saml:AttributeValue>${nameId}</saml:AttributeValue>
    </saml:Attribute>
  </saml:AttributeStatement>
</saml:Assertion>`;
}

function responseXml(inner, { responseId = `_resp-${crypto.randomBytes(8).toString("hex")}`, inResponseTo = "_req-1" } = {}) {
  return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" InResponseTo="${inResponseTo}" IssueInstant="${iso()}" Destination="${ACS_URL}" Version="2.0">
  <saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
  ${inner}
</samlp:Response>`;
}

/** Sign one element, referenced by its ID, the way a real IdP would. */
function sign(xml, privateKeyPem, { referenceId, publicKeyPem }) {
  const signer = new SignedXml({ privateKey: privateKeyPem });
  signer.addReference({
    xpath: `//*[@ID='${referenceId}']`,
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  signer.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  signer.canonicalizationAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
  if (publicKeyPem)
    signer.getKeyInfoContent = () => `<X509Data><X509Certificate>${publicKeyPem
      .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "")
      .replace(/\s/g, "")}</X509Certificate></X509Data>`;
  signer.computeSignature(xml, {
    location: { reference: `//*[@ID='${referenceId}']`, action: "append" },
  });
  return signer.getSignedXml();
}

const fixtures = {
  IDP_ENTITY_ID,
  SP_ENTITY_ID,
  ACS_URL,
  makeIdpKeypair,
  assertionXml,
  responseXml,

  /** The happy path: one assertion, signed by the IdP key we trust. */
  valid({ privateKeyPem, publicKeyPem, ...options } = {}) {
    const assertionId = `_assert-${crypto.randomBytes(8).toString("hex")}`;
    const assertion = assertionXml({ assertionId, ...options });
    const signed = sign(assertion, privateKeyPem, {
      referenceId: assertionId,
      publicKeyPem,
    });
    return { xml: responseXml(signed, options), assertionId };
  },

  /**
   * DoD 1 — no signature at all.
   *
   * The single most common SAML vulnerability: the contents look right, so a
   * verifier that only reads them accepts a login anyone can forge with a text
   * editor.
   */
  unsigned(options = {}) {
    const assertionId = `_assert-${crypto.randomBytes(8).toString("hex")}`;
    return {
      xml: responseXml(assertionXml({ assertionId, ...options }), options),
      assertionId,
    };
  },

  /** DoD 2 — a real signature, from a key that is not the configured IdP's. */
  wrongKey(options = {}) {
    const attacker = makeIdpKeypair();
    return fixtures.valid({
      privateKeyPem: attacker.privateKeyPem,
      publicKeyPem: attacker.publicKeyPem,
      ...options,
    });
  },

  /**
   * DoD 3a — XSW: signed assertion moved into an unsigned wrapper.
   *
   * The Response carries a forged assertion at the position a reader looks at,
   * with the genuinely signed one buried inside it. A verifier that validates
   * "some signature in this document" and then reads "the first assertion"
   * validates one element and trusts a different one.
   */
  xswWrapped({ privateKeyPem, publicKeyPem, forgedNameId = "attacker@example.com" } = {}) {
    const realId = `_assert-${crypto.randomBytes(8).toString("hex")}`;
    const realAssertion = assertionXml({ assertionId: realId });
    const signedReal = sign(realAssertion, privateKeyPem, {
      referenceId: realId,
      publicKeyPem,
    });

    const forgedId = `_assert-${crypto.randomBytes(8).toString("hex")}`;
    // The forged assertion ENCLOSES the signed one. Both are present; only one
    // is covered by the signature.
    const forged = assertionXml({ assertionId: forgedId, nameId: forgedNameId })
      .replace("</saml:Assertion>", `${signedReal}</saml:Assertion>`);
    return { xml: responseXml(forged), assertionId: forgedId, forgedNameId };
  },

  /**
   * DoD 3b — XSW: signed assertion kept intact, forged sibling added first.
   *
   * A different shape of the same attack. Here the signature still references a
   * valid, untouched subtree, but a second unsigned assertion sits ahead of it
   * in document order — so "the first Assertion" and "the signed Assertion" are
   * different elements.
   */
  xswSibling({ privateKeyPem, publicKeyPem, forgedNameId = "attacker@example.com" } = {}) {
    const realId = `_assert-${crypto.randomBytes(8).toString("hex")}`;
    const signedReal = sign(assertionXml({ assertionId: realId }), privateKeyPem, {
      referenceId: realId,
      publicKeyPem,
    });
    const forgedId = `_assert-${crypto.randomBytes(8).toString("hex")}`;
    const forged = assertionXml({ assertionId: forgedId, nameId: forgedNameId });
    return {
      xml: responseXml(`${forged}${signedReal}`),
      assertionId: forgedId,
      forgedNameId,
    };
  },

  /**
   * DoD 3c — XSW: the signed assertion is hidden where a signature can still
   * find it but a reader will not (inside an Extensions element), while the
   * forged one takes its place.
   */
  xswHidden({ privateKeyPem, publicKeyPem, forgedNameId = "attacker@example.com" } = {}) {
    const realId = `_assert-${crypto.randomBytes(8).toString("hex")}`;
    const signedReal = sign(assertionXml({ assertionId: realId }), privateKeyPem, {
      referenceId: realId,
      publicKeyPem,
    });
    const forgedId = `_assert-${crypto.randomBytes(8).toString("hex")}`;
    const forged = assertionXml({ assertionId: forgedId, nameId: forgedNameId });
    return {
      xml: responseXml(
        `<samlp:Extensions>${signedReal}</samlp:Extensions>${forged}`
      ),
      assertionId: forgedId,
      forgedNameId,
    };
  },

  /**
   * DoD 3d — XSW: the wrapper is not an Assertion at all.
   *
   * Techlead FINDING-1. Every guard so far asks about ASSERTIONS: one signature,
   * one assertion, and the assertion read is the one signed. A forged
   * `<saml:Subject>` sitting loose in `<samlp:Extensions>` satisfies all three —
   * there is still exactly one assertion, and it is genuinely signed — while a
   * document-wide `//saml:Subject` read picks the attacker's up first, because
   * it comes earlier in document order.
   *
   * The lesson generalizes past NameID: once the signed assertion is
   * identified, every subsequent read must be relative to THAT element.
   * Conditions, AudienceRestriction, InResponseTo and the AttributeStatement are
   * all forgeable this way.
   */
  xswUnwrappedSubject({ privateKeyPem, publicKeyPem, forgedNameId = "attacker@example.com" } = {}) {
    const realId = `_assert-${crypto.randomBytes(8).toString("hex")}`;
    const signedReal = sign(assertionXml({ assertionId: realId }), privateKeyPem, {
      referenceId: realId,
      publicKeyPem,
    });
    // A bare Subject, belonging to no assertion, placed ahead of the real one.
    const forgedSubject = `<saml:Subject xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${forgedNameId}</saml:NameID></saml:Subject>`;
    return {
      xml: responseXml(
        `<samlp:Extensions>${forgedSubject}</samlp:Extensions>${signedReal}`
      ),
      assertionId: realId,
      forgedNameId,
    };
  },

  /**
   * DoD 2b — SAML's alg-confusion: a self-signed assertion carrying its own
   * certificate in KeyInfo.
   *
   * The XML is internally consistent — the signature verifies against the key
   * the document itself supplies — which is exactly the trap. A verifier that
   * takes its key from KeyInfo is asking the assertion to vouch for itself, and
   * anyone can generate a keypair. The key must come from configuration.
   */
  selfSignedWithKeyInfo(options = {}) {
    const attacker = makeIdpKeypair();
    return {
      ...fixtures.valid({
        privateKeyPem: attacker.privateKeyPem,
        publicKeyPem: attacker.publicKeyPem,
        ...options,
      }),
      attackerPublicKeyPem: attacker.publicKeyPem,
    };
  },

  /** DoD 4 — NotOnOrAfter already passed. */
  expired(options = {}) {
    return fixtures.valid({
      ...options,
      notBefore: iso(-10 * 60_000),
      notOnOrAfter: iso(-5 * 60_000),
    });
  },

  /** DoD 5 — NotBefore in the future, beyond any sane clock skew. */
  notYetValid(options = {}) {
    return fixtures.valid({
      ...options,
      notBefore: iso(10 * 60_000),
      notOnOrAfter: iso(20 * 60_000),
    });
  },

  /** DoD 6 — AudienceRestriction naming somebody else. */
  wrongAudience(options = {}) {
    return fixtures.valid({ ...options, audience: `${config.hostileOrigin}/saml` });
  },

  /** DoD 8 — InResponseTo answering a request we never sent. */
  wrongInResponseTo(options = {}) {
    return fixtures.valid({ ...options, inResponseTo: "_someone-elses-request" });
  },
};

module.exports = fixtures;

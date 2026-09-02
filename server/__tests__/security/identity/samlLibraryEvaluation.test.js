// S2 (#43) §5 — the library SELECTION test, written before a library is chosen.
//
// Recon §5: "write the XSW fixtures first, then pick the library that fails them
// correctly. A library chosen by popularity and validated afterwards is the same
// work in the wrong order."
//
// So this file is not a test of our driver. It is the evidence for a decision:
// it points a candidate verifier at each forgery and records what it does. A
// candidate that accepts any XSW variant is disqualified — that is the whole
// reason not to hand-roll XML-DSig, and a library that fails here would leave us
// hand-rolling anyway without knowing it.

const crypto = require("crypto");
const { SignedXml } = require("xml-crypto");
const { DOMParser } = require("@xmldom/xmldom");
const xpath = require("xpath");

const fixtures = require("../../../__testHelpers__/saml/assertions");

const select = xpath.useNamespaces({
  saml: "urn:oasis:names:tc:SAML:2.0:assertion",
  samlp: "urn:oasis:names:tc:SAML:2.0:protocol",
  ds: "http://www.w3.org/2000/09/xmldsig#",
});

let idp;
beforeAll(() => {
  idp = fixtures.makeIdpKeypair();
});

/**
 * The candidate verifier, in the shape S2's driver will use it.
 *
 * Returns the NameID it is willing to vouch for, or throws. The rule it
 * enforces — and the rule every XSW variant is designed to break — is that the
 * element whose contents we READ must be the same element the signature
 * COVERS. Everything else here is bookkeeping.
 */
function verifyAndExtract(xml, publicKeyPem) {
  const doc = new DOMParser().parseFromString(xml, "text/xml");

  const signatures = select("//ds:Signature", doc);
  if (signatures.length !== 1)
    throw new Error(`expected exactly one signature, found ${signatures.length}`);

  const verifier = new SignedXml({ publicCert: publicKeyPem });
  verifier.loadSignature(signatures[0]);
  if (!verifier.checkSignature(xml))
    throw new Error(`signature invalid: ${verifier.validationErrors?.join("; ")}`);

  // WHICH element did that signature actually cover? xml-crypto records the
  // references it verified; anything outside them is unsigned data that merely
  // shares a document with a valid signature.
  const references = verifier.getReferences?.() ?? verifier.references ?? [];
  const signedIds = references
    .map((reference) => String(reference.xpath ?? reference.uri ?? ""))
    // xml-crypto reports a reference either as a bare URI ("#_id") or as the
    // resolved xpath it matched, which spells the attribute out as
    // `@*[local-name(.)='ID']='_id'`. Take the last quoted value in either case.
    .map((value) => {
      const quoted = value.match(/'([^']+)'\s*\]?\s*$/);
      if (quoted) return quoted[1];
      return value.replace(/^#/, "");
    })
    .filter(Boolean);
  if (signedIds.length !== 1)
    throw new Error(`expected one signed reference, found ${signedIds.length}`);

  const assertions = select("//saml:Assertion", doc);
  if (assertions.length !== 1)
    throw new Error(`expected exactly one assertion, found ${assertions.length}`);

  const assertionId = assertions[0].getAttribute("ID");
  if (assertionId !== signedIds[0])
    throw new Error(
      `the assertion read (${assertionId}) is not the one signed (${signedIds[0]})`
    );

  // Techlead FINDING-1: past this point `doc` is off limits. The signed
  // assertion has been identified, so every read is relative to THAT element —
  // `./`, anchored at assertions[0], never `//` against the document.
  //
  // A document-wide read is an XSW hole even when all three guards above pass: a
  // forged `<saml:Subject>` loose in `<samlp:Extensions>` is not an assertion, so
  // the assertion count is still one and it is still the one signed, but `//`
  // finds the attacker's Subject first on document order. The same applies to
  // every other field the driver will read — Conditions, AudienceRestriction,
  // InResponseTo, AttributeStatement.
  const nameId = select("string(./saml:Subject/saml:NameID/text())", assertions[0]);
  if (!nameId) throw new Error("no NameID");
  return String(nameId);
}

describe("SAML library evaluation — xml-crypto as the candidate (recon §5)", () => {
  test("baseline: a correctly signed assertion verifies and yields its NameID", async () => {
    // If this failed, every rejection below would be meaningless — a verifier
    // that refuses everything is not secure, it is broken.
    const { xml } = fixtures.valid({
      privateKeyPem: idp.privateKeyPem,
      publicKeyPem: idp.publicKeyPem,
    });
    expect(verifyAndExtract(xml, idp.publicKeyPem)).toBe("person@example.com");
  });

  test("DoD 1: an unsigned assertion is refused", () => {
    const { xml } = fixtures.unsigned();
    expect(() => verifyAndExtract(xml, idp.publicKeyPem)).toThrow();
  });

  test("DoD 2: an assertion signed by the wrong key is refused", () => {
    const { xml } = fixtures.wrongKey();
    expect(() => verifyAndExtract(xml, idp.publicKeyPem)).toThrow();
  });

  test("DoD 3a: XSW — signed assertion wrapped inside a forged one is refused", () => {
    const { xml, forgedNameId } = fixtures.xswWrapped({
      privateKeyPem: idp.privateKeyPem,
      publicKeyPem: idp.publicKeyPem,
    });
    let vouched = null;
    try {
      vouched = verifyAndExtract(xml, idp.publicKeyPem);
    } catch {
      vouched = null;
    }
    // The specific failure that matters: it must never vouch for the attacker's
    // NameID. Refusing outright is the expected outcome; returning the genuine
    // NameID would also be safe, but returning the forged one is the breach.
    expect(vouched).not.toBe(forgedNameId);
    expect(vouched).toBeNull();
  });

  test("DoD 3b: XSW — a forged sibling ahead of the signed assertion is refused", () => {
    const { xml, forgedNameId } = fixtures.xswSibling({
      privateKeyPem: idp.privateKeyPem,
      publicKeyPem: idp.publicKeyPem,
    });
    let vouched = null;
    try {
      vouched = verifyAndExtract(xml, idp.publicKeyPem);
    } catch {
      vouched = null;
    }
    expect(vouched).not.toBe(forgedNameId);
    expect(vouched).toBeNull();
  });

  test("DoD 3c: XSW — the signed assertion hidden in Extensions is refused", () => {
    const { xml, forgedNameId } = fixtures.xswHidden({
      privateKeyPem: idp.privateKeyPem,
      publicKeyPem: idp.publicKeyPem,
    });
    let vouched = null;
    try {
      vouched = verifyAndExtract(xml, idp.publicKeyPem);
    } catch {
      vouched = null;
    }
    expect(vouched).not.toBe(forgedNameId);
    expect(vouched).toBeNull();
  });

  test("DoD 3d: XSW — a forged Subject OUTSIDE any assertion is refused", () => {
    // Techlead FINDING-1. This forgery passes every assertion-level guard: one
    // signature, one assertion, and the assertion read IS the one signed. The
    // hole was that the NameID was then read document-wide, so a bare Subject
    // in Extensions won on document order.
    const { xml, forgedNameId } = fixtures.xswUnwrappedSubject({
      privateKeyPem: idp.privateKeyPem,
      publicKeyPem: idp.publicKeyPem,
    });
    let vouched = null;
    try {
      vouched = verifyAndExtract(xml, idp.publicKeyPem);
    } catch {
      vouched = null;
    }
    // Here the safe outcomes differ from the other XSW cases: the signed
    // assertion is intact and legitimate, so returning ITS NameID is correct.
    // Returning the attacker's is the breach.
    expect(vouched).not.toBe(forgedNameId);
    expect(vouched).toBe("person@example.com");
  });

  test("DoD 2b: a key from the assertion's own KeyInfo is never trusted", () => {
    // SAML's alg-confusion. The document is internally consistent — it carries
    // the certificate its signature verifies against — so a verifier that reads
    // its key from KeyInfo is asking the assertion to vouch for itself, and
    // anyone can generate a keypair. The key comes from configuration.
    const { xml, attackerPublicKeyPem } = fixtures.selfSignedWithKeyInfo();

    // Against the CONFIGURED key: refused, as it must be.
    expect(() => verifyAndExtract(xml, idp.publicKeyPem)).toThrow();

    // And the proof that it is a real forgery rather than malformed XML: it
    // verifies perfectly against the key it brought with it. That is precisely
    // what makes trusting KeyInfo fatal.
    expect(verifyAndExtract(xml, attackerPublicKeyPem)).toBe("person@example.com");
  });

  test("a tampered assertion body invalidates the signature", () => {
    // The ordinary case the digest exists for: change one character of signed
    // content and the reference digest stops matching.
    const { xml } = fixtures.valid({
      privateKeyPem: idp.privateKeyPem,
      publicKeyPem: idp.publicKeyPem,
    });
    const tampered = xml.replace("person@example.com", "attacker@example.com");
    expect(() => verifyAndExtract(tampered, idp.publicKeyPem)).toThrow();
  });
});

// S2 (#43) — SamlIdentityProvider, against the XSW fixtures written first.
//
// RED-first: written before the driver exists.
//
// The driver AUTHENTICATES and NORMALIZES. It never creates a user, issues a
// session or assigns a role (seam 01 §Boundaries) — linkPrincipal owns those, so
// S1 and S2 share one policy. If this file ever needs `prisma` for anything but
// the replay store, the boundary has been crossed.
//
// Two properties get most of the attention here:
//
//   1. Every read after the ID match is anchored at the VERIFIED assertion
//      (Techlead FINDING-1). A document-wide read is an XSW hole even when the
//      signature and the assertion count are both correct.
//
//   2. The assertion ID is claimed LAST. Claiming before the checks lets anyone
//      burn a victim's assertion ID with XML that never had to verify.

const { execSync } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");
const fixtures = require("../../../__testHelpers__/saml/assertions");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");

const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `s2_driver_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;
let SamlIdentityProvider;
let idp;
const {
  IdentityAuthenticationError,
  IdentityConfigurationError,
  IdentityCapabilityError,
} = require("../../../utils/identityProviders/errors");

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
    throw new Error("S2 integration tests require DATABASE_URL pointing at PostgreSQL");
  const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${testDb}"`);
  await admin.$disconnect();
  execSync(`npx prisma migrate deploy --schema ${SCHEMA}`, {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
  ({
    SamlIdentityProvider,
  } = require("../../../utils/identityProviders/SamlIdentityProvider"));
  idp = fixtures.makeIdpKeypair();
}, 300_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60_000);

/** A driver configured to trust exactly the fixture IdP's key. */
function driver(overrides = {}) {
  return new SamlIdentityProvider({
    entityId: fixtures.SP_ENTITY_ID,
    idpEntityId: fixtures.IDP_ENTITY_ID,
    ssoUrl: `${fixtures.IDP_ENTITY_ID}/sso`,
    acsUrl: fixtures.ACS_URL,
    certificates: [idp.publicKeyPem],
    ...overrides,
  });
}

const signed = (kind = "valid", options = {}) =>
  fixtures[kind]({
    privateKeyPem: idp.privateKeyPem,
    publicKeyPem: idp.publicKeyPem,
    ...options,
  });

const complete = (xml, opts = {}) =>
  driver(opts.config).completeLogin({
    samlResponse: Buffer.from(xml).toString("base64"),
    expectedInResponseTo: opts.inResponseTo ?? "_req-1",
    db: prisma,
  });

describe("configuration", () => {
  test("a driver with no certificates refuses to be built", () => {
    // Fail closed. A driver with an empty trust list would verify nothing, and
    // "no certificate configured" must not read as "accept anything".
    expect(() => driver({ certificates: [] })).toThrow(IdentityConfigurationError);
  });

  test("providerId is saml, and directory sync is not claimed", () => {
    expect(SamlIdentityProvider.providerId()).toBe("saml");
    // R2/S4: advertising a capability the driver does not have is a lie core
    // would act on.
    expect(SamlIdentityProvider.capabilities().directorySync).toBe(false);
  });
});

describe("completeLogin — the happy path", () => {
  test("a correctly signed assertion yields a normalized principal", async () => {
    // If this failed, every rejection below would prove nothing: a driver that
    // refuses everything is broken, not secure.
    const { xml } = signed();
    const principal = await complete(xml);

    expect(principal.provider).toBe("saml");
    expect(principal.email).toBe("person@example.com");
    expect(principal.subject).toBeTruthy();
    // The IdP asserted this address; SAML has no separate email_verified claim,
    // and an IdP asserting an address IS the verification.
    expect(principal.emailVerified).toBe(true);
  });

  test("the same assertion cannot be presented twice", async () => {
    const { xml } = signed();
    await complete(xml);
    // The replay. Everything about it is valid — that is why single use is the
    // only defence SAML has here.
    await expect(complete(xml)).rejects.toThrow(IdentityAuthenticationError);
  });
});

describe("signature and key handling", () => {
  test("an unsigned assertion is refused", async () => {
    await expect(complete(fixtures.unsigned().xml)).rejects.toThrow(
      IdentityAuthenticationError
    );
  });

  test("an assertion signed by a key we do not trust is refused", async () => {
    await expect(complete(fixtures.wrongKey().xml)).rejects.toThrow(
      IdentityAuthenticationError
    );
  });

  test("the key comes from CONFIG, never from the assertion's own KeyInfo", async () => {
    // SAML's alg-confusion. This document verifies perfectly against the
    // certificate it carries, so a driver reading KeyInfo is asking the
    // assertion to vouch for itself — and anyone can generate a keypair.
    const { xml } = fixtures.selfSignedWithKeyInfo();
    await expect(complete(xml)).rejects.toThrow(IdentityAuthenticationError);
  });

  test("a rotated certificate is accepted while the old one is still listed", async () => {
    // Entra publishes the next certificate before signing with it. A driver that
    // trusted only one would fail every login between the rotation and an
    // operator noticing.
    const stale = fixtures.makeIdpKeypair();
    const { xml } = signed();
    const principal = await driver({
      certificates: [stale.publicKeyPem, idp.publicKeyPem],
    }).completeLogin({
      samlResponse: Buffer.from(xml).toString("base64"),
      expectedInResponseTo: "_req-1",
      db: prisma,
    });
    expect(principal.email).toBe("person@example.com");
  });
});

describe("XSW — the element read must be the element signed", () => {
  test("a signed assertion wrapped inside a forged one is refused", async () => {
    const { xml } = signed("xswWrapped");
    await expect(complete(xml)).rejects.toThrow(IdentityAuthenticationError);
  });

  test("a forged sibling ahead of the signed assertion is refused", async () => {
    const { xml } = signed("xswSibling");
    await expect(complete(xml)).rejects.toThrow(IdentityAuthenticationError);
  });

  test("the signed assertion hidden in Extensions is refused", async () => {
    const { xml } = signed("xswHidden");
    await expect(complete(xml)).rejects.toThrow(IdentityAuthenticationError);
  });

  test("FINDING-1: a forged Subject OUTSIDE any assertion never becomes the principal", async () => {
    // Passes every assertion-level guard — one signature, one assertion, and the
    // assertion read IS the one signed — because a bare Subject is not an
    // Assertion. Only anchoring the read at the verified element stops it.
    const { xml, forgedNameId } = signed("xswUnwrappedSubject");
    const principal = await complete(xml).catch(() => null);
    expect(principal?.email).not.toBe(forgedNameId);
    expect(principal?.email).toBe("person@example.com");
  });
});

describe("XSW generalized — every checked field, not just NameID", () => {
  // Techlead ruling: NameID was never the only forgeable read. Each of these
  // plants a bare, valid-looking element in Extensions ahead of an assertion
  // that genuinely fails that same check. A document-wide read finds the
  // attacker's copy first; anchoring at the verified assertion does not.

  test("a planted Conditions does not revive an EXPIRED assertion", async () => {
    const { xml } = signed("xswUnwrappedConditions");
    await expect(complete(xml)).rejects.toThrow(IdentityAuthenticationError);
  });

  test("a planted AudienceRestriction does not claim an assertion meant for someone else", async () => {
    // The cross-service attack: an assertion the IdP genuinely issued for
    // another application, dressed up as one for us.
    const { xml } = signed("xswUnwrappedAudience");
    await expect(complete(xml)).rejects.toThrow(IdentityAuthenticationError);
  });

  test("a planted SubjectConfirmationData does not satisfy InResponseTo", async () => {
    // Otherwise any captured assertion answers whatever login the victim is
    // currently attempting.
    const { xml } = signed("xswUnwrappedInResponseTo");
    await expect(complete(xml)).rejects.toThrow(IdentityAuthenticationError);
  });
});

describe("conditions", () => {
  test("an expired assertion is refused", async () => {
    await expect(complete(signed("expired").xml)).rejects.toThrow(
      IdentityAuthenticationError
    );
  });

  test("an assertion not yet valid is refused", async () => {
    await expect(complete(signed("notYetValid").xml)).rejects.toThrow(
      IdentityAuthenticationError
    );
  });

  test("an assertion for a different audience is refused", async () => {
    // Without this, an assertion minted for ANOTHER service protected by the
    // same IdP is a valid login here — the signature is genuine, it was simply
    // never meant for us.
    await expect(complete(signed("wrongAudience").xml)).rejects.toThrow(
      IdentityAuthenticationError
    );
  });

  test("an assertion answering a request we never sent is refused", async () => {
    await expect(complete(signed("wrongInResponseTo").xml)).rejects.toThrow(
      IdentityAuthenticationError
    );
  });
});

describe("PMO ruling: the assertion ID is claimed LAST", () => {
  const countRows = () => prisma.identity_assertion_ids.count();

  test("a signature failure records NOTHING", async () => {
    // Claiming before verification lets anyone burn a victim's assertion ID with
    // XML that never had to verify: the victim's real login then fails as a
    // replay, and mounting it costs an attacker nothing.
    const before = await countRows();
    await complete(fixtures.wrongKey().xml).catch(() => null);
    expect(await countRows()).toBe(before);
  });

  test("an EXPIRED assertion records nothing", async () => {
    // Signature-first is not sufficient on its own. This one verifies — an
    // attacker who captured a genuine expired assertion could still burn its ID
    // if the claim ran before the Conditions check.
    const before = await countRows();
    await complete(signed("expired").xml).catch(() => null);
    expect(await countRows()).toBe(before);
  });

  test("a WRONG-AUDIENCE assertion records nothing", async () => {
    // Same shape: genuinely signed, simply not for us.
    const before = await countRows();
    await complete(signed("wrongAudience").xml).catch(() => null);
    expect(await countRows()).toBe(before);
  });

  test("an attacker cannot BURN a victim's assertion ID before they use it", async () => {
    // The ruling stated as the attack it prevents. An assertion ID is not a
    // secret — it leaks through logs, proxies, browser history. If the claim ran
    // before verification, anyone who learned an ID could pre-register it with
    // XML that never had to verify, and the victim's genuine login would then be
    // refused as a replay: a denial-of-service costing the attacker nothing.
    const { xml, assertionId } = signed();

    // The attacker's attempt: the victim's real ID, a signature that is not the
    // IdP's. Refused, and it must leave nothing behind.
    const attacker = fixtures.wrongKey({ assertionId });
    await complete(attacker.xml).catch(() => null);

    // The victim's genuine login, arriving afterwards. It must still work.
    const principal = await complete(xml);
    expect(principal.email).toBe("person@example.com");
  });

  test("a SUCCESSFUL login does record the ID", async () => {
    // The counterweight: without this, "record nothing" is satisfied by a driver
    // that never records at all, and the replay defence would be gone.
    const before = await countRows();
    await complete(signed().xml);
    expect(await countRows()).toBe(before + 1);
  });
});

describe("boundaries (seam 01)", () => {
  test("the driver does not support directory sync", async () => {
    await expect(driver().listPrincipals()).rejects.toThrow(IdentityCapabilityError);
  });

  test("completeLogin returns a principal — it never creates a user", async () => {
    const { xml } = signed();
    const principal = await complete(xml);
    // No id, no role, no session: those are linkPrincipal's, and a driver that
    // returned them would be the second implementation of a policy that must
    // have exactly one.
    expect(principal.id).toBeUndefined();
    expect(principal.role).toBeUndefined();
    expect(principal.token).toBeUndefined();
  });
});

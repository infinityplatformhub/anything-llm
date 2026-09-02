// S2 (#43) — the SAML routes over the real HTTP stack.
//
// RED-first: written before the routes exist.
//
// Boots the actual Express app against a real Postgres schema, so what is
// asserted is what a browser would get. A unit test of the handler would not
// catch a route that was never mounted, which is half the point — and for the
// ACS route it would not catch a missing rate limiter either.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "approof-s2-"));
const schema = `s2_routes_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.API_KEY_PEPPER = "s2-routes-test-pepper-32-bytes-long";
process.env.STORAGE_DIR = path.join(tempDir, "storage");
// A small limit so the rate-limit test proves the limiter is MOUNTED without
// sending 30+ requests. The number is configuration; the presence is the
// property under test.
process.env.INVITE_RATE_LIMIT_MAX = "5";
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
  throw new Error("DATABASE_URL must point to PostgreSQL for S2 route tests");
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set("schema", schema);
process.env.DATABASE_URL = databaseUrl.toString();
fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });
fs.mkdirSync(path.resolve(__dirname, "../../../../collector/hotdir"), {
  recursive: true,
});

const fixtures = require("../../../__testHelpers__/saml/assertions");
const idp = fixtures.makeIdpKeypair();

// SAML configuration the routes read.
process.env.SSO_SAML_ENABLED = "true";
process.env.SSO_SAML_ENTITY_ID = fixtures.SP_ENTITY_ID;
process.env.SSO_SAML_IDP_ENTITY_ID = fixtures.IDP_ENTITY_ID;
process.env.SSO_SAML_SSO_URL = `${fixtures.IDP_ENTITY_ID}/sso`;
process.env.SSO_SAML_CERTIFICATE = idp.publicKeyPem;
// The ACS URL the IdP was configured to deliver to, and the value the signed
// assertion's Recipient is checked against. Configured explicitly rather than
// derived from the request's Host header, which the caller controls — otherwise
// the check would agree with the attacker instead of with the IdP.
process.env.SSO_ACS_URL = fixtures.ACS_URL;

const testSchema = path.resolve(__dirname, "../../../prisma/schema.prisma");
execFileSync(
  path.resolve(__dirname, "../../../node_modules/.bin/prisma"),
  ["migrate", "deploy", "--schema", testSchema],
  { cwd: path.resolve(__dirname, "../../.."), env: process.env, stdio: "ignore" }
);

jest.mock("../../../utils/logger", () => () => {});
jest.mock("../../../utils/boot", () => ({ bootHTTP: jest.fn(), bootSSL: jest.fn() }));
jest.mock("../../../utils/boot/patchSdkTimeouts", () => jest.fn());
jest.mock("../../../utils/helpers/modelPricing", () => ({
  addChatCostToMetrics: jest.fn((metrics) => metrics),
}));
jest.mock("../../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn(), flush: jest.fn() },
}));
jest.mock("../../../utils/boot/MetaGenerator", () => ({
  MetaGenerator: jest.fn().mockImplementation(() => ({
    generate: jest.fn(),
    generateManifest: jest.fn(),
  })),
}));

const JWT = require("jsonwebtoken");
const { CommunicationKey } = require("../../../utils/comKey");
new CommunicationKey(true);

const request = require("supertest");
const prisma = require("../../../utils/prisma");
const { app } = require("../../../index");
const {
  resetRequestControls,
} = require("../../../utils/middleware/requestControls");

beforeEach(async () => {
  await resetRequestControls();
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
  // issue 77: hand the environment back — the limit is read per request now, so
  // a leftover value is one another suite's limiters would read. Jest isolates
  // the module registry per file, not `process.env`.
  delete process.env.INVITE_RATE_LIMIT_MAX;
});

/** Start a login and return the request ID the IdP is expected to echo. */
async function beginLogin() {
  const start = await request(app).get("/api/sso/saml/login");
  const location = new URL(start.headers.location);
  return location.searchParams.get("RelayState");
}

const encode = (xml) => Buffer.from(xml).toString("base64");

/** A signed assertion answering the given request id. */
function assertionFor(requestId, kind = "valid", options = {}) {
  return fixtures[kind]({
    privateKeyPem: idp.privateKeyPem,
    publicKeyPem: idp.publicKeyPem,
    inResponseTo: requestId,
    ...options,
  });
}

describe("GET /api/sso/saml/login", () => {
  test("mount order: the SAML route wins over S1's wildcard", async () => {
    // S1 registers `/sso/:provider/login` and Express matches in REGISTRATION
    // order, so `samlIdentityEndpoints` must be mounted before
    // `identityEndpoints` in index.js.
    //
    // If this test fails with 500, read it as "the wildcard swallowed the
    // route", NOT as "SAML is broken": the wildcard hands "saml" to a config
    // builder that only produces OIDC settings, and the SAML driver then throws
    // on a missing entityId. Nothing about the SAML code has to change to fix
    // it — the mount order does.
    const response = await request(app).get("/api/sso/saml/login");
    expect(response.status).toBe(302);
    // And it went to the SAML SSO URL, not to an OIDC authorize endpoint.
    expect(response.headers.location).toContain(process.env.SSO_SAML_SSO_URL);
  });

  test("redirects to the IdP and records the login state", async () => {
    const response = await request(app).get("/api/sso/saml/login");
    expect(response.status).toBe(302);

    const location = new URL(response.headers.location);
    const relayState = location.searchParams.get("RelayState");
    // Persisted BEFORE the user leaves, or the ACS has nothing to check the
    // assertion's InResponseTo against and every login fails.
    const row = await prisma.identity_login_state.findUnique({
      where: { state: relayState },
    });
    expect(row).not.toBeNull();
    expect(row.consumedAt).toBeNull();
  });
});

describe("POST /api/sso/saml/acs", () => {
  test("a valid assertion returns a session token that opens an authenticated route", async () => {
    const requestId = await beginLogin();
    const { xml } = assertionFor(requestId);

    const response = await request(app)
      .post("/api/sso/saml/acs")
      .type("form")
      .send({ SAMLResponse: encode(xml), RelayState: requestId });

    expect(response.status).toBe(200);
    expect(response.body.token).toEqual(expect.any(String));

    // The real proof: the token actually opens a protected route.
    const me = await request(app)
      .get("/api/system/system-vectors")
      .set("Authorization", `Bearer ${response.body.token}`);
    expect(me.status).not.toBe(401);
  });

  test("the session belongs to a real user holding a role grant", async () => {
    const requestId = await beginLogin();
    const { xml } = assertionFor(requestId, "valid", {
      nameId: `saml-${crypto.randomBytes(4).toString("hex")}@example.com`,
    });
    const response = await request(app)
      .post("/api/sso/saml/acs")
      .type("form")
      .send({ SAMLResponse: encode(xml), RelayState: requestId });

    const decoded = JWT.decode(response.body.token);
    const user = await prisma.users.findUnique({ where: { id: decoded.id } });
    expect(user).not.toBeNull();

    // §7.5: an ingress owns the contract it writes. A user the authorization
    // engine denies is not a logged-in user, however valid the assertion was.
    const grants = await prisma.principal_role_grants.findMany({
      where: { principal_type: "user", principal_id: String(user.id) },
      include: { roles: true },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0].roles.name).toBe("member");
  });

  test("an unsigned assertion is refused and creates no user", async () => {
    const requestId = await beginLogin();
    const before = await prisma.users.count();
    const { xml } = fixtures.unsigned({ inResponseTo: requestId });

    const response = await request(app)
      .post("/api/sso/saml/acs")
      .type("form")
      .send({ SAMLResponse: encode(xml), RelayState: requestId });

    expect(response.status).toBe(401);
    expect(await prisma.users.count()).toBe(before);
  });

  test("replaying the same assertion is refused and issues no second session", async () => {
    const requestId = await beginLogin();
    const { xml } = assertionFor(requestId);
    const first = await request(app)
      .post("/api/sso/saml/acs")
      .type("form")
      .send({ SAMLResponse: encode(xml), RelayState: requestId });
    expect(first.status).toBe(200);

    // The whole reason identity_assertion_ids exists: the bearer assertion is
    // the credential, so a captured POST must not be a second login.
    const second = await request(app)
      .post("/api/sso/saml/acs")
      .type("form")
      .send({ SAMLResponse: encode(xml), RelayState: requestId });
    expect(second.status).toBe(401);
    expect(second.body.token).toBeUndefined();
  });

  test("a login state issued by ANOTHER provider cannot be spent here", async () => {
    // identity_login_state is one table shared by every provider. Without a
    // provider check the state row an OIDC login wrote is a perfectly good
    // RelayState here — so an attacker who can start any flow satisfies this
    // endpoint's "answers a login we began" requirement using someone else's.
    const foreign = await prisma.identity_login_state.create({
      data: {
        state: `foreign-${crypto.randomBytes(8).toString("hex")}`,
        nonce: crypto.randomBytes(8).toString("hex"),
        provider: "oidc",
        redirectUri: fixtures.ACS_URL,
        codeVerifier: crypto.randomBytes(8).toString("hex"),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });
    const { xml } = assertionFor(foreign.state);

    const response = await request(app)
      .post("/api/sso/saml/acs")
      .type("form")
      .send({ SAMLResponse: encode(xml), RelayState: foreign.state });

    expect(response.status).toBe(401);
    expect(response.body.token).toBeUndefined();
  });

  test("an ACS post with no SAMLResponse is a flat refusal, not a crash", async () => {
    const response = await request(app).post("/api/sso/saml/acs").type("form").send({});
    expect(response.status).toBe(401);
  });

  test("Q-1: the ACS route is rate limited", async () => {
    // Unauthenticated, and every call costs an XML parse plus signature work
    // before it can be refused. Without a limiter this is a free CPU sink and a
    // free way to fill identity_assertion_ids.
    const requestId = await beginLogin();
    const { xml } = fixtures.unsigned({ inResponseTo: requestId });
    const body = { SAMLResponse: encode(xml), RelayState: requestId };

    let limited = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await request(app)
        .post("/api/sso/saml/acs")
        .type("form")
        .send(body);
      if (response.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });
});

describe("the ACS route decides no policy of its own", () => {
  test("R1: an assertion whose email matches a LOCAL account is a 409, not a takeover", async () => {
    const local = `local-${crypto.randomBytes(4).toString("hex")}@example.com`;
    await prisma.users.create({
      data: { username: local, password: "local-hash", role: "default" },
    });

    const requestId = await beginLogin();
    const { xml } = assertionFor(requestId, "valid", { nameId: local });
    const response = await request(app)
      .post("/api/sso/saml/acs")
      .type("form")
      .send({ SAMLResponse: encode(xml), RelayState: requestId });

    // linkPrincipal's R1 reaches the user unchanged: a conflict is the one case
    // where they can act on the reason.
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/settings/i);
  });

  test("a refused assertion says nothing about WHY", async () => {
    const requestId = await beginLogin();
    const { xml } = fixtures.wrongKey({ inResponseTo: requestId });
    const response = await request(app)
      .post("/api/sso/saml/acs")
      .type("form")
      .send({ SAMLResponse: encode(xml), RelayState: requestId });

    // Telling a caller whether the signature, the audience or the replay check
    // refused them is an oracle for tuning the next attempt.
    expect(response.status).toBe(401);
    expect(response.body.error).not.toMatch(/signature|audience|replay|expired/i);
  });
});

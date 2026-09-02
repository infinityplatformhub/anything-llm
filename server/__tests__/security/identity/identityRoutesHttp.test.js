// S1 (#36) T7 — the SSO routes over the real HTTP stack (recon §4 cases 1, 9, 10).
//
// This boots the actual Express app against a real Postgres schema, so what is
// asserted is what a browser would get: the redirect, the session JWT, and the
// refusals. A unit test of the handler would not have caught a route that was
// never mounted, which is half the point.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "approof-s1-"));
const schema = `s1_routes_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.API_KEY_PEPPER = "s1-routes-test-pepper-32-bytes-long";
process.env.STORAGE_DIR = path.join(tempDir, "storage");
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
  throw new Error("DATABASE_URL must point to PostgreSQL for S1 route tests");
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set("schema", schema);
process.env.DATABASE_URL = databaseUrl.toString();
fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });
fs.mkdirSync(path.resolve(__dirname, "../../../../collector/hotdir"), {
  recursive: true,
});

// SSO configuration the routes read. The client secret goes through
// CredentialStore in production; here the env fallback keeps the test hermetic.
process.env.SSO_OIDC_ENABLED = "true";
const { IDP_ORIGIN } = require("../../../__testHelpers__/identity/urls");
process.env.SSO_OIDC_ISSUER = IDP_ORIGIN;
process.env.SSO_OIDC_CLIENT_ID = "approof-workspace";
process.env.SSO_OIDC_CLIENT_SECRET = "test-client-secret";

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
const ISSUER = IDP_ORIGIN;
const CLIENT_ID = "approof-workspace";

// The IdP, stubbed at the network boundary: the routes use global fetch, so
// this is the only seam that does not require the driver to know it is a test.
const idpKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const idpJwk = {
  ...idpKey.publicKey.export({ format: "jwk" }),
  kid: "idp-key",
  alg: "RS256",
  use: "sig",
};
const idpState = { subject: "external-1", email: "sso-user@example.com", nonce: null };

global.fetch = jest.fn(async (url) => {
  const href = String(url);
  if (href.endsWith("/.well-known/openid-configuration"))
    return {
      ok: true,
      status: 200,
      json: async () => ({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
      }),
    };
  if (href === `${ISSUER}/jwks`)
    return { ok: true, status: 200, json: async () => ({ keys: [idpJwk] }) };
  if (href === `${ISSUER}/token`) {
    const id_token = JWT.sign(
      {
        sub: idpState.subject,
        email: idpState.email,
        email_verified: true,
        name: "SSO User",
        nonce: idpState.nonce,
      },
      idpKey.privateKey,
      {
        algorithm: "RS256",
        keyid: "idp-key",
        issuer: ISSUER,
        audience: CLIENT_ID,
        expiresIn: "5m",
      }
    );
    return { ok: true, status: 200, json: async () => ({ id_token }) };
  }
  throw new Error(`unexpected fetch: ${href}`);
});

const { CommunicationKey } = require("../../../utils/comKey");
new CommunicationKey(true);

const request = require("supertest");
const prisma = require("../../../utils/prisma");
const { app } = require("../../../index");
const {
  resetRequestControls,
} = require("../../../utils/middleware/requestControls");

/** Drive a full login and return the callback response. */
async function login() {
  const start = await request(app).get("/api/sso/oidc/login");
  const location = new URL(start.headers.location);
  const state = location.searchParams.get("state");
  idpState.nonce = location.searchParams.get("nonce");
  return request(app).get(`/api/sso/oidc/callback?code=auth-code&state=${state}`);
}

beforeEach(async () => {
  await resetRequestControls();
  idpState.subject = `external-${crypto.randomBytes(4).toString("hex")}`;
  idpState.email = `sso-${crypto.randomBytes(4).toString("hex")}@example.com`;
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("GET /api/sso/:provider/login", () => {
  test("redirects to the IdP with state and a PKCE challenge, and records the state", async () => {
    const response = await request(app).get("/api/sso/oidc/login");
    expect(response.status).toBe(302);

    const location = new URL(response.headers.location);
    expect(location.origin + location.pathname).toBe(`${ISSUER}/authorize`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");

    const state = location.searchParams.get("state");
    const row = await prisma.identity_login_state.findUnique({ where: { state } });
    // The state must be PERSISTED before the user leaves, or the callback has
    // nothing to verify against and every login fails.
    expect(row).not.toBeNull();
    expect(row.consumedAt).toBeNull();
  });

  test("an unknown provider is a 404, not a 500", async () => {
    const response = await request(app).get("/api/sso/nope/login");
    expect(response.status).toBe(404);
  });
});

describe("GET /api/sso/:provider/callback", () => {
  test("case 9: a valid callback returns a session token that validatedRequest accepts", async () => {
    const response = await login();
    expect(response.status).toBe(200);
    expect(response.body.token).toEqual(expect.any(String));

    // The real proof: the issued token opens an authenticated route.
    const me = await request(app)
      .get("/api/system/system-vectors")
      .set("Authorization", `Bearer ${response.body.token}`);
    expect(me.status).not.toBe(401);
  });

  test("case 10: the session belongs to a real user with a role grant", async () => {
    const response = await login();
    const decoded = JWT.decode(response.body.token);
    const user = await prisma.users.findUnique({ where: { id: decoded.id } });
    expect(user).not.toBeNull();

    // §7.5: an ingress is responsible for the contract it writes. A user the
    // engine denies is not a logged-in user.
    const grants = await prisma.principal_role_grants.findMany({
      where: { principal_type: "user", principal_id: String(user.id) },
      include: { roles: true },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0].roles.name).toBe("member");
  });

  test("case 1: replaying the same state is refused and issues no second session", async () => {
    const start = await request(app).get("/api/sso/oidc/login");
    const location = new URL(start.headers.location);
    const state = location.searchParams.get("state");
    idpState.nonce = location.searchParams.get("nonce");

    const first = await request(app).get(
      `/api/sso/oidc/callback?code=auth-code&state=${state}`
    );
    expect(first.status).toBe(200);

    const replay = await request(app).get(
      `/api/sso/oidc/callback?code=auth-code&state=${state}`
    );
    expect(replay.status).toBe(401);
    expect(replay.body.token).toBeUndefined();
    // The response must not tell the caller which of "replayed", "expired" or
    // "never existed" happened — that is an oracle. The detail is in the log.
    expect(JSON.stringify(replay.body)).not.toMatch(/replay/i);
  });

  test("a callback with no state is refused", async () => {
    const response = await request(app).get("/api/sso/oidc/callback?code=x");
    expect(response.status).toBe(401);
  });

  test("a callback with an unknown state is refused", async () => {
    const response = await request(app).get(
      "/api/sso/oidc/callback?code=x&state=never-issued"
    );
    expect(response.status).toBe(401);
  });

  test("the IdP's own error is surfaced as a refusal, not a 500", async () => {
    const start = await request(app).get("/api/sso/oidc/login");
    const state = new URL(start.headers.location).searchParams.get("state");
    const response = await request(app).get(
      `/api/sso/oidc/callback?error=access_denied&state=${state}`
    );
    expect(response.status).toBe(401);
  });
});

describe("rate limiting (Q-4)", () => {
  test("the login route returns 429 once the window limit is exceeded", async () => {
    // Unauthenticated, does a discovery fetch and a DB write per call. Without
    // a limiter this is a free way to fill identity_login_state and to make the
    // IdP absorb our traffic.
    let sawLimit = false;
    for (let i = 0; i < 40; i++) {
      const response = await request(app).get("/api/sso/oidc/login");
      if (response.status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });

  test("the CALLBACK route is limited too — a wrong state still costs a DB read", async () => {
    // Techlead: an unauthenticated callback with a junk state is refused, but
    // only after a lookup. Without a limiter that is a free way to make the
    // database do work, and the login limiter does not cover this path.
    let sawLimit = false;
    for (let i = 0; i < 40; i++) {
      const response = await request(app).get(
        `/api/sso/oidc/callback?code=x&state=junk-${i}`
      );
      if (response.status === 429) {
        sawLimit = true;
        break;
      }
    }
    expect(sawLimit).toBe(true);
  });
});

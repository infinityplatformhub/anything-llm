// S3 (#60) — POST /api/sso/ldap/login over the real HTTP stack.
//
// RED-first: written before the route exists.
//
// This route is different from S1's and S2's in a way that drives most of the
// tests below: it receives the user's DIRECTORY PASSWORD in a request body.
// Nothing else in the application does. So as much attention goes to what the
// route does NOT do with it — log it, audit it, echo it — as to whether it
// authenticates correctly.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "approof-s3-"));
const schema = `s3_routes_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.API_KEY_PEPPER = "s3-routes-test-pepper-32-bytes-long";
process.env.STORAGE_DIR = path.join(tempDir, "storage");
// Small limits so the rate-limit tests prove the limiters are MOUNTED without
// sending hundreds of requests. The numbers are configuration; their presence,
// and which key each one counts by, is the property under test.
//
// They are deliberately DIFFERENT from each other: with both set to the same
// value, every test that trips one trips the other at the same request, and
// nothing distinguishes a per-IP bucket from a per-account one.
process.env.INVITE_RATE_LIMIT_MAX = "20";
process.env.LOGIN_ACCOUNT_RATE_LIMIT_MAX = "3";
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
  throw new Error("DATABASE_URL must point to PostgreSQL for S3 route tests");
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set("schema", schema);
process.env.DATABASE_URL = databaseUrl.toString();
fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });
fs.mkdirSync(path.resolve(__dirname, "../../../../collector/hotdir"), {
  recursive: true,
});

const {
  makeDirectory,
  SERVICE_DN,
  SERVICE_PASSWORD,
  DEFAULT_BASE_DN,
} = require("../../../__testHelpers__/ldap/directory");

process.env.SSO_LDAP_ENABLED = "true";
process.env.SSO_LDAP_URL = "ldaps://directory.example.com:636";
process.env.SSO_LDAP_BASE_DN = DEFAULT_BASE_DN;
process.env.SSO_LDAP_BIND_DN = SERVICE_DN;
process.env.SSO_LDAP_BIND_PASSWORD = SERVICE_PASSWORD;

const testSchema = path.resolve(__dirname, "../../../prisma/schema.prisma");
execFileSync(
  path.resolve(__dirname, "../../../node_modules/.bin/prisma"),
  ["migrate", "deploy", "--schema", testSchema],
  { cwd: path.resolve(__dirname, "../../.."), env: process.env, stdio: "ignore" }
);

// The directory, stubbed at the connection boundary — the only seam that does
// not require the driver to know it is under test.
const directory = makeDirectory();
jest.mock("ldapts", () => {
  const actual = jest.requireActual("ldapts");
  return {
    ...actual,
    Client: jest.fn().mockImplementation(() => global.__ldapDirectory),
  };
});
global.__ldapDirectory = directory;

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
  directory.calls.binds.length = 0;
  directory.calls.searches.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
  // issue 77: hand the environment back. These are set at module scope because
  // the app is built at require time, but the limit is now read PER REQUEST —
  // so a value left behind is a value another suite's limiters would read.
  // Jest isolates the module registry per file, not `process.env`.
  delete process.env.INVITE_RATE_LIMIT_MAX;
  delete process.env.LOGIN_ACCOUNT_RATE_LIMIT_MAX;
});

const login = (body) =>
  request(app).post("/api/sso/ldap/login").type("json").send(body);

describe("POST /api/sso/ldap/login", () => {
  test("correct credentials return a session token that opens a protected route", async () => {
    const response = await login({
      username: "alice",
      password: "alice-correct-password",
    });

    expect(response.status).toBe(200);
    expect(response.body.token).toEqual(expect.any(String));

    // The real proof: the token actually works.
    const me = await request(app)
      .get("/api/system/system-vectors")
      .set("Authorization", `Bearer ${response.body.token}`);
    expect(me.status).not.toBe(401);
  });

  test("the session belongs to a real user holding a role grant", async () => {
    const response = await login({
      username: "bob",
      password: "bob-correct-password",
    });
    const decoded = JWT.decode(response.body.token);
    const user = await prisma.users.findUnique({ where: { id: decoded.id } });
    expect(user).not.toBeNull();

    // §7.5: an ingress owns the contract it writes. A user the authorization
    // engine denies is not a logged-in user, however correct their password was.
    const grants = await prisma.principal_role_grants.findMany({
      where: { principal_type: "user", principal_id: String(user.id) },
      include: { roles: true },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0].roles.name).toBe("member");
  });

  test("a wrong password is a 401 and creates no user", async () => {
    const before = await prisma.users.count();
    const response = await login({ username: "alice", password: "wrong" });
    expect(response.status).toBe(401);
    expect(await prisma.users.count()).toBe(before);
  });

  test("an EMPTY password is refused without touching the directory", async () => {
    // The RFC 4513 trap, at the route. The directory would accept this as an
    // anonymous bind; the credential must not even be sent.
    const response = await login({ username: "alice", password: "" });
    expect(response.status).toBe(401);

    const userBinds = directory.calls.binds.filter((call) => call.dn !== SERVICE_DN);
    expect(userBinds).toHaveLength(0);
  });

  test("a missing password field is refused the same way", async () => {
    const response = await login({ username: "alice" });
    expect(response.status).toBe(401);
  });

  test("an unknown user and a wrong password are byte-for-byte identical", async () => {
    // No enumeration oracle: the response must not tell an attacker which
    // usernames are worth attacking.
    const missing = await login({ username: "nobody", password: "any-password" });
    const wrong = await login({ username: "alice", password: "wrong-password" });

    expect(missing.status).toBe(wrong.status);
    expect(JSON.stringify(missing.body)).toBe(JSON.stringify(wrong.body));
  });

  test("an injection payload authenticates nobody", async () => {
    const response = await login({
      username: "alice)(uid=*",
      password: "alice-correct-password",
    });
    expect(response.status).toBe(401);
  });

  test("ruling 4: the route is rate limited", async () => {
    // Unauthenticated, and every call costs a directory round trip. Without a
    // limiter it is both a free CPU sink and an unmetered password-guessing
    // endpoint against the customer's real directory.
    let limited = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await login({ username: "alice", password: "wrong" });
      if (response.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });

  test("NIT-1: guessing ONE account is capped tighter than the IP budget", async () => {
    // Two buckets, and this one is keyed on ip+username. Without it an attacker
    // who stays inside the per-IP budget can spend the whole of it on a single
    // account — which is the only budget that matters when the target is one
    // person's password.
    //
    // The proof is the CONTRAST, not the 429: a fresh username from the same IP
    // must still be served at the point where the guessed one is refused. A
    // single per-IP limiter would have blocked both, and a test asserting only
    // "429 eventually" cannot tell the two designs apart.
    let refusedAt = null;
    for (let attempt = 1; attempt <= 10 && refusedAt === null; attempt++) {
      const response = await login({ username: "alice", password: "wrong" });
      if (response.status === 429) refusedAt = attempt;
    }
    expect(refusedAt).not.toBeNull();
    expect(refusedAt).toBeLessThan(Number(process.env.INVITE_RATE_LIMIT_MAX));

    const other = await login({ username: "bystander", password: "wrong" });
    expect(other.status).not.toBe(429);
  });

  test("the per-IP bucket still bounds an attacker who spreads across accounts", async () => {
    // The other half. Rotating usernames evades the per-account bucket entirely
    // — every request lands in a fresh one — so if the IP limiter were dropped,
    // password spraying across many accounts would be unmetered.
    let limited = false;
    for (let attempt = 0; attempt < 40 && !limited; attempt++) {
      const response = await login({
        username: `sprayed-${attempt}`,
        password: "wrong",
      });
      if (response.status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });
});

describe("GET /api/sso/ldap/enabled — what the login form asks", () => {
  test("reports that LDAP is on", async () => {
    // The login form needs this BEFORE anyone types a password: it decides
    // where the credential is posted. Getting it wrong sends a directory
    // password to the local login endpoint, which hashes and compares it
    // against a local record — the credential would land somewhere it was
    // never meant to go.
    const response = await request(app).get("/api/sso/ldap/enabled");
    expect(response.status).toBe(200);
    expect(response.body.enabled).toBe(true);
  });

  test("it exposes NOTHING about the directory", async () => {
    // Unauthenticated, so it answers one boolean. A URL, base DN or bind DN
    // here would hand an attacker the shape of the internal directory before
    // they have logged into anything.
    const response = await request(app).get("/api/sso/ldap/enabled");
    const body = JSON.stringify(response.body);
    for (const leak of ["ldap://", "ldaps://", "dc=", "cn=", "ou=", "bind"])
      expect(body.toLowerCase()).not.toContain(leak.toLowerCase());
    expect(Object.keys(response.body)).toEqual(["enabled"]);
  });
});

describe("the password does not survive the request", () => {
  test("it is not echoed in a success response", async () => {
    const response = await login({
      username: "alice",
      password: "alice-correct-password",
    });
    expect(JSON.stringify(response.body)).not.toContain("alice-correct-password");
  });

  test("it is not echoed in a failure response", async () => {
    const response = await login({ username: "alice", password: "hunter2-wrong" });
    expect(JSON.stringify(response.body)).not.toContain("hunter2-wrong");
  });

  test("it never reaches the audit trail", async () => {
    // The audit log is exported, shipped and read by people who have no business
    // seeing a directory password. A failed login writes an event; that event
    // must not carry the credential that failed.
    await login({ username: "alice", password: "audit-probe-password" });

    const events = await prisma.event_logs.findMany({ take: 50, orderBy: { id: "desc" } });
    for (const event of events)
      expect(JSON.stringify(event)).not.toContain("audit-probe-password");
  });
});

describe("the route decides no policy of its own", () => {
  test("R1: a directory user whose email matches a LOCAL account is a 409", async () => {
    // `oddball` rather than `alice`: earlier tests in this file log alice in,
    // which creates her SSO account, so seeding a LOCAL account under the same
    // address would collide on `users.username` in the test itself and never
    // reach the route. The person here must be one no other test has used.
    await prisma.users.create({
      data: {
        username: "o(dd)*ball@example.com",
        password: "local-hash",
        role: "default",
      },
    });

    const response = await login({
      username: "oddball",
      password: "oddball-password",
    });

    // linkPrincipal's R1 reaches the user unchanged: a conflict is the one case
    // they can act on.
    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/settings/i);
  });

  test("mount order: the LDAP route wins over S1's wildcard", async () => {
    // S1 registers `/sso/:provider/login` and Express matches in REGISTRATION
    // order, so `ldapIdentityEndpoints` must be mounted before
    // `identityEndpoints` in index.js. This is the defect that bit S2 in
    // cd4fda5e, and the shape repeats for every concrete route under /sso/.
    //
    // Read a failure here as "the wildcard swallowed the route", NOT as "LDAP is
    // broken": the wildcard would hand "ldap" to a config builder that only
    // produces OIDC settings. Nothing in the LDAP code changes to fix it — the
    // mount order does.
    const response = await login({
      username: "alice",
      password: "alice-correct-password",
    });
    // The wildcard is a GET route, so it would answer this POST with a 404
    // rather than a 500 — which is exactly why asserting only "not 500" would
    // miss it (§7.9: a 404 alone never proves a route exists).
    expect(response.status).not.toBe(404);
    expect(response.status).toBe(200);
  });

  test("GET is not a login — the route is POST only", async () => {
    // A password in a query string lands in access logs, proxy logs and browser
    // history. §7.9: assert the method, or a 404 proves nothing.
    const response = await request(app).get("/api/sso/ldap/login?username=a&password=b");
    expect(response.status).toBe(404);
  });
});

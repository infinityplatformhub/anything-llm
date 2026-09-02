// S1 (#36) T5 — IdentityLoginState against a REAL throwaway Postgres.
//
// This is the model that makes state and nonce single-use. Recon §4 case 1 is
// the headline: complete a callback, replay the same state, and the second
// attempt must be told apart from an expiry — which is why consumption sets
// consumedAt instead of deleting the row.

const { execSync } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");

const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `s1_state_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;
let IdentityLoginState;
const { IdentityAuthenticationError } = require("../../../utils/identityProviders/errors");

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
    throw new Error("S1 integration tests require DATABASE_URL pointing at PostgreSQL");
  const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${testDb}"`);
  await admin.$disconnect();
  execSync(`npx prisma migrate deploy --schema ${SCHEMA}`, {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
  ({ IdentityLoginState } = require("../../../models/identityLoginState"));
}, 300_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60_000);

const REDIRECT = "https://app.example.com/sso/oidc/callback";

describe("IdentityLoginState.issue", () => {
  test("mints unguessable state, nonce and PKCE verifier", async () => {
    const a = await IdentityLoginState.issue({
      provider: "oidc",
      redirectUri: REDIRECT,
      db: prisma,
    });
    const b = await IdentityLoginState.issue({
      provider: "oidc",
      redirectUri: REDIRECT,
      db: prisma,
    });

    // 32 bytes base64url. A predictable state is a CSRF hole: an attacker who
    // can guess it can feed their own callback into someone else's login.
    for (const value of [a.state, a.nonce, a.codeVerifier]) {
      expect(typeof value).toBe("string");
      expect(Buffer.from(value, "base64url").length).toBeGreaterThanOrEqual(32);
    }
    expect(a.state).not.toBe(b.state);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });

  test("the row expires within the 15 minute TTL", async () => {
    const issued = await IdentityLoginState.issue({
      provider: "oidc",
      redirectUri: REDIRECT,
      db: prisma,
    });
    const row = await prisma.identity_login_state.findUnique({
      where: { state: issued.state },
    });
    const ttlMs = row.expiresAt.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(row.consumedAt).toBeNull();
  });
});

describe("IdentityLoginState.consume", () => {
  test("a fresh state is consumed once and returns its nonce and verifier", async () => {
    const issued = await IdentityLoginState.issue({
      provider: "oidc",
      redirectUri: REDIRECT,
      db: prisma,
    });
    const consumed = await IdentityLoginState.consume(issued.state, { db: prisma });
    expect(consumed.nonce).toBe(issued.nonce);
    expect(consumed.codeVerifier).toBe(issued.codeVerifier);
    expect(consumed.provider).toBe("oidc");
    expect(consumed.redirectUri).toBe(REDIRECT);
  });

  test("case 1: replaying a consumed state is REJECTED and reported as a replay", async () => {
    const issued = await IdentityLoginState.issue({
      provider: "oidc",
      redirectUri: REDIRECT,
      db: prisma,
    });
    await IdentityLoginState.consume(issued.state, { db: prisma });

    const error = await IdentityLoginState.consume(issued.state, { db: prisma }).catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(IdentityAuthenticationError);
    // "replayed", not "expired" — the row still exists, and an operator seeing
    // this needs to know someone re-sent a used callback, not that a login sat
    // too long. Deleting on consume would erase that difference.
    expect(error.message).toMatch(/replay/i);

    const row = await prisma.identity_login_state.findUnique({
      where: { state: issued.state },
    });
    expect(row).not.toBeNull();
    expect(row.consumedAt).toBeInstanceOf(Date);
  });

  test("consumption is atomic — two concurrent callbacks, only one wins", async () => {
    const issued = await IdentityLoginState.issue({
      provider: "oidc",
      redirectUri: REDIRECT,
      db: prisma,
    });
    // A read-then-write consume would let both of these through: the classic
    // check-then-act race, and it is exactly a doubled login.
    const results = await Promise.allSettled([
      IdentityLoginState.consume(issued.state, { db: prisma }),
      IdentityLoginState.consume(issued.state, { db: prisma }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
  });

  test("an unknown state is rejected without revealing whether it ever existed", async () => {
    const error = await IdentityLoginState.consume("never-issued", {
      db: prisma,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(IdentityAuthenticationError);
  });

  test("an expired state is rejected and says so, distinctly from a replay", async () => {
    const state = crypto.randomBytes(32).toString("base64url");
    await prisma.identity_login_state.create({
      data: {
        state,
        nonce: crypto.randomBytes(32).toString("base64url"),
        provider: "oidc",
        redirectUri: REDIRECT,
        codeVerifier: crypto.randomBytes(32).toString("base64url"),
        expiresAt: new Date(Date.now() - 1_000),
      },
    });
    const error = await IdentityLoginState.consume(state, { db: prisma }).catch((e) => e);
    expect(error).toBeInstanceOf(IdentityAuthenticationError);
    expect(error.message).toMatch(/expired/i);
  });

  test("an expired state cannot be consumed even on its first use", async () => {
    // Expiry is checked as part of the consuming write, not before it: a
    // check-then-update would let a state that expired in between still through.
    const state = crypto.randomBytes(32).toString("base64url");
    await prisma.identity_login_state.create({
      data: {
        state,
        nonce: "n",
        provider: "oidc",
        redirectUri: REDIRECT,
        codeVerifier: "v",
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    await expect(IdentityLoginState.consume(state, { db: prisma })).rejects.toThrow();
    const row = await prisma.identity_login_state.findUnique({ where: { state } });
    expect(row.consumedAt).toBeNull();
  });
});

describe("IdentityLoginState.purgeExpired", () => {
  test("removes rows past their TTL and leaves live ones alone", async () => {
    const live = await IdentityLoginState.issue({
      provider: "oidc",
      redirectUri: REDIRECT,
      db: prisma,
    });
    const stale = crypto.randomBytes(32).toString("base64url");
    await prisma.identity_login_state.create({
      data: {
        state: stale,
        nonce: "n",
        provider: "oidc",
        redirectUri: REDIRECT,
        codeVerifier: "v",
        expiresAt: new Date(Date.now() - 3_600_000),
      },
    });

    const purged = await IdentityLoginState.purgeExpired({ db: prisma });
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.identity_login_state.findUnique({ where: { state: stale } })
    ).toBeNull();
    // An in-flight login must survive the sweep, or every concurrent login dies
    // whenever the purge runs.
    expect(
      await prisma.identity_login_state.findUnique({ where: { state: live.state } })
    ).not.toBeNull();
  });

  test("consumed-but-unexpired rows are kept so a replay is still detectable", async () => {
    const issued = await IdentityLoginState.issue({
      provider: "oidc",
      redirectUri: REDIRECT,
      db: prisma,
    });
    await IdentityLoginState.consume(issued.state, { db: prisma });
    await IdentityLoginState.purgeExpired({ db: prisma });
    expect(
      await prisma.identity_login_state.findUnique({ where: { state: issued.state } })
    ).not.toBeNull();
  });
});

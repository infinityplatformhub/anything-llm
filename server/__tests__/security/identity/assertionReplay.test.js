// S2 (#43) — single-use assertions, against a REAL throwaway Postgres DB.
//
// RED-first: written before the model exists.
//
// SAML's bearer assertion IS the credential. There is no PKCE, no nonce, and no
// second factor in the protocol — whoever holds the XML logs in. The only thing
// standing between a captured response and an unlimited replay is that the
// second presentation must fail, so these tests care as much about HOW the claim
// is made as about whether it refuses: a read-then-write loses the race that a
// replay attack is, and both requests get in.

const { execSync } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");

const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `s2_replay_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;
let AssertionReplay;
const {
  IdentityAuthenticationError,
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
  ({ AssertionReplay } = require("../../../models/assertionReplay"));
}, 300_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60_000);

const newId = () => `_assert-${crypto.randomBytes(8).toString("hex")}`;
const soon = () => new Date(Date.now() + 5 * 60_000);

describe("AssertionReplay.claim", () => {
  test("the first presentation is accepted", async () => {
    await expect(
      AssertionReplay.claim({
        provider: "saml",
        assertionId: newId(),
        expiresAt: soon(),
        db: prisma,
      })
    ).resolves.toBeUndefined();
  });

  test("the SECOND presentation of the same assertion is refused", async () => {
    const assertionId = newId();
    const claim = () =>
      AssertionReplay.claim({
        provider: "saml",
        assertionId,
        expiresAt: soon(),
        db: prisma,
      });

    await claim();
    // This is the replay: a captured response, re-sent. Everything about it is
    // valid — signature, conditions, audience — which is exactly why the only
    // defence is having spent it.
    await expect(claim()).rejects.toThrow(IdentityAuthenticationError);
  });

  test("two SIMULTANEOUS presentations: exactly one wins", async () => {
    const assertionId = newId();
    const claim = () =>
      AssertionReplay.claim({
        provider: "saml",
        assertionId,
        expiresAt: soon(),
        db: prisma,
      });

    // The mutation this kills is read-then-write: "is it recorded? no → record
    // it". Both callers read `no` before either writes, both proceed, and the
    // replay defence is gone for anyone who sends the response twice at once —
    // which is not a hard attack to mount.
    const results = await Promise.allSettled([claim(), claim(), claim()]);
    const accepted = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(2);
    for (const failure of refused)
      expect(failure.reason).toBeInstanceOf(IdentityAuthenticationError);
  });

  test("the refusal does not leak that the ID is what was recognised", async () => {
    const assertionId = newId();
    await AssertionReplay.claim({
      provider: "saml",
      assertionId,
      expiresAt: soon(),
      db: prisma,
    });
    const error = await AssertionReplay.claim({
      provider: "saml",
      assertionId,
      expiresAt: soon(),
      db: prisma,
    }).catch((e) => e);

    // The message reaches an unauthenticated caller. It must not echo the
    // assertion ID back or name the table.
    expect(error.message).not.toContain(assertionId);
    expect(error.message).not.toMatch(/identity_assertion_ids/i);
  });

  test("the same ID under a DIFFERENT provider is a different assertion", async () => {
    const assertionId = newId();
    await AssertionReplay.claim({
      provider: "saml",
      assertionId,
      expiresAt: soon(),
      db: prisma,
    });
    // One tenant's IDs must not lock out another's, or adding a second Entra
    // tenant starts failing random logins as replays.
    await expect(
      AssertionReplay.claim({
        provider: "saml-secondary",
        assertionId,
        expiresAt: soon(),
        db: prisma,
      })
    ).resolves.toBeUndefined();
  });

  test("a database failure that is NOT a duplicate surfaces, never passes as accepted", async () => {
    // Swallowing every error to "fail open on infrastructure trouble" would turn
    // a dead connection into an unlimited replay window.
    const exploding = {
      identity_assertion_ids: {
        create: async () => {
          const error = new Error("connection lost");
          error.code = "P1001";
          throw error;
        },
      },
    };
    await expect(
      AssertionReplay.claim({
        provider: "saml",
        assertionId: newId(),
        expiresAt: soon(),
        db: exploding,
      })
    ).rejects.toThrow(/connection lost/);
  });
});

describe("AssertionReplay.purgeExpired", () => {
  test("deletes rows past their expiry and keeps the rest", async () => {
    const stale = newId();
    const live = newId();
    await prisma.identity_assertion_ids.create({
      data: {
        provider: "saml",
        assertionId: stale,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    await prisma.identity_assertion_ids.create({
      data: { provider: "saml", assertionId: live, expiresAt: soon() },
    });

    const removed = await AssertionReplay.purgeExpired({ db: prisma });
    expect(removed).toBeGreaterThanOrEqual(1);

    // A row deleted early reopens the replay it exists to close, so the sweep
    // must be strictly by expiry — the assertion's own Conditions window is what
    // makes an expired row pointless to keep.
    expect(
      await prisma.identity_assertion_ids.findFirst({ where: { assertionId: stale } })
    ).toBeNull();
    expect(
      await prisma.identity_assertion_ids.findFirst({ where: { assertionId: live } })
    ).not.toBeNull();
  });
});

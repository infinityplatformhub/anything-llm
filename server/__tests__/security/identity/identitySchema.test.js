// S1 (#36) T1 — identity_links / identity_login_state against a REAL throwaway
// Postgres DB (code-standards §7.1a: migrate deploy, not db push — db push skips
// the T-1 seed and every authorization assertion after it is meaningless).
//
// RED-first: written before the models exist. These assert the two things the
// recon says must be database constraints rather than application logic —
// `@@unique([provider, subject])` and single-use login state — because a check
// that lives only in a service function is one code path away from being bypassed.

const { execSync } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");
const { REDIRECT_URI } = require("../../../__testHelpers__/identity/urls");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");

const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `s1_schema_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    throw new Error("S1 integration tests require DATABASE_URL pointing at PostgreSQL");
  }
  const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${testDb}"`);
  await admin.$disconnect();

  execSync(`npx prisma migrate deploy --schema ${SCHEMA}`, {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
}, 300_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60_000);

async function makeUser(username) {
  return prisma.users.create({
    data: { username, password: "not-a-real-hash", role: "default" },
  });
}

describe("identity_links", () => {
  test("the same (provider, subject) cannot be linked to two users — enforced by the DB", async () => {
    const alice = await makeUser(`alice_${crypto.randomBytes(3).toString("hex")}`);
    const bob = await makeUser(`bob_${crypto.randomBytes(3).toString("hex")}`);
    const subject = `sub_${crypto.randomBytes(4).toString("hex")}`;

    await prisma.identity_links.create({
      data: { userId: alice.id, provider: "oidc", subject, email: "alice@example.com" },
    });

    // Bob attempting to claim Alice's external identity is a takeover. It must
    // fail at the write, not at a branch someone can forget to call.
    await expect(
      prisma.identity_links.create({
        data: { userId: bob.id, provider: "oidc", subject, email: "bob@example.com" },
      })
    ).rejects.toThrow();
  });

  test("the same subject from a DIFFERENT provider is a different identity", async () => {
    const user = await makeUser(`carol_${crypto.randomBytes(3).toString("hex")}`);
    const subject = `sub_${crypto.randomBytes(4).toString("hex")}`;

    await prisma.identity_links.create({
      data: { userId: user.id, provider: "oidc", subject, email: "carol@example.com" },
    });
    // Subjects are only unique WITHIN an issuer. Making the constraint
    // subject-only would collide two unrelated IdPs that both number from 1.
    await expect(
      prisma.identity_links.create({
        data: { userId: user.id, provider: "saml", subject, email: "carol@example.com" },
      })
    ).resolves.toBeDefined();
  });

  test("deleting a user removes their identity links", async () => {
    const user = await makeUser(`dave_${crypto.randomBytes(3).toString("hex")}`);
    const subject = `sub_${crypto.randomBytes(4).toString("hex")}`;
    await prisma.identity_links.create({
      data: { userId: user.id, provider: "oidc", subject, email: "dave@example.com" },
    });

    await prisma.users.delete({ where: { id: user.id } });

    // A link outliving its user is an orphan that would let a deleted account's
    // external identity resolve to a dangling row.
    const orphans = await prisma.identity_links.findMany({ where: { subject } });
    expect(orphans).toHaveLength(0);
  });
});

describe("identity_login_state", () => {
  test("state is the primary key — a replayed state cannot be inserted twice", async () => {
    const state = crypto.randomBytes(16).toString("base64url");
    const row = {
      state,
      nonce: crypto.randomBytes(16).toString("base64url"),
      provider: "oidc",
      redirectUri: REDIRECT_URI,
      codeVerifier: crypto.randomBytes(32).toString("base64url"),
      expiresAt: new Date(Date.now() + 900_000),
    };
    await prisma.identity_login_state.create({ data: row });
    await expect(prisma.identity_login_state.create({ data: row })).rejects.toThrow();
  });

  test("consumedAt starts null and survives being set — consumption is not deletion", async () => {
    const state = crypto.randomBytes(16).toString("base64url");
    const created = await prisma.identity_login_state.create({
      data: {
        state,
        nonce: crypto.randomBytes(16).toString("base64url"),
        provider: "oidc",
        redirectUri: REDIRECT_URI,
        codeVerifier: crypto.randomBytes(32).toString("base64url"),
        expiresAt: new Date(Date.now() + 900_000),
      },
    });
    expect(created.consumedAt).toBeNull();

    const consumed = await prisma.identity_login_state.update({
      where: { state },
      data: { consumedAt: new Date() },
    });
    // The row must still EXIST after consumption. Deleting it would make a
    // replay indistinguishable from an expired login, and "replayed" is the
    // case an operator needs to see.
    expect(consumed.consumedAt).toBeInstanceOf(Date);
    const stillThere = await prisma.identity_login_state.findUnique({ where: { state } });
    expect(stillThere).not.toBeNull();
  });
});

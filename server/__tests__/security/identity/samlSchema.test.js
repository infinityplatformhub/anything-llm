// S2 (#43) — identity_assertion_ids / identity_providers against a REAL throwaway
// Postgres DB (code-standards §7.1a: migrate deploy, not db push).
//
// RED-first: written before the models exist.
//
// These two tables carry the properties SAML cannot enforce in application code:
//
//   * An assertion may be presented ONCE. SAML has no PKCE and no nonce — the
//     bearer assertion IS the credential, so anyone who captures one replays it
//     until it expires. Single-use has to be a database constraint, because a
//     check in a service function is one code path away from being skipped.
//
//   * A provider has ONE configuration. Two rows for the same provider means the
//     certificate a signature is checked against depends on row order.

const { execSync } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");
const { IDP_ORIGIN } = require("../../../__testHelpers__/identity/urls");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");

const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `s2_schema_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;

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
}, 300_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60_000);

const assertionRow = (overrides = {}) => ({
  provider: "saml",
  assertionId: `_assert-${crypto.randomBytes(8).toString("hex")}`,
  expiresAt: new Date(Date.now() + 5 * 60_000),
  ...overrides,
});

describe("identity_assertion_ids — an assertion is spent when it is used", () => {
  test("the same (provider, assertionId) cannot be recorded twice", async () => {
    const row = assertionRow();
    await prisma.identity_assertion_ids.create({ data: row });

    // This IS the replay defence. SAML's bearer assertion is the credential, so
    // a captured response is a working login for as long as it is valid unless
    // the second presentation fails at the write.
    await expect(
      prisma.identity_assertion_ids.create({ data: row })
    ).rejects.toThrow();
  });

  test("the same assertion ID from a DIFFERENT provider is a different assertion", async () => {
    const assertionId = `_assert-${crypto.randomBytes(8).toString("hex")}`;
    await prisma.identity_assertion_ids.create({ data: assertionRow({ assertionId }) });

    // Assertion IDs are unique only WITHIN an issuer. A provider-blind constraint
    // would let one IdP's traffic lock out another's — two Entra tenants, or a
    // test IdP alongside production, and one tenant's logins start failing as
    // replays. Same reasoning as identity_links' (provider, subject).
    await expect(
      prisma.identity_assertion_ids.create({
        data: assertionRow({ provider: "saml-secondary", assertionId }),
      })
    ).resolves.toBeDefined();
  });

  test("expiresAt is indexed so the T-6 purge can sweep without a table scan", async () => {
    const indexes = await prisma.$queryRawUnsafe(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'identity_assertion_ids'`
    );
    const definitions = indexes.map((row) => row.indexdef).join("\n");
    // Unswept, this table grows by one row per login attempt forever — including
    // the failed and unauthenticated ones, which an attacker controls the rate of.
    expect(definitions).toMatch(/expiresAt/);
  });

  test("a recorded assertion carries when it stops being replayable", async () => {
    const row = assertionRow();
    const created = await prisma.identity_assertion_ids.create({ data: row });

    // The purge deletes by expiry ALONE. A row kept past its assertion's validity
    // window protects nothing — the assertion is already refused on its own
    // Conditions — while a row deleted early reopens the replay it exists to stop.
    expect(created.expiresAt).toBeInstanceOf(Date);
    expect(created.createdAt).toBeInstanceOf(Date);
  });
});

describe("identity_providers — one provider, one configuration", () => {
  const providerRow = (overrides = {}) => ({
    provider: `saml-${crypto.randomBytes(4).toString("hex")}`,
    entityId: `${IDP_ORIGIN}/saml`,
    ssoUrl: `${IDP_ORIGIN}/saml/sso`,
    certificates: ["MIIBcert1"],
    ...overrides,
  });

  test("a provider cannot be configured twice", async () => {
    const row = providerRow();
    await prisma.identity_providers.create({ data: row });

    // Two rows means the certificate a signature is verified against depends on
    // which row is read first. An operator who adds a second row while debugging
    // would silently change who is trusted.
    await expect(prisma.identity_providers.create({ data: row })).rejects.toThrow();
  });

  test("a newly configured provider is DISABLED until someone turns it on", async () => {
    const created = await prisma.identity_providers.create({ data: providerRow() });

    // Fail closed. Configuration arrives field by field through a settings form,
    // and a provider that went live at the first saved field would accept logins
    // against a half-written certificate list.
    expect(created.enabled).toBe(false);
  });

  test("certificates are a LIST, so an IdP can rotate without an outage", async () => {
    // Entra publishes the next certificate before it starts signing with it. A
    // single-certificate column forces a flag-day cutover: every login fails as
    // a bad signature between the IdP rotating and an operator noticing.
    const created = await prisma.identity_providers.create({
      data: providerRow({ certificates: ["MIIBold", "MIIBnew"] }),
    });
    expect(created.certificates).toEqual(["MIIBold", "MIIBnew"]);

    const reread = await prisma.identity_providers.findUnique({
      where: { provider: created.provider },
    });
    expect(reread.certificates).toHaveLength(2);
  });

  test("no column holds a secret — signing keys belong in the CredentialStore", async () => {
    // Certificates and endpoints are public; the SP's own private key is not.
    // This table is read on every login and is in every database backup, so a
    // secret column here is a secret in plaintext at rest. CredentialStore
    // (AES-256-GCM, bound to its key name) is where those go.
    const columns = await prisma.$queryRawUnsafe(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'identity_providers'`
    );
    const names = columns.map((row) => row.column_name.toLowerCase());
    // Without this the test passes on a table that does not exist: no columns,
    // nothing to match, green. The assertion it is supposed to make would then
    // never run again once someone adds a secret column.
    expect(names).toContain("entityid");
    for (const name of names)
      expect(name).not.toMatch(/secret|privatekey|private_key|password/);
  });
});

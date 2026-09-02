// S3 (#60) — LDAP configuration in identity_providers, against real Postgres.
//
// RED-first: written before the columns exist.
//
// The existing columns are SAML-shaped (entityId, ssoUrl, certificates). LDAP
// needs a directory URL, a search base and an attribute map, and none of those
// fit. PMO pre-authorized slot 091000 for exactly this.
//
// What must NOT appear here is the bind password. It is a real secret, unlike
// S2's certificates which are public material, so it belongs in CredentialStore
// (AES-256-GCM, bound to its key name). This table is read on every login and
// sits in every backup.

const { execSync } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");

const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `s3_config_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
    throw new Error("S3 integration tests require DATABASE_URL pointing at PostgreSQL");
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

const ldapRow = (overrides = {}) => ({
  provider: `ldap-${crypto.randomBytes(4).toString("hex")}`,
  // SAML's columns are NOT NULL, so an LDAP row has to satisfy them. They stay
  // empty rather than being repurposed: a URL hidden in `ssoUrl` would read as
  // a SAML endpoint to anyone looking at the table later.
  entityId: "",
  ssoUrl: "",
  certificates: [],
  ldapUrl: "ldaps://directory.example.com:636",
  baseDn: "ou=people,dc=example,dc=com",
  bindDn: "cn=svc-approof,ou=services,dc=example,dc=com",
  usernameAttribute: "uid",
  emailAttribute: "mail",
  displayNameAttribute: "cn",
  ...overrides,
});

describe("identity_providers carries an LDAP configuration", () => {
  test("an LDAP provider round-trips", async () => {
    const created = await prisma.identity_providers.create({ data: ldapRow() });
    expect(created.ldapUrl).toBe("ldaps://directory.example.com:636");
    expect(created.baseDn).toBe("ou=people,dc=example,dc=com");
    expect(created.bindDn).toBe("cn=svc-approof,ou=services,dc=example,dc=com");
  });

  test("a newly configured LDAP provider is DISABLED until someone turns it on", async () => {
    // Same fail-closed rule S2 established: configuration arrives field by
    // field, and a provider live at the first save would authenticate against a
    // half-written directory URL.
    const created = await prisma.identity_providers.create({ data: ldapRow() });
    expect(created.enabled).toBe(false);
  });

  test("the attribute map defaults to the common LDAP names", async () => {
    // A deployment that never touches these still works against a normal
    // directory, and an operator only overrides what is actually different.
    const created = await prisma.identity_providers.create({
      data: {
        provider: `ldap-${crypto.randomBytes(4).toString("hex")}`,
        entityId: "",
        ssoUrl: "",
        certificates: [],
        ldapUrl: "ldaps://directory.example.com:636",
        baseDn: "ou=people,dc=example,dc=com",
        bindDn: "cn=svc,dc=example,dc=com",
      },
    });
    expect(created.usernameAttribute).toBe("uid");
    expect(created.emailAttribute).toBe("mail");
    expect(created.displayNameAttribute).toBe("cn");
  });

  test("NO column holds the bind password — it belongs in CredentialStore", async () => {
    // The bind password is a real secret, unlike S2's certificates. This table
    // is read on every login and is in every backup, so a password column here
    // is a password in plaintext at rest.
    const columns = await prisma.$queryRawUnsafe(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'identity_providers'`
    );
    const names = columns.map((row) => row.column_name.toLowerCase());
    // Guard the guard: on a table that did not exist, the loop below would pass
    // vacuously and never run again once someone added a secret column.
    expect(names).toContain("ldapurl");
    for (const name of names)
      expect(name).not.toMatch(/secret|password|bindpw|credential/);
  });

  test("one provider, one configuration — still", async () => {
    const row = ldapRow();
    await prisma.identity_providers.create({ data: row });
    // Two rows means the directory a login is checked against depends on row
    // order, which is the S2 reasoning applied to a different column set.
    await expect(prisma.identity_providers.create({ data: row })).rejects.toThrow();
  });

  test("a SAML row still works — the new columns are optional", async () => {
    // The migration must not break the provider already in production. LDAP's
    // columns are nullable for exactly this reason.
    const created = await prisma.identity_providers.create({
      data: {
        provider: `saml-${crypto.randomBytes(4).toString("hex")}`,
        entityId: "https://app.example.com/saml/metadata",
        ssoUrl: "https://idp.example.com/saml/sso",
        certificates: ["MIIBcert"],
      },
    });
    expect(created.certificates).toEqual(["MIIBcert"]);
    expect(created.ldapUrl).toBeNull();
  });
});

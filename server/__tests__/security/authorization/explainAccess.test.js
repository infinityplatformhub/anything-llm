/**
 * T-7 (#31): S-18 / S-19 — access diagnostics.
 *
 * "Who can see this document and why" is the reverse of the engine's forward
 * question, which is what T-1's dual index on document_acl was for. These tests
 * pin the two properties that make the answer safe to act on: it does not leak
 * existence, and it refuses rather than answering a moving target.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "t7-explain-")
  );

const { execSync } = require("child_process");
const crypto = require("crypto");
const path = require("path");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `t7_explain_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;
let explainDocumentAccess;
let repository;
let doc;
let group;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    throw new Error("T-7 integration tests require DATABASE_URL on PostgreSQL");
  }
  const admin = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${testDb}"`);
  await admin.$disconnect();
  execSync(`npx prisma migrate deploy --schema ${SCHEMA}`, {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  execSync(`node prisma/seed.js`, {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  process.env.DATABASE_URL = testUrl;

  // utils/prisma binds DATABASE_URL at first require and jest --runInBand shares
  // one process, so another suite may already have it loaded against the shared
  // database — in which case every write below silently lands there. The tests
  // still pass (they read back what they wrote); the damage is to OTHER suites,
  // since isConfirmedSingleUser counts real user rows.
  jest.resetModules();
  prisma = require("../../../utils/prisma");
  ({
    explainDocumentAccess,
  } = require("../../../utils/authorization/explainAccess"));
  repository = require("../../../utils/authorization/policyRepository");
  const {
    SERVICE_PRINCIPALS,
  } = require("../../../utils/authorization/actorResolver");

  doc = await prisma.documents.create({
    data: { orgId: 1, filename: "secret.txt", dedupe_key: `/x/${dbSuffix}.txt` },
  });
  const reader = await prisma.users.create({
    data: { username: `reader-${dbSuffix}`, password: "unused" },
  });
  const blocked = await prisma.users.create({
    data: { username: `blocked-${dbSuffix}`, password: "unused" },
  });
  group = await prisma.groups.create({
    data: { orgId: 1, name: `finance-${dbSuffix}` },
  });
  const inGroup = await prisma.users.create({
    data: { username: `member-${dbSuffix}`, password: "unused" },
  });
  await prisma.group_members.create({
    data: { group_id: group.id, user_id: inGroup.id },
  });

  await repository.grantDocumentAcl({
    actor: SERVICE_PRINCIPALS.singleUser,
    documentId: doc.id,
    principalType: "user",
    principalId: String(reader.id),
    action: "document.read",
    db: prisma,
  });
  await repository.grantDocumentAcl({
    actor: SERVICE_PRINCIPALS.singleUser,
    documentId: doc.id,
    principalType: "user",
    principalId: String(blocked.id),
    action: "document.read",
    effect: "deny",
    db: prisma,
  });
  await repository.grantDocumentAcl({
    actor: SERVICE_PRINCIPALS.singleUser,
    documentId: doc.id,
    principalType: "group",
    principalId: String(group.id),
    action: "document.read",
    source: "inherited_workspace",
    db: prisma,
  });
}, 300_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  process.env.DATABASE_URL = baseDatabaseUrl;
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const admin = new PrismaClient({
      datasources: { db: { url: baseDatabaseUrl } },
    });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60_000);

describe("explainDocumentAccess", () => {
  test("answers who and why, with denies first and group members expanded", async () => {
    const result = await explainDocumentAccess({ documentId: doc.id });

    // Deny first: a reader scanning the list meets the refusal before the
    // reasons for access.
    expect(result.principals[0].effect).toBe("deny");

    const groupEntry = result.principals.find(
      (p) => p.principalType === "group"
    );
    // "the finance group may read it" does not tell a support engineer whether
    // the person complaining is in finance.
    expect(groupEntry.members).toHaveLength(1);
    expect(groupEntry.via).toBe("inherited_workspace");

    // Serialised for a JSON route, so not a BigInt.
    expect(typeof result.policyVersion).toBe("string");
    expect(result.hidden).toBe(false);
  });

  test("visibility is reported, since it overrides every grant", async () => {
    const {
      SERVICE_PRINCIPALS,
    } = require("../../../utils/authorization/actorResolver");
    await repository.setDocumentVisibility({
      actor: SERVICE_PRINCIPALS.singleUser,
      documentId: doc.id,
      hidden: true,
      db: prisma,
    });
    const result = await explainDocumentAccess({ documentId: doc.id });
    // A document with allow rows that nobody can read is exactly the support
    // ticket this tool exists for.
    expect(result.hidden).toBe(true);
    expect(result.principals.length).toBeGreaterThan(0);
  });

  test("S-18: a document that does not exist returns nothing, not a 'no access' answer", async () => {
    expect(await explainDocumentAccess({ documentId: 987654 })).toBeNull();
  });

  test("S-19: it refuses rather than reporting a list assembled while policy moved", async () => {
    const {
      AuthorizationUnavailableError,
    } = require("../../../utils/authorization/errors");
    const {
      SERVICE_PRINCIPALS,
    } = require("../../../utils/authorization/actorResolver");

    // Move the clock between the two reads the function makes.
    let reads = 0;
    const movingDb = new Proxy(prisma, {
      get(target, prop) {
        if (prop === "policy_versions") {
          return {
            findFirst: async (args) => {
              reads += 1;
              if (reads === 2) {
                await repository.setDocumentVisibility({
                  actor: SERVICE_PRINCIPALS.singleUser,
                  documentId: doc.id,
                  hidden: false,
                  db: prisma,
                });
              }
              return target.policy_versions.findFirst(args);
            },
          };
        }
        return target[prop];
      },
    });

    await expect(
      explainDocumentAccess({ documentId: doc.id, db: movingDb })
    ).rejects.toBeInstanceOf(AuthorizationUnavailableError);
  });
});

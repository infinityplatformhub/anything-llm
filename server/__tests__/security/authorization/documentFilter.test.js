// T-3 (#22) integration tests — documentFilter + cache against a REAL throwaway Postgres
// DB (code-standards §7.1). RED-first: written before documentFilter.js/cache.js exist.
// Covers the seam-02 filter contract, visibility-before-ACL, the allow-list cap, the
// policy clock, and cache invalidation via policy.changed.

const { execSync } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");

const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `t3_it_${dbSuffix}`;
const testUrl = baseDatabaseUrl.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;

beforeAll(async () => {
  const hasPostgresUrl = baseDatabaseUrl?.startsWith("postgresql://");
  if (!hasPostgresUrl) {
    throw new Error("T-3 integration tests require DATABASE_URL pointing at PostgreSQL");
  }
  const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
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
  prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
}, 300_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  const stillPostgres = baseDatabaseUrl?.startsWith("postgresql://");
  if (stillPostgres) {
    const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
});

const { buildDocumentFilter } = require("../../../utils/authorization/documentFilter");
const { FilterCache } = require("../../../utils/authorization/cache");
const repository = require("../../../utils/authorization/policyRepository");
const { SERVICE_PRINCIPALS } = require("../../../utils/authorization/actorResolver");

const SYS = SERVICE_PRINCIPALS.singleUser;
const READER = "document.read";

let W1;
let roles = {};
let docs = {};

beforeAll(async () => {
  for (const name of ["member", "owner", "viewer"]) {
    roles[name] = await prisma.roles.findFirstOrThrow({
      where: { name, scope: name === "member" ? "org" : "workspace" },
    });
  }
  W1 = await prisma.workspaces.create({ data: { name: "w1", slug: `t3-w1-${dbSuffix}` } });
  for (const key of ["visible", "hidden", "denied"]) {
    docs[key] = await prisma.documents.create({
      data: { orgId: 1, filename: `${key}.txt`, dedupe_key: `/t3/${dbSuffix}/${key}.txt` },
    });
    await prisma.document_acl.create({
      data: {
        orgId: 1, document_id: docs[key].id, principal_type: "workspace",
        principal_id: String(W1.id), action: READER, source: "inherited_workspace",
      },
    });
  }
});

async function userActor(id, roleId, workspaceId = W1.id) {
  await repository.grantRole({
    actor: SYS, principalType: "user", principalId: String(id),
    roleId, workspaceId, db: prisma,
  });
  return { type: "user", id: String(id), orgId: 1, workspaceIds: [String(W1.id)] };
}

describe("T-3 documentFilter", () => {
  test("null actor returns a valid match-none filter, never null and never unfiltered", async () => {
    const filter = await buildDocumentFilter({ actor: null, action: READER, db: prisma });
    expect(filter).not.toBeNull();
    expect(filter.matchNone).toBe(true);
    expect(filter.policyVersion).toBeDefined();
  });

  test("an actor with no grants gets match-none, not an empty allow-everything filter", async () => {
    const stranger = { type: "user", id: "8001", orgId: 1, workspaceIds: [] };
    const filter = await buildDocumentFilter({ actor: stranger, action: READER, db: prisma });
    expect(filter.matchNone).toBe(true);
  });

  test("a workspace member gets a scoped filter carrying the current policy version", async () => {
    const actor = await userActor(8002, roles.viewer.id);
    const filter = await buildDocumentFilter({ actor, action: READER, db: prisma });
    expect(filter.matchNone).toBe(false);
    expect(filter.orgId).toBe(1);
    expect(filter.principalType).toBe("user");
    expect(filter.actorId).toBe("8002");
    expect(filter.workspaceIds).toContain(String(W1.id));
    const head = await repository.currentPolicyVersion(prisma);
    expect(filter.policyVersion).toBe(head);
  });

  test("visibility is a hard override: a hidden document is denied even with an explicit allow grant", async () => {
    const actor = await userActor(8003, roles.viewer.id);
    await prisma.document_acl.create({
      data: {
        orgId: 1, document_id: docs.hidden.id, principal_type: "user",
        principal_id: "8003", action: READER, source: "manual",
      },
    });
    await repository.setDocumentVisibility({ actor: SYS, documentId: docs.hidden.id, hidden: true, db: prisma });
    const filter = await buildDocumentFilter({ actor, action: READER, db: prisma });
    expect(filter.deniedDocumentIds).toContain(String(docs.hidden.id));
  });

  test("an explicit deny row wins over the inherited workspace allow", async () => {
    const actor = await userActor(8004, roles.viewer.id);
    await prisma.document_acl.create({
      data: {
        orgId: 1, document_id: docs.denied.id, principal_type: "user",
        principal_id: "8004", action: READER, effect: "deny", source: "manual",
      },
    });
    const filter = await buildDocumentFilter({ actor, action: READER, db: prisma });
    expect(filter.deniedDocumentIds).toContain(String(docs.denied.id));
  });

  test("user actors never carry an allowedDocumentIds list (no org-wide IN-list)", async () => {
    const actor = await userActor(8005, roles.viewer.id);
    const filter = await buildDocumentFilter({ actor, action: READER, db: prisma });
    expect(filter.allowedDocumentIds).toBeUndefined();
  });

  test("embed actors carry a bounded allow list; over the cap it degrades to match-none", async () => {
    const embed = { type: "embed", id: `emb-${dbSuffix}`, orgId: 1, workspaceIds: [String(W1.id)] };
    const small = await buildDocumentFilter({
      actor: embed, action: READER, db: prisma, allowedDocumentIds: ["1", "2", "3"],
    });
    expect(small.allowedDocumentIds).toEqual(["1", "2", "3"]);
    expect(small.matchNone).toBe(false);

    const tooMany = Array.from({ length: 501 }, (_, i) => String(i + 1));
    const over = await buildDocumentFilter({
      actor: embed, action: READER, db: prisma, allowedDocumentIds: tooMany,
    });
    expect(over.matchNone).toBe(true);
    expect(over.allowedDocumentIds).toBeUndefined();
  });

  test("S-16: revoking the workspace ACL excludes the document on the next filter build", async () => {
    const actor = await userActor(8006, roles.viewer.id);
    const before = await buildDocumentFilter({ actor, action: READER, db: prisma });
    expect(before.deniedDocumentIds).not.toContain(String(docs.visible.id));

    // Replacing the inherited allow with an explicit deny is what makes the document
    // unreachable for this actor; the revoke itself must still advance the clock so
    // caches rebuild (S-16).
    await repository.revokeDocumentAcl({
      actor: SYS, documentId: docs.visible.id, principalType: "workspace",
      principalId: String(W1.id), action: READER, db: prisma,
    });
    await repository.grantDocumentAcl({
      actor: SYS, documentId: docs.visible.id, principalType: "user",
      principalId: "8006", action: READER, effect: "deny", db: prisma,
    });
    const after = await buildDocumentFilter({ actor, action: READER, db: prisma });
    expect(after.deniedDocumentIds).toContain(String(docs.visible.id));
    expect(after.policyVersion).toBeGreaterThan(before.policyVersion);
  });
});

describe("T-3 filter cache", () => {
  test("a filter is reused only while the policy version is unchanged", async () => {
    const actor = await userActor(8007, roles.viewer.id);
    const cache = new FilterCache();
    let builds = 0;
    const build = async () => {
      builds += 1;
      return buildDocumentFilter({ actor, action: READER, db: prisma });
    };
    await cache.get({ actor, action: READER, db: prisma }, build);
    await cache.get({ actor, action: READER, db: prisma }, build);
    expect(builds).toBe(1);

    await repository.grantRole({
      actor: SYS, principalType: "user", principalId: "9999",
      roleId: roles.member.id, db: prisma,
    });
    await cache.get({ actor, action: READER, db: prisma }, build);
    expect(builds).toBe(2);
  });

  test("policy.changed invalidates by scope key", async () => {
    const actor = await userActor(8008, roles.viewer.id);
    const cache = new FilterCache();
    let builds = 0;
    const build = async () => {
      builds += 1;
      return buildDocumentFilter({ actor, action: READER, db: prisma });
    };
    await cache.get({ actor, action: READER, db: prisma }, build);
    cache.invalidateScopes(["org:1"]);
    await cache.get({ actor, action: READER, db: prisma }, build);
    expect(builds).toBe(2);
  });

  test("a disabled cache always rebuilds — stale is never served", async () => {
    const actor = await userActor(8009, roles.viewer.id);
    const cache = new FilterCache();
    cache.disable("bus subscription down");
    let builds = 0;
    const build = async () => {
      builds += 1;
      return buildDocumentFilter({ actor, action: READER, db: prisma });
    };
    await cache.get({ actor, action: READER, db: prisma }, build);
    await cache.get({ actor, action: READER, db: prisma }, build);
    expect(builds).toBe(2);
  });
});

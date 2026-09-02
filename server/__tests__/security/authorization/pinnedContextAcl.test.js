// T-5 (#30) slice 2 (G17/S-21) — context that never touches the vector store.
//
// Slice 1 closed `performSimilaritySearch`. Two other paths put document text into the
// prompt without going near a vector store, so the ACL that slice built is bypassed
// entirely for anything reached through them:
//
//   A. DocumentManager.pinnedDocs() — queries workspace_documents by workspaceId and
//      pinned:true, then reads each file off disk. No actor, no ACL, at all. Anyone who
//      can chat in the workspace gets every pinned document, including ones document_acl
//      explicitly denies them.
//   B. WorkspaceParsedFiles.getContextFiles() — filters by userId, but only when a caller
//      passes one: `...(user ? { userId: user.id } : {})`. Omit it and you get every
//      user's files for that workspace.
//
// RED-first: written before the fix. A denied pinned document currently reaches the
// prompt, and this suite says so.
//
// The ids matter. `document_acl` keys on `document_id` (Int, canonical); a pinned row also
// carries the legacy `docId` string, frozen until the canonicalize job finishes. Matching
// the wrong one either hides every pinned document or matches nothing and admits them all,
// so both shapes are covered below, including a row whose documentId is still NULL.

const { execSync } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");

// Set BEFORE any require that reads it. `utils/files` resolves STORAGE_DIR at import time,
// so assigning it in beforeAll is too late — the module has already thrown.
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "t5s2-"));
fs.mkdirSync(path.join(storageDir, "documents", "custom-documents"), {
  recursive: true,
});
process.env.STORAGE_DIR = storageDir;
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");

const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `t5s2_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    throw new Error("slice 2 tests require DATABASE_URL pointing at PostgreSQL");
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
  prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
}, 300_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const admin = new PrismaClient({
      datasources: { db: { url: baseDatabaseUrl } },
    });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
  if (storageDir) fs.rmSync(storageDir, { recursive: true, force: true });
}, 60_000);

const repository = require("../../../utils/authorization/policyRepository");
const {
  SERVICE_PRINCIPALS,
} = require("../../../utils/authorization/actorResolver");

const SYS = SERVICE_PRINCIPALS.singleUser;
const READER = "document.read";

let W1;
let roles = {};
const pinned = {};

/** Write the on-disk JSON a pinned document is read from, and return its docpath. */
function writeDocFile(name, pageContent) {
  const docpath = path.join("custom-documents", `${name}.json`);
  fs.writeFileSync(
    path.join(storageDir, "documents", docpath),
    JSON.stringify({
      pageContent,
      token_count_estimate: 10,
      title: name,
    })
  );
  return docpath;
}

beforeAll(async () => {
  for (const name of ["viewer", "super_admin"]) {
    roles[name] = await prisma.roles.findFirstOrThrow({
      where: { name, scope: name === "super_admin" ? "org" : "workspace" },
    });
  }
  W1 = await prisma.workspaces.create({
    data: { name: "w1", slug: `t5s2-w1-${dbSuffix}` },
  });

  // Three pinned documents in the same workspace: one the actor may read, one denied by
  // an explicit document_acl deny, and one whose canonical documentId is still NULL
  // because the canonicalize job has not run.
  for (const key of ["readable", "denied"]) {
    const document = await prisma.documents.create({
      data: {
        orgId: 1,
        filename: `${key}.txt`,
        dedupe_key: `/t5s2/${dbSuffix}/${key}.txt`,
      },
    });
    await prisma.document_acl.create({
      data: {
        orgId: 1,
        document_id: document.id,
        principal_type: "workspace",
        principal_id: String(W1.id),
        action: READER,
        source: "inherited_workspace",
      },
    });
    pinned[key] = await prisma.workspace_documents.create({
      data: {
        docId: crypto.randomUUID(),
        filename: `${key}.txt`,
        docpath: writeDocFile(key, `CONTENT OF ${key.toUpperCase()}`),
        workspaceId: W1.id,
        documentId: document.id,
        pinned: true,
      },
    });
    pinned[`${key}Document`] = document;
  }

  // The pre-canonicalize shape: pinned, but no link to a `documents` row, so no ACL row
  // can possibly refer to it.
  pinned.unlinked = await prisma.workspace_documents.create({
    data: {
      docId: crypto.randomUUID(),
      filename: "unlinked.txt",
      docpath: writeDocFile("unlinked", "CONTENT OF UNLINKED"),
      workspaceId: W1.id,
      documentId: null,
      pinned: true,
    },
  });
});

const { DocumentManager } = require("../../../utils/DocumentManager");
const {
  retrievalFilterFor,
} = require("../../../utils/authorization/retrievalFilter");

async function actorFor(userId) {
  await repository.grantRole({
    actor: SYS,
    principalType: "user",
    principalId: String(userId),
    roleId: roles.viewer.id,
    workspaceId: W1.id,
    db: prisma,
  });
  return { type: "user", id: String(userId), orgId: 1, workspaceIds: [String(W1.id)] };
}

const contentsOf = (docs) => docs.map((doc) => doc.pageContent).sort();

describe("T-5 slice 2: a denied pinned document must not reach the prompt", () => {
  // The filter is built for `document.read`, not `document.search`. A pinned document is
  // not retrieved by a query — it is injected into the prompt wholesale — so the action
  // that governs it is reading it. Asking for `document.search` here would consult a
  // different set of ACL rows and silently miss a read-deny, which is exactly the gap this
  // slice exists to close.

  test("RED: today pinnedDocs returns a document the actor is denied", async () => {
    // The gap, stated as a test. Deny the document outright, then ask for pinned docs the
    // way every chat path does — and it comes back anyway, because this path never
    // consults the ACL at all.
    const actor = await actorFor(9001);
    // Through the repository, NOT a raw insert: a deny must bump the policy version, and
    // the filter cache keys on that version. A raw insert leaves the cache serving a
    // pre-deny filter — which is a realistic bug shape, but not the one under test here.
    await repository.grantDocumentAcl({
      actor: SYS,
      documentId: pinned.deniedDocument.id,
      principalType: "user",
      principalId: "9001",
      action: READER,
      effect: "deny",
      db: prisma,
    });

    const aclFilter = await retrievalFilterFor({ actor, action: READER, db: prisma });
    const docs = await new DocumentManager({
      workspace: W1,
      maxTokens: 10_000,
    }).pinnedDocs({ aclFilter, db: prisma });

    expect(contentsOf(docs)).toContain("CONTENT OF READABLE");
    expect(contentsOf(docs)).not.toContain("CONTENT OF DENIED");
  });

  test("a document with no canonical documentId is UNPROVABLE and excluded by default", async () => {
    // Same rule as an unlabelled vector: the ACL keys on `document_id`, so a pinned row
    // that has none cannot be shown to be readable. "No match found, therefore allow"
    // would make an id mismatch fail open — the inversion that turns a schema slip into a
    // silent leak instead of a visible outage.
    const actor = await actorFor(9002);
    const aclFilter = await retrievalFilterFor({ actor, action: READER, db: prisma });
    const docs = await new DocumentManager({
      workspace: W1,
      maxTokens: 10_000,
    }).pinnedDocs({ aclFilter, db: prisma });

    expect(contentsOf(docs)).not.toContain("CONTENT OF UNLINKED");
  });

  test("the unprovable flag admits it, and only it", async () => {
    const actor = await actorFor(9003);
    await repository.grantDocumentAcl({
      actor: SYS,
      documentId: pinned.deniedDocument.id,
      principalType: "user",
      principalId: "9003",
      action: READER,
      effect: "deny",
      db: prisma,
    });
    const aclFilter = await retrievalFilterFor({ actor, action: READER, db: prisma });

    const previous = process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
    process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
    try {
      const docs = await new DocumentManager({
        workspace: W1,
        maxTokens: 10_000,
      }).pinnedDocs({ aclFilter, db: prisma });
      const contents = contentsOf(docs);
      // Absence of evidence is excused...
      expect(contents).toContain("CONTENT OF UNLINKED");
      // ...evidence of denial is not.
      expect(contents).not.toContain("CONTENT OF DENIED");
    } finally {
      if (previous === undefined)
        delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
      else process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = previous;
    }
  });

  test("pinnedDocs REFUSES to run without a filter", async () => {
    // The same contract queryAuthorized enforces: null is never "no restriction". An
    // optional filter is the shape that let #45's keyKind gap through — correct at every
    // call site that remembers it, silently absent at the one that does not.
    await expect(
      new DocumentManager({ workspace: W1, maxTokens: 10_000 }).pinnedDocs()
    ).rejects.toThrow(/aclFilter/i);
  });

  test("a match-none filter returns nothing at all", async () => {
    const docs = await new DocumentManager({
      workspace: W1,
      maxTokens: 10_000,
    }).pinnedDocs({
      aclFilter: {
        matchNone: true,
        policyVersion: "1",
        orgId: 1,
        deniedDocumentIds: [],
      },
      db: prisma,
    });
    expect(docs).toEqual([]);
  });
});

describe("T-5 slice 2: parsed files require a user", () => {
  const {
    WorkspaceParsedFiles,
  } = require("../../../models/workspaceParsedFiles");

  test("getContextFiles throws when no user is given", async () => {
    // Previously this returned every user's files. An optional security filter is not a
    // filter — it is a filter plus a way to skip it.
    await expect(
      WorkspaceParsedFiles.getContextFiles(W1, null, null)
    ).rejects.toThrow(/user/i);
  });

  test("an explicit system actor gets [] rather than everything", async () => {
    // The escape for a genuinely user-less caller. It returns nothing, which is the safe
    // direction; returning everything is what the missing argument used to do.
    await expect(
      WorkspaceParsedFiles.getContextFiles(W1, null, { systemActor: true })
    ).resolves.toEqual([]);
  });
});

describe("T-5 slice 2: QA-1 mutation survivors", () => {
  // Each of these killed a mutant that the original suite let live. A mutation that
  // survives is a line the tests do not actually constrain — the code could be replaced
  // with something wrong and nothing would go red.

  test("M3: an explicit allow-list excludes a pinned document outside it", async () => {
    // Embed and service actors carry `allowedDocumentIds`. Flipping the allow-list check
    // to allow-all survived, because nothing exercised a pinned document that was NOT on
    // the list — the filter was being applied and never being tested for the case it
    // exists to catch. Same class as #41 NIT-1.
    const aclFilter = {
      orgId: 1,
      principalType: "embed",
      actorId: "embed-1",
      workspaceIds: [String(W1.id)],
      orgWide: false,
      deniedDocumentIds: [],
      // Only the readable document; the "denied" fixture is deliberately absent.
      allowedDocumentIds: [String(pinned.readableDocument.id)],
      attributes: {},
      matchNone: false,
      policyVersion: "1",
    };

    const docs = await new DocumentManager({
      workspace: W1,
      maxTokens: 10_000,
    }).pinnedDocs({ aclFilter, db: prisma });

    const contents = contentsOf(docs);
    expect(contents).toContain("CONTENT OF READABLE");
    // On the list => in. Off the list => out, even with no deny row anywhere.
    expect(contents).not.toContain("CONTENT OF DENIED");
  });

  test("M3b: an EMPTY allow-list returns nothing, not everything", async () => {
    // [] means "allow nothing". Read as "no restriction" it would turn the most
    // restrictive filter into the least — the single most dangerous misreading available
    // in this file.
    const docs = await new DocumentManager({
      workspace: W1,
      maxTokens: 10_000,
    }).pinnedDocs({
      aclFilter: {
        orgId: 1,
        principalType: "embed",
        actorId: "embed-1",
        workspaceIds: [String(W1.id)],
        orgWide: false,
        deniedDocumentIds: [],
        allowedDocumentIds: [],
        attributes: {},
        matchNone: false,
        policyVersion: "1",
      },
      db: prisma,
    });
    expect(docs).toEqual([]);
  });

  test("M8: the bridge asks about document.read, not document.search", async () => {
    // The finding from implementation, now pinned as a test. One document, two ACL rows:
    // ALLOW on document.search, DENY on document.read. A filter built for the wrong action
    // returns the document — and looks completely healthy doing it.
    const document = await prisma.documents.create({
      data: {
        orgId: 1,
        filename: "split-action.txt",
        dedupe_key: `/t5s2/${dbSuffix}/split-action.txt`,
      },
    });
    await prisma.workspace_documents.create({
      data: {
        docId: crypto.randomUUID(),
        filename: "split-action.txt",
        docpath: writeDocFile("split-action", "CONTENT OF SPLIT"),
        workspaceId: W1.id,
        documentId: document.id,
        pinned: true,
      },
    });
    await prisma.document_acl.create({
      data: {
        orgId: 1,
        document_id: document.id,
        principal_type: "workspace",
        principal_id: String(W1.id),
        action: READER,
        source: "inherited_workspace",
      },
    });

    const actor = await actorFor(9101);
    // Allowed to SEARCH it...
    await repository.grantDocumentAcl({
      actor: SYS,
      documentId: document.id,
      principalType: "user",
      principalId: "9101",
      action: "document.search",
      effect: "allow",
      db: prisma,
    });
    // ...denied READING it.
    await repository.grantDocumentAcl({
      actor: SYS,
      documentId: document.id,
      principalType: "user",
      principalId: "9101",
      action: READER,
      effect: "deny",
      db: prisma,
    });

    const readFilter = await retrievalFilterFor({
      actor,
      action: READER,
      db: prisma,
    });
    const withRead = await new DocumentManager({
      workspace: W1,
      maxTokens: 10_000,
    }).pinnedDocs({ aclFilter: readFilter, db: prisma });
    expect(contentsOf(withRead)).not.toContain("CONTENT OF SPLIT");

    // And the proof that the action is what makes the difference: the search filter, which
    // is `retrievalFilterFor`'s DEFAULT, lets it straight through.
    const searchFilter = await retrievalFilterFor({
      actor,
      action: "document.search",
      db: prisma,
    });
    const withSearch = await new DocumentManager({
      workspace: W1,
      maxTokens: 10_000,
    }).pinnedDocs({ aclFilter: searchFilter, db: prisma });
    expect(contentsOf(withSearch)).toContain("CONTENT OF SPLIT");
  });

  test("M8b: the bridge names document.read in its source", async () => {
    // M8 above proves the BEHAVIOUR through the database. This pins the bridge itself,
    // because every call site inherits its choice of action — and `retrievalFilterFor`
    // defaults to `document.search`, so omitting the argument here would silently enforce
    // the wrong question at all ten sites at once.
    //
    // Asserted on the source rather than by mocking: `pinnedContext` destructures
    // `retrievalFilterFor` at import, so a spy on the module object never reaches it.
    const source = require("fs").readFileSync(
      require.resolve("../../../utils/authorization/pinnedContext"),
      "utf-8"
    );
    expect(source).toMatch(/action:\s*"document\.read"/);
    expect(source).not.toMatch(/action:\s*"document\.search"/);
  });
});

describe("T-5 slice 2: a raw ACL write leaves caches stale", () => {
  // Not a test-only trap. `FilterCache` keys on the policy version, and only the
  // repository bumps it — so ANY write that reaches document_acl directly leaves every
  // cached filter serving pre-change policy, for the whole TTL, across the process.
  // This cost me a debugging detour during implementation; it would cost a stale
  // permission decision in production.
  const {
    FilterCache,
  } = require("../../../utils/authorization/cache");

  test("M7: a repository write is visible to a fresh filter", async () => {
    const document = await prisma.documents.create({
      data: {
        orgId: 1,
        filename: "cache-repo.txt",
        dedupe_key: `/t5s2/${dbSuffix}/cache-repo.txt`,
      },
    });
    const actor = await actorFor(9201);
    const before = await retrievalFilterFor({
      actor,
      action: READER,
      db: prisma,
    });

    await repository.grantDocumentAcl({
      actor: SYS,
      documentId: document.id,
      principalType: "user",
      principalId: "9201",
      action: READER,
      effect: "deny",
      db: prisma,
    });

    const cache = new FilterCache({ db: prisma });
    // The version moved, so the earlier filter is now stale — which is exactly what makes
    // a cached filter safe to hold: it can always tell.
    expect(await cache.isStale(before, prisma)).toBe(true);
  });

  test("M7b: a RAW write does not move the clock, so a stale filter looks fresh", async () => {
    const document = await prisma.documents.create({
      data: {
        orgId: 1,
        filename: "cache-raw.txt",
        dedupe_key: `/t5s2/${dbSuffix}/cache-raw.txt`,
      },
    });
    const actor = await actorFor(9202);
    const before = await retrievalFilterFor({
      actor,
      action: READER,
      db: prisma,
    });

    // The mistake, written out: bypassing the repository.
    await prisma.document_acl.create({
      data: {
        orgId: 1,
        document_id: document.id,
        principal_type: "user",
        principal_id: "9202",
        action: READER,
        effect: "deny",
        source: "manual",
      },
    });

    const cache = new FilterCache({ db: prisma });
    // Still "fresh" — the deny exists in the database and no cache anywhere will notice.
    expect(await cache.isStale(before, prisma)).toBe(false);
  });
});

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
fs.mkdirSync(path.join(storageDir, "direct-uploads"), { recursive: true });
process.env.STORAGE_DIR = storageDir;
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");

const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `t5s2_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

// Point the PROCESS at the test database before any application module is required.
//
// Models reach for the `utils/prisma` singleton rather than accepting a client, and that
// singleton reads DATABASE_URL once at import. Passing `db: prisma` covers the code that
// takes an injected client; `getContextFiles` does not. Without this, a row seeded through
// the suite's client is invisible to the model under test, and an assertion about a filter
// silently becomes an assertion that the table is empty — which is exactly how QA-1's M7
// mutant survived.
//
// `baseDatabaseUrl` is kept for the admin connection that creates and drops the database.
if (testUrl) process.env.DATABASE_URL = testUrl;

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
    //
    // QA-1 M7: this assertion was VACUOUS before. W1 held no parsed files at all, so []
    // came back whether the systemActor branch existed or not — removing the line left
    // the suite green while `where({userId: undefined})` really did return another user's
    // rows. An assertion about a filter has to be made against data the filter must
    // exclude, or it is only asserting that the fixture is empty.
    const owner = await prisma.users.create({
      data: { username: `parsed-owner-${dbSuffix}`, password: "x" },
    });
    const location = `parsed-${dbSuffix}.json`;
    fs.writeFileSync(
      path.join(storageDir, "direct-uploads", location),
      JSON.stringify({ pageContent: "CONTENT OF SOMEONE ELSE'S UPLOAD" })
    );
    await prisma.workspace_parsed_files.create({
      data: {
        filename: `parsed-${dbSuffix}.txt`,
        workspaceId: W1.id,
        userId: owner.id,
        metadata: JSON.stringify({ location, title: "someone else's upload" }),
        tokenCountEstimate: 10,
      },
    });

    // The positive control: the owner DOES get their file. Without it, a getContextFiles
    // that returned [] for everyone would pass the assertion below and prove nothing.
    const theirs = await WorkspaceParsedFiles.getContextFiles(W1, null, owner);
    expect(theirs.map((file) => file.pageContent)).toEqual([
      "CONTENT OF SOMEONE ELSE'S UPLOAD",
    ]);

    // And the system actor gets nothing — with a row present that it would otherwise see.
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

describe("T-5 slice 2: pinned scope comes from the FILTER, not from the URL", () => {
  // Techlead-2 BLOCKER, proven against real PostgreSQL. `pinnedDocs` read only the deny
  // and allow lists, so the workspace it fetched from was whichever one the REQUEST
  // addressed. The consequence, end to end:
  //
  //   a viewer of workspace A  ->  POST /workspace/<B's slug>/stream-chat
  //
  // `chat.send` is held org-wide, and validWorkspaceSlug is a LOADER rather than a gate
  // (T-4a made that deliberate), so the request reaches the handler. The vector path then
  // filtered correctly while this one handed back every pinned document in B, whole, in
  // both the prompt and the citations.
  //
  // A deny list cannot close this. There is no deny row for a document in a workspace the
  // actor was never supposed to reach — the absence of a deny is not evidence of a grant.
  // Only the filter's POSITIVE scope carries that, which is why it must be read.

  let W2;
  let outsider;

  beforeAll(async () => {
    W2 = await prisma.workspaces.create({
      data: { name: "w2", slug: `t5s2-w2-${dbSuffix}` },
    });
    const document = await prisma.documents.create({
      data: {
        orgId: 1,
        filename: "w2-secret.txt",
        dedupe_key: `/t5s2/${dbSuffix}/w2-secret.txt`,
      },
    });
    // Pinned in W2, and readable BY W2 — a perfectly ordinary document. Nothing about it
    // is denied; it simply belongs to a workspace the actor is not in.
    await prisma.document_acl.create({
      data: {
        orgId: 1,
        document_id: document.id,
        principal_type: "workspace",
        principal_id: String(W2.id),
        action: READER,
        source: "inherited_workspace",
      },
    });
    await prisma.workspace_documents.create({
      data: {
        docId: crypto.randomUUID(),
        filename: "w2-secret.txt",
        docpath: writeDocFile("w2-secret", "CONTENT OF W2 SECRET"),
        workspaceId: W2.id,
        documentId: document.id,
        pinned: true,
      },
    });
    // Scope is W1 only. This is what `retrievalFilterFor` produces for a viewer of W1.
    outsider = await actorFor(9301);
  });

  test("RED: an actor scoped to W1 gets nothing from W2, with no deny row anywhere", async () => {
    const aclFilter = await retrievalFilterFor({
      actor: outsider,
      action: READER,
      db: prisma,
    });
    // The filter is healthy and permissive — it is not match-none, and it denies nothing.
    // That is the point: every field this path used to read says "allow".
    expect(aclFilter.matchNone).toBe(false);
    expect(aclFilter.deniedDocumentIds ?? []).toEqual([]);
    expect(aclFilter.workspaceIds.map(String)).not.toContain(String(W2.id));

    const docs = await new DocumentManager({
      workspace: W2,
      maxTokens: 10_000,
    }).pinnedDocs({ aclFilter, db: prisma });

    expect(docs).toEqual([]);
  });

  test("the actor's OWN workspace still works — this is a scope check, not a blanket refusal", async () => {
    // The boundary. A scope check that returned [] for everything would pass the test
    // above and break every chat in the product.
    const aclFilter = await retrievalFilterFor({
      actor: outsider,
      action: READER,
      db: prisma,
    });
    const docs = await new DocumentManager({
      workspace: W1,
      maxTokens: 10_000,
    }).pinnedDocs({ aclFilter, db: prisma });

    expect(contentsOf(docs)).toContain("CONTENT OF READABLE");
  });

  test("an orgWide actor reads across workspaces, but only inside its own org", async () => {
    // orgWide means "every workspace in YOUR org" (T-4a's rule, restated by documentFilter
    // readableScope), so it legitimately passes the workspace check — and is still held to
    // the org check underneath it.
    const orgWideFilter = {
      orgId: 1,
      principalType: "service",
      actorId: "svc-1",
      workspaceIds: [],
      orgWide: true,
      deniedDocumentIds: [],
      attributes: {},
      matchNone: false,
      policyVersion: "1",
    };
    const docs = await new DocumentManager({
      workspace: W2,
      maxTokens: 10_000,
    }).pinnedDocs({ aclFilter: orgWideFilter, db: prisma });
    expect(contentsOf(docs)).toContain("CONTENT OF W2 SECRET");

    // Same filter shape, different tenant: orgWide is not cross-org.
    const otherOrg = await new DocumentManager({
      workspace: W2,
      maxTokens: 10_000,
    }).pinnedDocs({
      aclFilter: { ...orgWideFilter, orgId: 2 },
      db: prisma,
    });
    expect(otherOrg).toEqual([]);
  });

  test("a document whose org cannot be read is unprovable, not admitted", async () => {
    // The canonicalize job has not linked this row, so there is no `documents` row to take
    // an orgId from. Same rule as an unlabelled vector (S-26/G4): unknown is not "yours".
    const aclFilter = await retrievalFilterFor({
      actor: await actorFor(9302),
      action: READER,
      db: prisma,
    });
    const docs = await new DocumentManager({
      workspace: W1,
      maxTokens: 10_000,
    }).pinnedDocs({ aclFilter, db: prisma });
    expect(contentsOf(docs)).not.toContain("CONTENT OF UNLINKED");
  });
});

describe("T-5 slice 3: what an operator is told about excluded pinned documents", () => {
  // Techlead-2 E2 + QA-2. A refusal that produces no signal is indistinguishable from an
  // empty workspace, so the counts are the difference between an operator who can act and
  // one who never learns there was anything to act on.

  test("E2: an org mismatch is COUNTED and reported, not silently dropped", async () => {
    // A workspace holding another org's document is either a cross-tenant attempt or a
    // data fault. Either way somebody needs to know; before this it returned `false` and
    // said nothing.
    const foreign = await prisma.documents.create({
      data: {
        orgId: 2,
        filename: "foreign-org.txt",
        dedupe_key: `/t5s3/${dbSuffix}/foreign-org.txt`,
      },
    });
    await prisma.workspace_documents.create({
      data: {
        docId: crypto.randomUUID(),
        filename: "foreign-org.txt",
        docpath: writeDocFile("foreign-org", "CONTENT OF FOREIGN ORG"),
        workspaceId: W1.id,
        documentId: foreign.id,
        pinned: true,
      },
    });

    const logs = [];
    const manager = new DocumentManager({ workspace: W1, maxTokens: 10_000 });
    jest.spyOn(manager, "log").mockImplementation((text) => logs.push(text));

    const docs = await manager.pinnedDocs({
      aclFilter: await retrievalFilterFor({
        actor: await actorFor(9401),
        action: READER,
        db: prisma,
      }),
      db: prisma,
    });

    expect(contentsOf(docs)).not.toContain("CONTENT OF FOREIGN ORG");
    // The two counts are reported SEPARATELY. The shared fixture also has an unlinked row,
    // so the canonicalize message legitimately appears too — what must not happen is the
    // org mismatch being folded into it, since the remedies differ (investigate a tenancy
    // fault vs. run a job).
    const mismatch = logs.find((line) => /DIFFERENT org/i.test(line));
    expect(mismatch).toBeDefined();
    // The count itself, so "1 document" cannot degrade into "some documents".
    expect(mismatch).toMatch(/\b1 pinned document/);
    // The mismatch line carries its own remedy, not the canonicalize one.
    expect(mismatch).not.toMatch(/canonicalize job/i);
    expect(mismatch).toMatch(/cross-tenant|data fault/i);
  });

  test("E2: the org-mismatch report appears even with the unprovable flag SET", async () => {
    // The flag excuses absence of evidence, never evidence of a mismatch. If the report
    // were gated on the flag the way the unprovable one is, setting it would silence the
    // more serious of the two signals.
    const original = process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
    process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
    try {
      const logs = [];
      const manager = new DocumentManager({ workspace: W1, maxTokens: 10_000 });
      jest.spyOn(manager, "log").mockImplementation((text) => logs.push(text));
      await manager.pinnedDocs({
        aclFilter: await retrievalFilterFor({
          actor: await actorFor(9402),
          action: READER,
          db: prisma,
        }),
        db: prisma,
      });
      expect(logs.join("\n")).toMatch(/DIFFERENT org/i);
    } finally {
      if (original === undefined)
        delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
      else process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = original;
    }
  });

  test("QA-2: a row whose org cannot be read follows the flag in BOTH directions", async () => {
    // `rowOrgId == null` — the document row exists but its org is unreadable. That is
    // absence of evidence, so it obeys the flag, unlike the mismatch above. Asserting only
    // one direction would let an inert flag pass, which is the slice 1a lesson.
    const orphan = await prisma.workspace_documents.create({
      data: {
        docId: crypto.randomUUID(),
        filename: "no-org.txt",
        docpath: writeDocFile("no-org", "CONTENT OF NO ORG"),
        workspaceId: W1.id,
        // No canonical link, so the joined `document` is null and orgId is unreadable.
        documentId: null,
        pinned: true,
      },
    });
    expect(orphan.documentId).toBeNull();

    const aclFilter = await retrievalFilterFor({
      actor: await actorFor(9403),
      action: READER,
      db: prisma,
    });
    const read = async () =>
      contentsOf(
        await new DocumentManager({ workspace: W1, maxTokens: 10_000 }).pinnedDocs({
          aclFilter,
          db: prisma,
        })
      );

    const original = process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
    try {
      delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
      expect(await read()).not.toContain("CONTENT OF NO ORG");

      process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
      expect(await read()).toContain("CONTENT OF NO ORG");
    } finally {
      if (original === undefined)
        delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
      else process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = original;
    }
  });
});

describe("T-5 slice 3: the pinned bridge picks document.read by BEHAVIOUR", () => {
  // QA-1 NIT-1 on slice 2: M8b greps the source for `action: "document.read"`, so it is
  // tied to the spelling rather than to the effect — a change that kept the string and
  // altered the behaviour would pass. This drives the bridge instead.
  //
  // M8b stays: the grep catches an accidental edit to the string, this catches a wrong
  // action being chosen. Different failures, different tests.

  test("a document ALLOWED on search but DENIED on read does not reach the prompt", async () => {
    const document = await prisma.documents.create({
      data: {
        orgId: 1,
        filename: "split-action-bridge.txt",
        dedupe_key: `/t5s3/${dbSuffix}/split-action-bridge.txt`,
      },
    });
    await prisma.workspace_documents.create({
      data: {
        docId: crypto.randomUUID(),
        filename: "split-action-bridge.txt",
        docpath: writeDocFile("split-action-bridge", "CONTENT OF SPLIT BRIDGE"),
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

    // A REAL user row: the bridge resolves `{id}` through actorResolver against the
    // database, so a synthetic id resolves to no principal and yields a match-none filter.
    // That would make the "denied" assertion below pass for entirely the wrong reason —
    // which is what the positive control caught.
    const person = await prisma.users.create({
      data: { username: `split-bridge-${dbSuffix}`, password: "x" },
    });
    const userId = person.id;
    await actorFor(userId);
    await repository.grantDocumentAcl({
      actor: SYS,
      documentId: document.id,
      principalType: "user",
      principalId: String(userId),
      action: "document.search",
      effect: "allow",
      db: prisma,
    });
    await repository.grantDocumentAcl({
      actor: SYS,
      documentId: document.id,
      principalType: "user",
      principalId: String(userId),
      action: READER,
      effect: "deny",
      db: prisma,
    });

    const {
      authorizedPinnedDocs,
    } = require("../../../utils/authorization/pinnedContext");
    const docs = await authorizedPinnedDocs({
      workspace: W1,
      user: { id: userId },
      maxTokens: 10_000,
      db: prisma,
    });

    // If the bridge asked about `document.search` this would come back: the search grant
    // allows it. Only asking about `document.read` excludes it.
    expect(contentsOf(docs)).not.toContain("CONTENT OF SPLIT BRIDGE");
    // Positive control: the bridge is not simply returning nothing.
    expect(contentsOf(docs)).toContain("CONTENT OF READABLE");
  });
});

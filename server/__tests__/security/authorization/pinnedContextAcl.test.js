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

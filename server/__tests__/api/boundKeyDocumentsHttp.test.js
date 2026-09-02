/**
 * #41: a workspace-bound API key must not reach another workspace's documents.
 *
 * Document storage is one global namespace on disk. Fifteen /v1 routes carry a slug and
 * are bound by the scope middleware; seven document routes carry no workspace at all, so
 * `validApiKey` treats them as org-level questions and the middleware cannot refuse them.
 * Nothing else did either: a key issued for workspace A listed, read, moved and deleted
 * workspace B's documents. QA-2 reproduced it on 4c32bce3 (Q41-1..4 returned 200).
 *
 * Driven against a real database and real files on disk rather than mocks, because the
 * fix is a join between what is on disk and what `workspace_documents` says — a mocked
 * store would answer whatever the test told it to and prove neither half.
 *
 * Every case has an unbound-key control. Without it a 403/404/empty-list is equally
 * consistent with a route that refuses everyone.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { PG_SCHEME } = require("../../utils/test/postgresUrl");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bound-docs-"));
const schema = `bound_docs_${process.pid}`;
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-at-least-12-chars";
process.env.AUTH_TOKEN = "single-user-test-password";
process.env.API_KEY_PEPPER = "bound-docs-test-pepper-32-bytes-x";
process.env.STORAGE_DIR = path.join(tempDir, "storage");
const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
  throw new Error("DATABASE_URL must point to PostgreSQL for HTTP tests");
const databaseUrl = new URL(baseDatabaseUrl);
databaseUrl.searchParams.set("schema", schema);
process.env.DATABASE_URL = databaseUrl.toString();
fs.mkdirSync(process.env.STORAGE_DIR, { recursive: true });

const testSchema = path.resolve(__dirname, "../../prisma/schema.prisma");
execFileSync(
  path.resolve(__dirname, "../../node_modules/.bin/prisma"),
  // §7.1a: migrate deploy, not db push — the seeded roles and permissions the grant
  // half reads are migration INSERTs.
  ["migrate", "deploy", "--schema", testSchema],
  { cwd: path.resolve(__dirname, "../.."), env: process.env, stdio: "ignore" }
);

jest.mock("../../utils/logger", () => () => {});
jest.mock("../../utils/boot", () => ({ bootHTTP: jest.fn(), bootSSL: jest.fn() }));
jest.mock("../../utils/boot/patchSdkTimeouts", () => jest.fn());
jest.mock("../../utils/AiProviders/modelMap", () => ({
  MODEL_MAP: { get: jest.fn(() => null) },
}));
jest.mock("../../utils/helpers/modelPricing", () => ({
  addChatCostToMetrics: jest.fn((metrics) => metrics),
}));
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn(), flush: jest.fn() },
}));
jest.mock("../../utils/helpers", () => ({
  ...jest.requireActual("../../utils/helpers"),
  // Attaching a document embeds it, so the write-half tests reach the vector driver.
  // Stubbed rather than run: what those tests assert is the workspace_documents row and
  // the listing, and a real embedder would make them a test of the embedder instead.
  getVectorDbClass: jest.fn(() => ({
    name: "fake-vector-db",
    namespaceCount: jest.fn(async () => 0),
    hasNamespace: jest.fn(async () => true),
    addDocumentToNamespace: jest.fn(async () => ({ vectorized: true, error: null })),
    deleteDocumentFromNamespace: jest.fn(async () => true),
  })),
  resolveProviderConnector: jest.fn(async () => ({
    connector: {},
    routingMetadata: null,
  })),
}));
// #41 write half: the raw-text route is the one upload path that needs no multipart
// body and no file on disk, so it is the one that can be driven end to end here. The
// collector is stubbed to "process" the text into a real file under STORAGE_DIR — the
// same place viewLocalFiles reads — so the upload and the listing meet on disk exactly
// as they do in production.
jest.mock("../../utils/collectorApi", () => {
  const fs = require("fs");
  const path = require("path");
  return {
    CollectorApi: jest.fn().mockImplementation(() => ({
      online: jest.fn(async () => true),
      log: jest.fn(),
      processRawText: jest.fn(async (textContent, metadata) => {
        const filename = `${metadata.title}.json`;
        const folder = path.join(process.env.STORAGE_DIR, "documents", "custom-documents");
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(
          path.join(folder, filename),
          JSON.stringify({
            id: `raw-${metadata.title}`,
            url: "file://raw",
            title: metadata.title,
            docAuthor: "test",
            description: "raw",
            docSource: "test",
            chunkSource: metadata.title,
            published: new Date().toISOString(),
            wordCount: 1,
            pageContent: textContent,
            token_count_estimate: 1,
          })
        );
        return {
          success: true,
          reason: null,
          documents: [{ location: `custom-documents/${filename}`, title: metadata.title }],
        };
      }),
    })),
  };
});
jest.mock("../../utils/boot/MetaGenerator", () => ({
  MetaGenerator: jest.fn().mockImplementation(() => ({
    generate: jest.fn(),
    generateManifest: jest.fn(),
  })),
}));

const { CommunicationKey } = require("../../utils/comKey");
new CommunicationKey(true);

const request = require("supertest");
const bcrypt = require("bcryptjs");
const prisma = require("../../utils/prisma");
const { app } = require("../../index");
const { digestSecret, keyPrefix } = require("../../utils/apiKeySecurity");
const repository = require("../../utils/authorization/policyRepository");
const { SERVICE_PRINCIPALS } = require("../../utils/authorization/actorResolver");

const SYS = SERVICE_PRINCIPALS.singleUser;
const FOLDER = "custom-documents";
const A_DOC = "workspace-a-secret.json";
const B_DOC = "workspace-b-secret.json";
const BOUND_SECRET = "apw-key-bound-a-AAAAAAAAAAAAAAAAAAAAAAAA";
const UNBOUND_SECRET = "apw-key-unbound-AAAAAAAAAAAAAAAAAAAAAAAA";
const BOUND_B_SECRET = "apw-key-bound-b-AAAAAAAAAAAAAAAAAAAAAAAA";

const bound = (req) => req.set("Authorization", `Bearer ${BOUND_SECRET}`);
const unbound = (req) => req.set("Authorization", `Bearer ${UNBOUND_SECRET}`);
/** A key bound to workspace B — the other tenant's view of the same storage. */
const boundToB = (req) => req.set("Authorization", `Bearer ${BOUND_B_SECRET}`);

let workspaceA;
let workspaceB;
let creator;

/** Writes a document to disk exactly as the collector does, and attaches it. */
async function seedDocument(filename, workspace) {
  const folderPath = path.join(process.env.STORAGE_DIR, "documents", FOLDER);
  fs.mkdirSync(folderPath, { recursive: true });
  fs.writeFileSync(
    path.join(folderPath, filename),
    JSON.stringify({
      id: `doc-${filename}`,
      url: `file://${filename}`,
      title: filename,
      docAuthor: "test",
      description: "seeded",
      docSource: "test",
      chunkSource: filename,
      published: new Date().toISOString(),
      wordCount: 2,
      pageContent: `contents of ${filename}`,
      token_count_estimate: 2,
    })
  );
  if (!workspace) return; // orphan: on disk, attached to nobody
  await prisma.workspace_documents.create({
    data: {
      docId: `docid-${filename}`,
      filename,
      docpath: `${FOLDER}/${filename}`,
      workspaceId: workspace.id,
    },
  });
}

beforeAll(async () => {
  const roleRows = await prisma.roles.findMany({ select: { id: true, name: true, scope: true } });
  const roles = Object.fromEntries(roleRows.map((r) => [`${r.name}:${r.scope}`, r.id]));

  creator = await prisma.users.create({
    data: {
      username: "bound-docs-admin",
      password: bcrypt.hashSync("Pw123456!", 10),
      role: "admin",
    },
  });
  await repository.grantRole({
    actor: SYS, principalType: "user", principalId: String(creator.id),
    roleId: roles["super_admin:org"], db: prisma,
  });

  [workspaceA, workspaceB] = await Promise.all(
    ["bound-ws-a", "bound-ws-b"].map((slug) =>
      prisma.workspaces.create({ data: { name: slug, slug } })
    )
  );
  await prisma.workspace_users.create({
    data: { user_id: creator.id, workspace_id: workspaceA.id },
  });

  await seedDocument(A_DOC, workspaceA);
  await seedDocument(B_DOC, workspaceB);

  // Both keys carry the SAME scopes and the SAME creator. The only difference is the
  // binding, so a difference in outcome can only come from the binding.
  const scopes = JSON.stringify([
    "document.read",
    "document.write",
    "document.folder.manage",
    "document.delete",
  ]);
  await prisma.api_keys.createMany({
    data: [
      {
        name: "bound", secretDigest: digestSecret(BOUND_SECRET),
        keyPrefix: keyPrefix(BOUND_SECRET), scopes,
        createdBy: creator.id, workspaceId: workspaceA.id,
      },
      {
        name: "unbound", secretDigest: digestSecret(UNBOUND_SECRET),
        keyPrefix: keyPrefix(UNBOUND_SECRET), scopes, createdBy: creator.id,
      },
      {
        name: "bound-b", secretDigest: digestSecret(BOUND_B_SECRET),
        keyPrefix: keyPrefix(BOUND_B_SECRET), scopes,
        createdBy: creator.id, workspaceId: workspaceB.id,
      },
    ],
  });

  await prisma.system_settings.upsert({
    where: { label: "multi_user_mode" },
    update: { value: "true" },
    create: { label: "multi_user_mode", value: "true" },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const namesIn = (localFiles) =>
  (localFiles?.items ?? []).flatMap((folder) => (folder.items ?? []).map((d) => d.name));

describe("Q41-1: GET /v1/documents", () => {
  it("a bound key sees only its own workspace's documents", async () => {
    const response = await bound(request(app).get("/api/v1/documents"));

    expect(response.status).toBe(200);
    const names = namesIn(response.body.localFiles);
    expect(names).toContain(A_DOC);
    expect(names).not.toContain(B_DOC);
  });

  it("an unbound key still sees both (positive control)", async () => {
    const response = await unbound(request(app).get("/api/v1/documents"));

    expect(response.status).toBe(200);
    const names = namesIn(response.body.localFiles);
    expect(names).toEqual(expect.arrayContaining([A_DOC, B_DOC]));
  });
});

describe("Q41-2: GET /v1/documents/folder/:folderName", () => {
  it("a bound key sees only its own documents in the folder", async () => {
    const response = await bound(
      request(app).get(`/api/v1/documents/folder/${FOLDER}`)
    );

    expect(response.status).toBe(200);
    const names = response.body.documents.map((d) => d.name);
    expect(names).toContain(A_DOC);
    expect(names).not.toContain(B_DOC);
  });

  it("an unbound key sees both (positive control)", async () => {
    const response = await unbound(
      request(app).get(`/api/v1/documents/folder/${FOLDER}`)
    );

    expect(response.status).toBe(200);
    const names = response.body.documents.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining([A_DOC, B_DOC]));
  });
});

describe("Q41-3: GET /v1/document/:docName", () => {
  it("a bound key reading another workspace's document gets 404, not 403", async () => {
    // §3.4: a document name is a user-chosen slug. A 403 would confirm the document
    // exists somewhere in the deployment, which is the thing the binding hides.
    const response = await bound(request(app).get(`/api/v1/document/${B_DOC}`));

    expect(response.status).toBe(404);
  });

  it("the same 404 as a document that does not exist at all", async () => {
    // The two answers must be indistinguishable, or the status code is the oracle.
    const missing = await bound(
      request(app).get("/api/v1/document/no-such-document.json")
    );
    const forbidden = await bound(request(app).get(`/api/v1/document/${B_DOC}`));

    expect(missing.status).toBe(forbidden.status);
    expect(missing.text).toBe(forbidden.text);
  });

  it("a bound key reads its own document", async () => {
    const response = await bound(request(app).get(`/api/v1/document/${A_DOC}`));

    expect(response.status).toBe(200);
    expect(response.body.document.name).toBe(A_DOC);
  });

  it("the response never carries the internal docpath", async () => {
    // The join key is added to the finder's return for the comparison above; leaking
    // it would hand a bound key the folder layout it is being kept out of.
    const response = await bound(request(app).get(`/api/v1/document/${A_DOC}`));

    expect(response.body.document.docpath).toBeUndefined();
  });

  it("an unbound key reads both (positive control)", async () => {
    expect((await unbound(request(app).get(`/api/v1/document/${A_DOC}`))).status).toBe(200);
    expect((await unbound(request(app).get(`/api/v1/document/${B_DOC}`))).status).toBe(200);
  });
});

describe("Q41-4: folder mutation and generated files refuse a bound key", () => {
  const CASES = [
    ["post", "/api/v1/document/create-folder", { name: "new-folder" }],
    ["delete", "/api/v1/document/remove-folder", { name: FOLDER }],
    [
      "post",
      "/api/v1/document/move-files",
      { files: [{ from: `${FOLDER}/${B_DOC}`, to: `other/${B_DOC}` }] },
    ],
  ];

  it.each(CASES)("%s %s is refused", async (method, route, body) => {
    const response = await bound(request(app)[method](route)).send(body);

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Insufficient scope." });
  });

  it("generated files are refused: the store has no owner to compare against", async () => {
    // Files land flat in $STORAGE_DIR/generated-files with no database row, so there is
    // nothing a binding could be checked against. PMO ruling: refuse, same class as the
    // folder routes. A per-file owner is tracked separately.
    const response = await bound(
      request(app).get("/api/v1/document/generated-files/pptx-11111111-2222-3333-4444-555555555555.pptx")
    );

    expect(response.status).toBe(403);
  });

  it("an unbound key still reaches these routes (positive control)", async () => {
    // 403 above must come from the binding, not from a route that refuses everyone.
    const created = await unbound(
      request(app).post("/api/v1/document/create-folder")
    ).send({ name: "unbound-made-this" });
    expect(created.status).not.toBe(403);

    const generated = await unbound(
      request(app).get("/api/v1/document/generated-files/pptx-11111111-2222-3333-4444-555555555555.pptx")
    );
    // 404 because the file does not exist — but it got past the guard, which is the point.
    expect(generated.status).toBe(404);
  });
});

describe("orphans: on disk, attached to nobody", () => {
  const ORPHAN = "nobodys-document.json";

  beforeAll(() => seedDocument(ORPHAN, null));

  it("a bound key does not see an unattached document", async () => {
    // Strict join (PMO ruling): storage is shared, so "not yet attached" is not the
    // same as "mine". Treating orphans as visible would let one tenant read whatever
    // another had uploaded but not yet embedded.
    const response = await bound(request(app).get("/api/v1/documents"));

    expect(namesIn(response.body.localFiles)).not.toContain(ORPHAN);
  });

  it("an unbound key does see it (positive control)", async () => {
    const response = await unbound(request(app).get("/api/v1/documents"));

    expect(namesIn(response.body.localFiles)).toContain(ORPHAN);
  });
});

describe("the grant half is read at request time, not at mint time", () => {
  it("revoking the creator's role refuses the key immediately", async () => {
    // #54 overlap check. The key's scopes and binding do not change here — only the
    // creator's grant does. A key that kept working would mean the grant was captured
    // when the key was minted rather than evaluated per request.
    //
    // The revoked thing is the ROLE grant, not workspace membership. These document
    // routes carry no workspace in the path, so the engine evaluates them against the
    // org (`workspace_id: null`) and an org-wide grant answers regardless of which
    // workspaces its holder belongs to. Membership narrows workspace-bearing resources;
    // it is not what authorizes an org-level read, and a test that revoked membership
    // here would assert a rule the engine does not have.
    const before = await bound(request(app).get(`/api/v1/document/${A_DOC}`));
    expect(before.status).toBe(200);

    await prisma.principal_role_grants.deleteMany({
      where: { principal_type: "user", principal_id: String(creator.id) },
    });

    const after = await bound(request(app).get(`/api/v1/document/${A_DOC}`));
    expect(after.status).toBe(403);

    // Restore, and prove the restore is what brings it back — otherwise the 403 above
    // could be any lasting side effect rather than the grant.
    const roleRows = await prisma.roles.findMany({ select: { id: true, name: true, scope: true } });
    const roles = Object.fromEntries(roleRows.map((r) => [`${r.name}:${r.scope}`, r.id]));
    await repository.grantRole({
      actor: SYS, principalType: "user", principalId: String(creator.id),
      roleId: roles["super_admin:org"], db: prisma,
    });
    expect((await bound(request(app).get(`/api/v1/document/${A_DOC}`))).status).toBe(200);
  });

  it("workspace membership is NOT what authorizes these org-level routes", async () => {
    // Stated as a test rather than a comment because it is the surprising half: removing
    // the creator from workspace A leaves the key working, and someone reading the
    // binding rules would reasonably expect otherwise. What keeps the key out of
    // workspace B is the strict document join, not membership.
    await prisma.workspace_users.deleteMany({
      where: { user_id: creator.id, workspace_id: workspaceA.id },
    });

    expect((await bound(request(app).get(`/api/v1/document/${A_DOC}`))).status).toBe(200);
    // ...and the cross-tenant refusal still holds without membership.
    expect((await bound(request(app).get(`/api/v1/document/${B_DOC}`))).status).toBe(404);

    await prisma.workspace_users.create({
      data: { user_id: creator.id, workspace_id: workspaceA.id },
    });
  });
});

describe("the write half: a bound key's upload attaches to its own workspace", () => {
  const rawText = (secret, title) =>
    request(app)
      .post("/api/v1/document/raw-text")
      .set("Authorization", `Bearer ${secret}`)
      .send({ textContent: "hello", metadata: { title } });

  it("uploading without naming a workspace makes the document visible to that key", async () => {
    // The regression that ties both halves together. Under the strict join alone, a
    // bound key uploads a document, the document is attached to nobody, and the very
    // next listing hides it — the key cannot see or delete what it just created.
    const title = "bound-upload-visible";
    const upload = await rawText(BOUND_SECRET, title);
    expect({ status: upload.status, body: upload.body }).toMatchObject({
      status: 200,
      body: { success: true },
    });

    const listing = await bound(request(app).get("/api/v1/documents"));
    expect(namesIn(listing.body.localFiles)).toContain(`${title}.json`);
  });

  it("and the document is attached to the bound workspace, not left an orphan", async () => {
    // Asserting the row, not just the listing: a listing that included orphans would
    // pass the case above while leaving the document shared between tenants.
    const row = await prisma.workspace_documents.findFirst({
      where: { docpath: `${FOLDER}/bound-upload-visible.json` },
      select: { workspaceId: true },
    });
    expect(row?.workspaceId).toBe(workspaceA.id);
  });

  it("another workspace's bound key still cannot see it", async () => {
    const listing = await boundToB(request(app).get("/api/v1/documents"));
    expect(namesIn(listing.body.localFiles)).not.toContain("bound-upload-visible.json");
  });

  it("an unbound key's upload is left unattached, as before", async () => {
    // Unbound behaviour must not change: naming no workspace has always meant
    // "upload only", and attaching it somewhere would be inventing a placement.
    const title = "unbound-upload-unattached";
    const upload = await rawText(UNBOUND_SECRET, title);
    expect(upload.status).toBe(200);

    const row = await prisma.workspace_documents.findFirst({
      where: { docpath: `${FOLDER}/${title}.json` },
    });
    expect(row).toBeNull();
  });

  it("a failed attach reports failure rather than a silent success", async () => {
    // The document is on disk but attached to nothing, so under the strict join the
    // caller can neither see nor delete it. A 200 saying success:true would describe a
    // working upload that has actually produced an unreachable orphan.
    const spy = jest
      .spyOn(prisma.workspaces, "findUnique")
      .mockRejectedValueOnce(new Error("workspaces table unavailable"));

    const upload = await rawText(BOUND_SECRET, "attach-fails");

    expect(upload.status).toBe(500);
    expect(upload.body.success).toBe(false);
    expect(upload.body.error).toMatch(/not attached/i);
    spy.mockRestore();
  });

  it("all four upload routes go through the same attach helper", () => {
    // The other three take multipart bodies or reach the network, so they are covered
    // structurally rather than driven: what matters is that none of them kept the old
    // `if (!!addToWorkspaces)` shape, which is what left the hole on the write side.
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../endpoints/api/document/index.js"),
      "utf8"
    );
    expect(source.match(/await attachTargets\(/g) ?? []).toHaveLength(4);
    expect(source).not.toMatch(/if \(!!addToWorkspaces\)/);
  });
});

describe("QA-1: a bound key naming another tenant's workspace is refused", () => {
  // `attachTargets` returns an explicitly-named list untouched, relying on
  // `validateWorkspaceSlugQuery` having already refused anything outside the binding.
  // That reliance is the thing worth testing: if the middleware were reordered off any
  // of these routes, attachTargets would happily attach across tenants and nothing else
  // would notice.
  const CASES = [
    ["/api/v1/document/raw-text", { textContent: "x", metadata: { title: "cross-raw" } }],
    ["/api/v1/document/upload-link", { link: "https://example.com" }],
    ["/api/v1/document/upload", {}],
    ["/api/v1/document/upload/some-folder", {}],
  ];

  it.each(CASES)("POST %s is refused", async (route, body) => {
    const response = await request(app)
      .post(route)
      .set("Authorization", `Bearer ${BOUND_SECRET}`)
      .send({ ...body, addToWorkspaces: workspaceB.slug });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Insufficient scope." });
  });

  it("and naming its own workspace is allowed", async () => {
    // Positive control: the 403s above come from the slug being another tenant's, not
    // from `addToWorkspaces` being refused outright.
    const response = await request(app)
      .post("/api/v1/document/raw-text")
      .set("Authorization", `Bearer ${BOUND_SECRET}`)
      .send({
        textContent: "x",
        metadata: { title: "own-slug-ok" },
        addToWorkspaces: workspaceA.slug,
      });

    expect(response.status).toBe(200);
  });

  it("nothing was attached to workspace B by any of the refused calls", async () => {
    // The status code says the request was refused; this says no write happened.
    const rows = await prisma.workspace_documents.findMany({
      where: { workspaceId: workspaceB.id },
      select: { docpath: true },
    });
    expect(rows.map((r) => r.docpath)).toEqual([`${FOLDER}/${B_DOC}`]);
  });
});

describe("docpath comes from disk, not from the requested name", () => {
  // The reachable divergence is UNICODE, not `./` or `//`.
  //
  // For `./x.json`, `a//b`, and surrounding whitespace, `normalizePath` either produces
  // exactly the on-disk name (so nothing differs) or produces a name `fs.existsSync`
  // cannot find (so the finder skips the folder and answers 404 as it always did).
  // Neither reaches the docpath comparison. macOS is the case that does: the filesystem
  // stores NFD while a request commonly carries NFC. `existsSync` resolves either, so
  // the document IS found — and then a docpath built from the request is not `===` the
  // docpath written at ingest, and the key is told 404 about its own file.
  const NFD = "cafe\u0301-report.json";  // e + combining acute, as macOS stores it
  const NFC = "caf\u00e9-report.json";   // precomposed é, as a request carries it

  beforeAll(() => seedDocument(NFD, workspaceA));

  it("the two spellings are different strings but the same file", () => {
    // Guards the premise. If this ever stops being true the test below proves nothing.
    expect(NFC).not.toBe(NFD);
    expect(
      fs.existsSync(
        path.join(process.env.STORAGE_DIR, "documents", FOLDER, NFC)
      )
    ).toBe(true);
  });

  it("a bound key reading its own document by the other spelling still gets it", async () => {
    const response = await bound(
      request(app).get(`/api/v1/document/${encodeURIComponent(NFC)}`)
    );

    expect(response.status).toBe(200);
    // The name returned is the one on disk, which is what the docpath was built from.
    expect(response.body.document.name).toBe(NFD);
  });

  it("the normalized spellings still cannot reach the other tenant's document", async () => {
    // The lookup must not become a way around the join.
    for (const spelling of [B_DOC, `./${B_DOC}`, `  ${B_DOC}  `]) {
      const response = await bound(
        request(app).get(`/api/v1/document/${encodeURIComponent(spelling)}`)
      );
      expect(response.status).toBe(404);
    }
  });
});

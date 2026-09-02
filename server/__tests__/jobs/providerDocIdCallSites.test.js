// T-6 Phase B C-1 (#28): the 7 non-Lance providers must find vectors by EITHER id.
//
// `doc-vectors-canonicalize` rewrites document_vectors.docId from the legacy
// workspace_documents uuid to the canonical documents.id, in batches. A provider
// that looks up only the legacy uuid matches nothing once its document is
// converted, and the delete silently succeeds while the vectors stay in the store,
// retrievable, with no row left to find them by.
//
// T-4b closed its own two sites the same way (models/documents.js,
// models/vectors.js). These eight are the rest, and they are what the C-1 ruling
// blocks the flag on.
//
// Asserted on source text rather than through a mock, for the reason T-4b gave:
// the failure is a WHERE clause that matches zero rows, and a mocked prisma
// reports success either way.

const fs = require("fs");
const path = require("path");

const PROVIDER_DIR = path.resolve(__dirname, "../../utils/vectorDbProviders");
const PROVIDERS = [
  "astra",
  "chroma",
  "lance",
  "milvus",
  "pgvector",
  "pinecone",
  "qdrant",
  "weaviate",
];

const sourceFor = (provider) =>
  fs.readFileSync(path.join(PROVIDER_DIR, provider, "index.js"), "utf8");

describe("C-1: provider vector lookups tolerate legacy and canonical ids", () => {
  test.each(PROVIDERS)(
    "%s resolves vectors by both ids rather than the legacy uuid alone",
    (provider) => {
      const source = sourceFor(provider);
      // The bare single-id lookup is the shape that breaks mid-canonicalization.
      expect(source).not.toMatch(/DocumentVectors\.where\(\s*\{\s*docId\s*\}\s*\)/);
      expect(source).toMatch(/DocumentVectors\.forDocument\(/);
    }
  );

  test("every provider that deletes vectors was covered by this suite", () => {
    // Guards against a provider being added later and quietly missing the fix:
    // the list above is asserted against what is actually on disk.
    const onDisk = fs
      .readdirSync(PROVIDER_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) =>
        fs.existsSync(path.join(PROVIDER_DIR, name, "index.js"))
      )
      .filter((name) =>
        sourceFor(name).includes("deleteDocumentFromNamespace")
      )
      .sort();
    expect(onDisk).toEqual([...PROVIDERS].sort());
  });
});

// The source assertions above prove the call sites moved. This proves the thing
// they moved TO actually resolves both ids — against real Postgres, because the
// failure mode is a WHERE clause matching zero rows.
describe("C-1: docIdVariants resolves a document under either id", () => {
  const crypto = require("crypto");
  const { execFileSync } = require("child_process");
  const { PrismaClient } = require("@prisma/client");
  const { PG_SCHEME } = require("../../utils/test/postgresUrl");

  const SERVER_DIR = path.resolve(__dirname, "../..");
  const suffix = crypto.randomBytes(4).toString("hex");
  const testSchemaName = `t6_docid_${suffix}`;
  const baseDatabaseUrl = process.env.DATABASE_URL;
  const testUrl = new URL(baseDatabaseUrl);
  testUrl.searchParams.set("schema", testSchemaName);

  let prisma;
  let DocumentVectors;
  const LEGACY = `legacy-uuid-${suffix}`;
  let canonical;

  beforeAll(async () => {
    if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
      throw new Error("DATABASE_URL must point at PostgreSQL");
    execFileSync(
      path.join(SERVER_DIR, "node_modules/.bin/prisma"),
      ["migrate", "deploy", "--schema", path.join(SERVER_DIR, "prisma/schema.prisma")],
      { cwd: SERVER_DIR, env: { ...process.env, DATABASE_URL: testUrl.toString() }, stdio: "pipe" }
    );
    process.env.DATABASE_URL = testUrl.toString();
    jest.resetModules();
    prisma = new PrismaClient({ datasources: { db: { url: testUrl.toString() } } });
    ({ DocumentVectors } = require("../../models/vectors"));

    const workspace = await prisma.workspaces.create({
      data: { name: "C1", slug: `c1-${suffix}` },
    });
    // documentId is a real foreign key, so the canonical row has to exist —
    // which is also the shape the canonicalize job reads.
    canonical = await prisma.documents.create({
      data: { filename: "f.txt", dedupe_key: `custom-documents/f-${suffix}.txt` },
    });
    await prisma.workspace_documents.create({
      data: {
        docId: LEGACY,
        filename: "f.txt",
        docpath: "custom-documents/f.txt",
        workspaceId: workspace.id,
        documentId: canonical.id,
      },
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    process.env.DATABASE_URL = baseDatabaseUrl;
    const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${testSchemaName}" CASCADE`);
    await admin.$disconnect();
  });

  test("both the legacy uuid and the canonical id come back", async () => {
    expect((await DocumentVectors.docIdVariants(LEGACY)).sort()).toEqual(
      [LEGACY, String(canonical.id)].sort()
    );
  });

  test("an unknown id still yields itself, so a delete is never a silent no-op", async () => {
    expect(await DocumentVectors.docIdVariants("no-such-doc")).toEqual([
      "no-such-doc",
    ]);
  });

  test("a delete removes vectors stored under either id in one pass", async () => {
    // The state that breaks a single-id delete: the canonicalize job is midway,
    // so this document has vectors under the legacy uuid AND the canonical id.
    await prisma.document_vectors.deleteMany({});
    await prisma.document_vectors.createMany({
      data: [
        { docId: LEGACY, vectorId: "vec-legacy" },
        { docId: String(canonical.id), vectorId: "vec-canonical" },
        { docId: "unrelated-doc", vectorId: "vec-untouched" },
      ],
    });

    const found = await DocumentVectors.forDocument(LEGACY);
    expect(found.map((row) => row.vectorId).sort()).toEqual([
      "vec-canonical",
      "vec-legacy",
    ]);

    await prisma.document_vectors.deleteMany({
      where: { docId: { in: await DocumentVectors.docIdVariants(LEGACY) } },
    });

    const left = await prisma.document_vectors.findMany({
      select: { vectorId: true },
    });
    expect(left.map((row) => row.vectorId)).toEqual(["vec-untouched"]);
  });
});

describe("C-1: the canonicalize flag now defaults on and the override turns it off", () => {
  const {
    canonicalizeEnabled,
  } = require("../../jobs/docVectorsCanonicalize");

  test("an unset or empty value means enabled, because the call sites have migrated", () => {
    expect(canonicalizeEnabled({})).toBe(true);
    expect(canonicalizeEnabled({ ENABLE_DOC_VECTORS_CANONICALIZE: "" })).toBe(true);
  });

  test.each(["0", "false", "off", "no", "FALSE", " off "])(
    "the value %p turns the job off",
    (value) => {
      expect(
        canonicalizeEnabled({ ENABLE_DOC_VECTORS_CANONICALIZE: value })
      ).toBe(false);
    }
  );

  test("a truthy value keeps it on", () => {
    expect(
      canonicalizeEnabled({ ENABLE_DOC_VECTORS_CANONICALIZE: "1" })
    ).toBe(true);
    expect(
      canonicalizeEnabled({ ENABLE_DOC_VECTORS_CANONICALIZE: "true" })
    ).toBe(true);
  });
});

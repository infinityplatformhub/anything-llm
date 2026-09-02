// T-5 (#30) QA-2 blocker B + C: a table written BEFORE T-5 has no ACL columns at all.
//
// Not null values — no COLUMNS. DataFusion resolves identifiers against the Arrow schema,
// so on such a table every predicate naming `orgId` throws, `` `orgId` IS NULL ``
// included. The escape clause therefore failed on precisely the tables it exists to serve,
// and the boot report's `countRows("orgId IS NULL")` threw into a bare `catch {}` and
// reported "could not count" forever (Techlead FINDING-1 and FINDING-2).
//
// Measured on lancedb 0.15 against a table of {id, vector, text}:
//
//   where("`orgId` IS NULL")        -> THROWS No field named orgId
//   countRows("orgId IS NULL")      -> THROWS No field named orgid
//   countRows("`orgId` IS NULL")    -> THROWS No field named "orgId"
//   countRows()                     -> 1
//
// So the fix cannot be a quoting change: the question "does this table carry ACL columns"
// has to be asked of the SCHEMA before any predicate is built.
//
// These tests build that exact table. A mocked table cannot produce this failure — it has
// no Arrow schema and no query planner — which is why the earlier suites all passed.

const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  fs.mkdtempSync(path.join(os.tmpdir(), "lance-legacy-test-"));

const lancedb = require("@lancedb/lancedb");
const {
  aclMetadataFor,
} = require("../../../utils/authorization/vectorAclMetadata");
const { LanceDb } = require("../../../utils/vectorDbProviders/lance");

const filter = (over = {}) => ({
  orgId: 1,
  principalType: "user",
  actorId: "5",
  workspaceIds: ["7"],
  orgWide: false,
  deniedDocumentIds: [],
  attributes: {},
  matchNone: false,
  policyVersion: "42",
  ...over,
});

/** A pre-T-5 table: {id, vector, text} and nothing else. */
async function legacyTable() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lance-pre-t5-"));
  const client = await lancedb.connect(dir);
  return client.createTable("old", [
    { id: "1", vector: [0.1, 0.2], text: "written before T-5" },
    { id: "2", vector: [0.1, 0.25], text: "also before T-5" },
  ]);
}

/** A post-T-5 table: ACL columns present, one row unlabelled by value. */
async function modernTable() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lance-post-t5-"));
  const client = await lancedb.connect(dir);
  return client.createTable("new", [
    {
      id: "1",
      vector: [0.1, 0.2],
      text: "mine",
      ...aclMetadataFor({ workspaceId: 7, docId: "doc-mine" }),
    },
    {
      id: "2",
      vector: [0.1, 0.25],
      text: "theirs",
      ...aclMetadataFor({ workspaceId: 9, docId: "doc-theirs" }),
    },
  ]);
}

const withFlag = async (on, fn) => {
  const previous = process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
  if (on) process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
  else delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
  try {
    return await fn();
  } finally {
    if (previous === undefined)
      delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
    else process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = previous;
  }
};

describe("T-5: LanceDB on a table that predates the ACL columns", () => {
  let provider;
  let legacy;
  let modern;

  beforeAll(async () => {
    legacy = await legacyTable();
    modern = await modernTable();
    provider = new LanceDb();
  });

  afterEach(() => jest.restoreAllMocks());

  const searchOn = (table) => {
    jest.spyOn(provider, "connect").mockResolvedValue({
      client: { openTable: async () => table },
    });
    jest.spyOn(provider, "namespaceExists").mockResolvedValue(true);
    jest.spyOn(provider, "namespaceCount").mockResolvedValue(2);
    return provider.queryAuthorized({
      namespace: "old",
      queryVector: [0.1, 0.2],
      similarityThreshold: 0,
      topN: 10,
      aclFilter: filter(),
    });
  };

  test("the raw predicate DOES throw on such a table", async () => {
    // The premise, pinned. If this ever stops throwing, the branch below is no longer
    // needed and should be revisited rather than left in place forever.
    await expect(
      legacy
        .vectorSearch([0.1, 0.2])
        .where("`orgId` IS NULL")
        .limit(10)
        .toArray()
    ).rejects.toThrow(/No field named/i);
  });

  test("hasAclColumns is false for a legacy table, true for a modern one", async () => {
    expect(await provider.hasAclColumns(legacy)).toBe(false);
    expect(await provider.hasAclColumns(modern)).toBe(true);
  });

  test("flag unset: the legacy table is refused, not thrown on", async () => {
    // Default is fail-closed. The important half is that it does NOT throw: a throw would
    // surface as a 500 on chat, which is what QA-2 found before the branch existed.
    const result = await withFlag(false, () => searchOn(legacy));
    expect(result.contextTexts).toEqual([]);
  });

  test("flag unset: the refusal is LOGGED with the reason", async () => {
    // An empty result with no explanation reads as "no matching documents" and sends the
    // operator to look at their embeddings instead of at the one variable that governs
    // this.
    const logged = [];
    jest.spyOn(provider, "logger").mockImplementation((...args) => {
      logged.push(args.join(" "));
    });
    await withFlag(false, () => searchOn(legacy));
    expect(logged.join("\n")).toMatch(/predates the ACL metadata/i);
    expect(logged.join("\n")).toMatch(/RETRIEVAL_FILTER_ALLOW_UNPROVABLE/);
  });

  test("flag set: the legacy table is served", async () => {
    // The case the flag exists for, and the one that threw before. Every row here is
    // unlabelled by construction, so isRowAllowed applies the same all-or-nothing rule it
    // applies everywhere else — this is not a bypass of the second layer.
    const result = await withFlag(true, () => searchOn(legacy));
    expect(result.contextTexts).toContain("written before T-5");
    expect(result.contextTexts).toContain("also before T-5");
  });

  test("flag set: a MODERN table is still filtered normally", async () => {
    // The boundary that matters most. The legacy branch must not become a general
    // loosening — a table that carries provenance is held to it in both states.
    const result = await withFlag(true, () => searchOn(modern));
    expect(result.contextTexts).toEqual(["mine"]);
  });

  test("flag unset: a MODERN table is filtered normally too", async () => {
    const result = await withFlag(false, () => searchOn(modern));
    expect(result.contextTexts).toEqual(["mine"]);
  });
});

describe("T-5: the boot count distinguishes its three outcomes", () => {
  // Ruling C2: a real count, "this provider cannot be asked", and "the count FAILED" are
  // three different facts. The old code returned bare null for all three from a
  // `catch {}`, which is how the bare-identifier bug hid: LanceDB reported "could not
  // count" on every deployment and nobody read it as a fault.
  const {
    unprovableVectorCount,
    reportRetrievalFilterSupport,
  } = require("../../../utils/authorization/retrievalSupport");

  afterEach(() => jest.restoreAllMocks());

  test("an unsupported provider says so, distinctly", async () => {
    const counts = await unprovableVectorCount("milvus");
    expect(counts).toEqual({ unsupported: true });
    expect(counts.error).toBeUndefined();
  });

  test("a failure carries its message rather than vanishing", async () => {
    const { LanceDb: LanceDbClass } = require("../../../utils/vectorDbProviders/lance");
    jest
      .spyOn(LanceDbClass.prototype, "connect")
      .mockRejectedValue(new Error("boom from the driver"));
    const counts = await unprovableVectorCount("lancedb");
    expect(counts.error).toMatch(/boom from the driver/);
    expect(counts.unsupported).toBeUndefined();
  });

  test("a failed count is reported at ERROR level, with the message", async () => {
    const { LanceDb: LanceDbClass } = require("../../../utils/vectorDbProviders/lance");
    jest
      .spyOn(LanceDbClass.prototype, "connect")
      .mockRejectedValue(new Error("No field named orgid"));
    const log = { warn: jest.fn(), error: jest.fn() };
    await reportRetrievalFilterSupport("lancedb", log);
    expect(log.error).toHaveBeenCalled();
    expect(log.error.mock.calls[0][0]).toMatch(/No field named orgid/);
  });

  test("an unsupported provider is reported at WARN, not ERROR", async () => {
    // Nothing is broken in that case, and an error would train operators to ignore the
    // line that matters.
    const log = { warn: jest.fn(), error: jest.fn() };
    await reportRetrievalFilterSupport("milvus", log);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  test("a table with NO ACL columns counts as 100% unlabelled, not as an error", async () => {
    // Ruling C: absent columns is a countable fact about the data, not a fault in the
    // query. Reporting it as an error would tell an operator to debug their driver when
    // what they actually need is the backfill.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lance-count-old-"));
    const client = await lancedb.connect(dir);
    await client.createTable("old", [
      { id: "1", vector: [0.1, 0.2], text: "a" },
      { id: "2", vector: [0.3, 0.4], text: "b" },
    ]);

    const { LanceDb: LanceDbClass } = require("../../../utils/vectorDbProviders/lance");
    jest
      .spyOn(LanceDbClass.prototype, "connect")
      .mockResolvedValue({ client });

    const counts = await unprovableVectorCount("lancedb");
    expect(counts).toEqual({ unlabelled: 2, total: 2 });
  });

  test("a table WITH ACL columns counts only the null-valued rows", async () => {
    // The paired case QA-2 asked for: "column absent" and "column present but NULL" are
    // different situations and both must count correctly. This one exercises the
    // backticked predicate, which is the half that used to throw.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lance-count-new-"));
    const client = await lancedb.connect(dir);
    await client.createTable("new", [
      {
        id: "1",
        vector: [0.1, 0.2],
        text: "labelled",
        ...aclMetadataFor({ workspaceId: 7, docId: "d1" }),
      },
      {
        id: "2",
        vector: [0.3, 0.4],
        text: "null-valued",
        orgId: null,
        workspaceId: null,
        docId: null,
      },
    ]);

    const { LanceDb: LanceDbClass } = require("../../../utils/vectorDbProviders/lance");
    jest
      .spyOn(LanceDbClass.prototype, "connect")
      .mockResolvedValue({ client });

    const counts = await unprovableVectorCount("lancedb");
    expect(counts).toEqual({ unlabelled: 1, total: 2 });
  });
});

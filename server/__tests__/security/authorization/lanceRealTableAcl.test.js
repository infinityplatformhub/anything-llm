// T-5 (#30) QA-2: the LanceDB predicate must survive DataFusion, not just look right.
//
// `toSqlString()` emitted bare identifiers (`orgId = '1'`). DataFusion case-folds an
// unquoted identifier to `orgid`, the Arrow schema has no such field, and every
// `queryAuthorized()` call threw `Schema error: No field named orgid`. LanceDB is the
// DEFAULT provider, so this was chat-with-context returning 500 or empty on every
// stock deployment.
//
// Every existing test missed it for one reason: they mocked the table. A mock records the
// predicate string and hands rows back; it has no DataFusion in it, so a predicate that
// cannot be parsed at all looks identical to one that works. The only test that can catch
// this class of bug is one that opens a real table and lets the real query planner judge
// the string.
//
// The dialect trap is that the WRONG spellings fail in two different ways, and one of them
// is silent (measured on lancedb 0.15, @lancedb/lancedb, Arrow schema from real rows):
//
//   orgId = '1'      -> THROWS (No field named orgid)
//   "orgId" = '1'    -> parses, returns 0 ROWS, ALWAYS
//   `orgId` = '1'    -> correct
//
// The double-quote form is the dangerous one: SQL-standard, obviously "right" to anyone
// reading it, and it fails closed into a permanent empty result with no error anywhere.
// That is a retrieval outage that would be debugged as an embedding or ranking problem.
// It is pinned below so nobody "fixes" the backticks into quotes later.

const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  fs.mkdtempSync(path.join(os.tmpdir(), "lance-acl-test-"));

const lancedb = require("@lancedb/lancedb");
const {
  constraintFor,
} = require("../../../utils/authorization/vectorPredicate");
const {
  aclMetadataFor,
} = require("../../../utils/authorization/vectorAclMetadata");
const { LanceDb } = require("../../../utils/vectorDbProviders/lance");

const MINE = { workspaceId: 7, docId: "doc-mine" };
const FOREIGN = { workspaceId: 9, docId: "doc-foreign" };

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

describe("T-5: LanceDB ACL filter on a real table", () => {
  let table;
  let provider;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lance-real-"));
    const client = await lancedb.connect(dir);
    // Rows written the way the real ingest path writes them: the ACL fields come from
    // aclMetadataFor, so a rename there breaks this test rather than silently breaking
    // retrieval in production.
    table = await client.createTable("workspace-slug", [
      {
        id: "1",
        vector: [0.1, 0.2],
        text: "mine",
        ...aclMetadataFor(MINE),
      },
      {
        id: "2",
        vector: [0.1, 0.21],
        text: "foreign",
        ...aclMetadataFor(FOREIGN),
      },
    ]);

    provider = new LanceDb();
    jest.spyOn(provider, "connect").mockResolvedValue({
      client: { openTable: async () => table },
    });
    jest.spyOn(provider, "namespaceExists").mockResolvedValue(true);
  });

  afterAll(() => jest.restoreAllMocks());

  test("queryAuthorized returns only the actor's own workspace", async () => {
    // The end-to-end case. Before the fix this did not return the foreign row — it threw,
    // which on the default provider is every context-backed chat failing.
    const result = await provider.queryAuthorized({
      namespace: "workspace-slug",
      queryVector: [0.1, 0.2],
      similarityThreshold: 0,
      topN: 10,
      aclFilter: filter(),
    });

    expect(result.contextTexts).toEqual(["mine"]);
  });

  test("the rendered predicate is accepted by DataFusion", async () => {
    // Narrower than the test above, and the one that names the actual defect: the string
    // toSqlString produces must PARSE. A predicate the planner rejects is not a stricter
    // filter, it is a dead endpoint.
    const predicate = constraintFor(filter()).toSqlString();
    await expect(
      table.vectorSearch([0.1, 0.2]).where(predicate).limit(10).toArray()
    ).resolves.toHaveLength(1);
  });

  test("RED proof: bare identifiers throw on the same table", async () => {
    // The mutation that proves the test above has teeth. Strip the backticks — which is
    // exactly what the code did before this fix — and the query dies. If this ever starts
    // passing, DataFusion changed its folding rules and the fix needs rechecking, not
    // deleting.
    await expect(
      table.vectorSearch([0.1, 0.2]).where("orgId = '1'").limit(10).toArray()
    ).rejects.toThrow(/No field named orgid/i);
  });

  test("RED proof: double-quoted identifiers silently return nothing", async () => {
    // The trap. This is the spelling a reviewer would call correct, and it fails closed
    // and silent: no error, no rows, forever. Pinned so the backticks are never
    // "corrected" into standard SQL.
    await expect(
      table.vectorSearch([0.1, 0.2]).where(`"orgId" = '1'`).limit(10).toArray()
    ).resolves.toHaveLength(0);
  });

  test("a denied document is excluded on a real table", async () => {
    // Deny-wins, proven through the planner rather than through isRowAllowed — the
    // deny-list renders as `NOT IN`, which is its own piece of dialect.
    const result = await provider.queryAuthorized({
      namespace: "workspace-slug",
      queryVector: [0.1, 0.2],
      similarityThreshold: 0,
      topN: 10,
      aclFilter: filter({ deniedDocumentIds: ["doc-mine"] }),
    });

    expect(result.contextTexts).toEqual([]);
  });

  test("the unprovable-rows escape clause also parses", async () => {
    // The OR-unlabelled wrapper adds three IS NULL checks, each on a backticked
    // identifier. It is a separate code path from the strict predicate and would fail the
    // same way if an identifier there were left bare.
    const previous = process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
    process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
    try {
      const predicate = constraintFor(filter()).toSqlString();
      expect(predicate).toContain("IS NULL");
      await expect(
        table.vectorSearch([0.1, 0.2]).where(predicate).limit(10).toArray()
      ).resolves.toHaveLength(1);
    } finally {
      if (previous === undefined)
        delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
      else process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = previous;
    }
  });
});

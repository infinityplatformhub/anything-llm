// T-5 (#30) slice 1b — the Milvus expression must be accepted by a real Milvus parser.
//
// Milvus parses boolean expressions SERVER-SIDE; the SDK ships no local parser, so a
// rendered string can only be validated by sending it to a running instance. That is the
// whole reason this suite exists, and it immediately earned its keep:
//
//   not exists a and not exists b       -> cannot parse expression:
//                                          'and' can only be used between boolean
//                                          expressions
//   (not exists a) and (not exists b)   -> correct
//
// `not` binds tighter than its operand, so the unparenthesised form parses as
// `not (exists a and not exists b)` and is rejected. The strict predicate was fine; only
// the RETRIEVAL_FILTER_ALLOW_UNPROVABLE path was broken, which means the flag would have
// turned Milvus retrieval OFF instead of widening it — and only a deployment that set the
// flag would ever have discovered that.
//
// No amount of review finds that: the string looks correct and reads correctly. This is
// the same lesson as LanceDB's backticks and pgvector's placeholders — a predicate is only
// known to work once a real engine has accepted it.
//
// Requires a Milvus instance. Skipped (not failed) without one, so a contributor is not
// blocked; set MILVUS_TEST_ADDRESS to run it. Locally:
//
//   docker run -d --name etcd -p 2381:2379 quay.io/coreos/etcd:v3.5.5 \
//     etcd -advertise-client-urls=http://127.0.0.1:2379 \
//     -listen-client-urls http://0.0.0.0:2379 --data-dir /etcd
//   docker run -d --name minio -p 9002:9000 \
//     minio/minio:RELEASE.2023-03-20T20-16-18Z server /minio_data
//   docker run -d --name milvus -p 19531:19530 --link etcd --link minio \
//     -e ETCD_ENDPOINTS=etcd:2379 -e MINIO_ADDRESS=minio:9000 \
//     milvusdb/milvus:v2.3.9 milvus run standalone
//   MILVUS_TEST_ADDRESS=localhost:19531 yarn test milvusRealStoreAcl
//
// (Embedded-etcd standalone segfaults on arm64 — external etcd and minio are required.)

const {
  constraintFor,
} = require("../../../utils/authorization/vectorPredicate");

const ADDRESS = process.env.MILVUS_TEST_ADDRESS;
const describeIfMilvus = ADDRESS ? describe : describe.skip;

const filter = (over = {}) => ({
  orgId: 1,
  principalType: "user",
  actorId: "5",
  workspaceIds: ["3"],
  orgWide: false,
  deniedDocumentIds: [],
  attributes: {},
  matchNone: false,
  policyVersion: "42",
  ...over,
});

const COLLECTION = `t5_acl_${process.pid}`;

describeIfMilvus("T-5: the Milvus predicate on a real Milvus", () => {
  let client;

  beforeAll(async () => {
    const {
      MilvusClient,
      DataType,
    } = require("@zilliz/milvus2-sdk-node");
    client = new MilvusClient({ address: ADDRESS });

    await client.dropCollection({ collection_name: COLLECTION }).catch(() => {});
    await client.createCollection({
      collection_name: COLLECTION,
      fields: [
        {
          name: "id",
          data_type: DataType.Int64,
          is_primary_key: true,
          autoID: true,
        },
        { name: "vector", data_type: DataType.FloatVector, dim: 2 },
        { name: "metadata", data_type: DataType.JSON },
      ],
    });
    await client.createIndex({
      collection_name: COLLECTION,
      field_name: "vector",
      index_type: "FLAT",
      metric_type: "COSINE",
    });
    await client.insert({
      collection_name: COLLECTION,
      fields_data: [
        {
          vector: [0.1, 0.2],
          metadata: {
            text: "mine",
            orgId: "1",
            workspaceId: "3",
            docId: "doc-mine",
          },
        },
        {
          vector: [0.1, 0.21],
          metadata: {
            text: "other-org",
            orgId: "2",
            workspaceId: "3",
            docId: "doc-theirs",
          },
        },
        {
          vector: [0.1, 0.22],
          metadata: {
            text: "other-workspace",
            orgId: "1",
            workspaceId: "9",
            docId: "doc-ws9",
          },
        },
        // No ACL keys at all: a vector written before T-5.
        { vector: [0.1, 0.23], metadata: { text: "legacy" } },
      ],
    });
    await client.flushSync({ collection_names: [COLLECTION] });
    await client.loadCollectionSync({ collection_name: COLLECTION });
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.dropCollection({ collection_name: COLLECTION }).catch(() => {});
  });

  /** Run a rendered expression through the real parser; return the texts it admits. */
  const textsFor = async (aclFilter) => {
    const expr = constraintFor(aclFilter).toMilvusExpr("metadata");
    if (expr === null) return null;
    const response = await client.search({
      collection_name: COLLECTION,
      vector: [0.1, 0.2],
      limit: 10,
      filter: expr,
      output_fields: ["metadata"],
    });
    // Milvus reports a parse failure in the status rather than by throwing, so an
    // assertion on rows alone would read a broken expression as "no matches".
    if (response.status?.error_code !== "Success") {
      throw new Error(`Milvus rejected the expression: ${response.status?.reason}`);
    }
    return response.results.map((row) => row.metadata.text).sort();
  };

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

  test("the strict predicate returns only the actor's own rows", async () => {
    expect(await withFlag(false, () => textsFor(filter()))).toEqual(["mine"]);
  });

  test("the ESCAPE CLAUSE parses — the case that was broken", async () => {
    // The regression. Before the parentheses this threw
    // "'and' can only be used between boolean expressions", so setting the flag turned
    // Milvus retrieval off rather than widening it.
    const texts = await withFlag(true, () => textsFor(filter()));
    expect(texts).toContain("legacy");
    expect(texts).toContain("mine");
  });

  test("the flag does not admit another org or another workspace", async () => {
    // The boundary: absence of evidence is excused, evidence of denial is not.
    const texts = await withFlag(true, () => textsFor(filter()));
    expect(texts).not.toContain("other-org");
    expect(texts).not.toContain("other-workspace");
  });

  test("the deny list excludes a denied document", async () => {
    expect(
      await withFlag(false, () =>
        textsFor(filter({ deniedDocumentIds: ["doc-mine"] }))
      )
    ).toEqual([]);
  });

  test("an allow list narrows to the listed document", async () => {
    expect(
      await withFlag(false, () =>
        textsFor(
          filter({
            principalType: "embed",
            allowedDocumentIds: ["doc-mine"],
          })
        )
      )
    ).toEqual(["mine"]);
  });

  test("an org-wide grant returns the org, not the table", async () => {
    expect(
      await withFlag(false, () =>
        textsFor(filter({ orgWide: true, workspaceIds: [] }))
      )
    ).toEqual(["mine", "other-workspace"]);
  });

  test("every rendered shape is accepted by the parser", async () => {
    // Broader than the cases above: each shape is asserted to PARSE, in both flag states.
    // A shape that only appears in an unusual deployment would otherwise be discovered
    // there rather than here.
    const shapes = [
      ["plain", {}],
      ["org-wide", { orgWide: true, workspaceIds: [] }],
      ["deny", { deniedDocumentIds: ["doc-mine"] }],
      ["allow", { principalType: "embed", allowedDocumentIds: ["doc-mine"] }],
      [
        "deny+allow",
        {
          principalType: "embed",
          deniedDocumentIds: ["doc-x"],
          allowedDocumentIds: ["doc-mine"],
        },
      ],
    ];
    // Collected rather than asserted one by one, so a failure reports EVERY shape the
    // parser rejected instead of stopping at the first — with eight combinations, knowing
    // whether one is broken or all of them is the difference between a typo and a wrong
    // dialect.
    const rejected = [];
    for (const [name, over] of shapes) {
      for (const flagged of [false, true]) {
        const label = `${name} (flag ${flagged ? "on" : "off"})`;
        try {
          await withFlag(flagged, () => textsFor(filter(over)));
        } catch (error) {
          rejected.push(`${label}: ${error.message}`);
        }
      }
    }
    expect(rejected).toEqual([]);
  }, 60000);
});

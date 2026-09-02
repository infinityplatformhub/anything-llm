// T-5 (#30) slice 1b — the Chroma predicate against a real Chroma.
//
// Techlead-2 item 8: a dialect string test cannot see what an engine does with the string.
// Every provider in this slice has now proved that separately — LanceDB's identifier
// quoting, pgvector's placeholder numbering, Milvus's operator precedence, Qdrant's
// is_null-versus-is_empty, Weaviate's tokenization. All five read correctly and all five
// were wrong.
//
// Chroma is also the one provider that CANNOT express the escape clause: its operator set
// is closed (`$gt $gte $lt $lte $ne $eq $in $nin`) with no `$exists`, so
// RETRIEVAL_FILTER_ALLOW_UNPROVABLE has no effect here and pre-T-5 vectors stay excluded
// until the backfill (#56). That is asserted below as rendered EQUALITY between the two
// flag states plus identical results from the engine — "does not throw" would pass just as
// well with a half-working escape clause, which is how the 1a flag stayed inert.
//
// Requires Chroma. Skipped without CHROMA_TEST_ADDRESS:
//
//   docker run -d --name chroma -p 8003:8000 chromadb/chroma:0.5.20
//   CHROMA_TEST_ADDRESS=http://localhost:8003 yarn test chromaRealStoreAcl

const {
  constraintFor,
} = require("../../../utils/authorization/vectorPredicate");

const ADDRESS = process.env.CHROMA_TEST_ADDRESS;
const describeIfChroma = ADDRESS ? describe : describe.skip;

const COLLECTION = `t5_acl_${process.pid}`;

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

describeIfChroma("T-5: the Chroma predicate on a real Chroma", () => {
  let collection;

  beforeAll(async () => {
    const { ChromaClient } = require("chromadb");
    const client = new ChromaClient({ path: ADDRESS });
    await client.deleteCollection({ name: COLLECTION }).catch(() => {});
    collection = await client.createCollection({
      name: COLLECTION,
      metadata: { "hnsw:space": "cosine" },
    });
    await collection.add({
      ids: ["1", "2", "3", "4", "5"],
      embeddings: [
        [0.1, 0.2],
        [0.1, 0.21],
        [0.1, 0.22],
        [0.1, 0.23],
        [0.1, 0.24],
      ],
      metadatas: [
        { text: "mine", orgId: "1", workspaceId: "3", docId: "doc-mine" },
        { text: "other-org", orgId: "2", workspaceId: "3", docId: "doc-theirs" },
        { text: "other-ws", orgId: "1", workspaceId: "9", docId: "doc-ws9" },
        { text: "denied", orgId: "1", workspaceId: "3", docId: "doc-bad" },
        // Pre-T-5: no ACL keys. Chroma cannot match this, by design.
        { text: "legacy" },
      ],
      documents: ["mine", "other-org", "other-ws", "denied", "legacy"],
    });
  }, 120000);

  afterAll(async () => {
    if (!collection) return;
    const { ChromaClient } = require("chromadb");
    await new ChromaClient({ path: ADDRESS })
      .deleteCollection({ name: COLLECTION })
      .catch(() => {});
  });

  const textsFor = async (aclFilter) => {
    const where = constraintFor(aclFilter).toChromaWhere();
    if (where === null) return null;
    const response = await collection.query({
      queryEmbeddings: [[0.1, 0.2]],
      nResults: 10,
      where,
    });
    return (response.metadatas?.[0] ?? []).map((row) => row.text).sort();
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

  test("the predicate is ACCEPTED by Chroma", async () => {
    // The baseline every dialect in this slice has failed at least once.
    await expect(withFlag(false, () => textsFor(filter()))).resolves.toBeDefined();
  });

  test("only the actor's own workspace comes back", async () => {
    // "denied" is in org 1 / workspace 3, so it belongs here until a deny-list names it —
    // that is the next test. Expecting ["mine"] alone was my error, not the engine's.
    expect(await withFlag(false, () => textsFor(filter()))).toEqual([
      "denied",
      "mine",
    ]);
  });

  test("another org and another workspace are excluded", async () => {
    const texts = await withFlag(false, () => textsFor(filter()));
    expect(texts).not.toContain("other-org");
    expect(texts).not.toContain("other-ws");
    expect(texts).not.toContain("legacy");
  });

  test("a denied document is excluded", async () => {
    expect(
      await withFlag(false, () =>
        textsFor(filter({ deniedDocumentIds: ["doc-bad"] }))
      )
    ).toEqual(["mine"]);
  });

  test("$and is emitted once there is more than one clause", async () => {
    // Chroma rejects two bare keys in one `where`; the renderer wraps them. Asserted
    // through the engine rather than on the string, since the string looked right in every
    // other dialect that failed.
    await expect(
      withFlag(false, () =>
        textsFor(
          filter({
            deniedDocumentIds: ["doc-bad"],
            principalType: "embed",
            allowedDocumentIds: ["doc-mine"],
          })
        )
      )
    ).resolves.toEqual(["mine"]);
  });

  test("an org-wide grant returns the org, not the collection", async () => {
    expect(
      await withFlag(false, () =>
        textsFor(filter({ orgWide: true, workspaceIds: [] }))
      )
    ).toEqual(["denied", "mine", "other-ws"]);
  });

  test("the flag changes NOTHING here — rendered and executed", async () => {
    // Chroma has no `$exists`, so the escape clause is inexpressible. Both halves are
    // pinned: the rendered predicate is identical, and so is what the engine returns.
    // Asserting only "does not throw" would pass with a partially-applied escape clause,
    // which is the shape of the bug this slice was failed for twice.
    const strictWhere = JSON.stringify(
      await withFlag(false, () => constraintFor(filter()).toChromaWhere())
    );
    const flaggedWhere = JSON.stringify(
      await withFlag(true, () => constraintFor(filter()).toChromaWhere())
    );
    expect(flaggedWhere).toEqual(strictWhere);

    expect(await withFlag(true, () => textsFor(filter()))).toEqual(
      await withFlag(false, () => textsFor(filter()))
    );
  });

  test("the pre-T-5 row is excluded in BOTH states", async () => {
    // The documented consequence: on Chroma an operator's only remedy is the backfill.
    for (const flagged of [false, true]) {
      const texts = await withFlag(flagged, () => textsFor(filter()));
      expect(texts).not.toContain("legacy");
    }
  });
});

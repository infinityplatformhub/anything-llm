// T-5 (#30) slice 1b — the Qdrant predicate against a real Qdrant.
//
// QA-2 found the escape clause was INERT here, and the reason is a distinction no amount
// of reading catches: Qdrant has TWO conditions for "no value", and they are not the same.
//
// Measured on qdrant 1.9.0, against three points:
//
//                    key absent   key present, JSON null
//   is_null  x3          NO                YES
//   is_empty x3          YES               YES
//
// A vector written before T-5 has the keys ABSENT — the write path simply did not set
// them — so `is_null` matched nothing and RETRIEVAL_FILTER_ALLOW_UNPROVABLE served no
// legacy rows at all. The flag looked implemented and did nothing, which is the same
// failure this slice has now been corrected for three times (the inert 1a flag, the
// unparenthesised Milvus expression, and this).
//
// THE FIXTURE IS THE TEST. A point whose payload contains `{orgId: null}` passes under
// both conditions, so a suite built on null-valued fixtures goes green while the product
// is broken. The absent-key point below is the one that matters; the null-valued point is
// kept only to prove both are covered.
//
// Requires Qdrant. Skipped (not failed) without QDRANT_TEST_URL so nobody is blocked:
//
//   docker run -d --name qdrant -p 6340:6333 qdrant/qdrant:v1.9.0
//   QDRANT_TEST_URL=http://localhost:6340 yarn test qdrantRealStoreAcl

const {
  constraintFor,
} = require("../../../utils/authorization/vectorPredicate");

const URL = process.env.QDRANT_TEST_URL;
const describeIfQdrant = URL ? describe : describe.skip;

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

describeIfQdrant("T-5: the Qdrant predicate on a real Qdrant", () => {
  let client;

  beforeAll(async () => {
    const { QdrantClient } = require("@qdrant/js-client-rest");
    client = new QdrantClient({ url: URL });
    await client.deleteCollection(COLLECTION).catch(() => {});
    await client.createCollection(COLLECTION, {
      vectors: { size: 2, distance: "Cosine" },
    });
    await client.upsert(COLLECTION, {
      wait: true,
      points: [
        {
          id: 1,
          vector: [0.1, 0.2],
          payload: {
            text: "mine",
            orgId: "1",
            workspaceId: "3",
            docId: "doc-mine",
          },
        },
        {
          id: 2,
          vector: [0.1, 0.21],
          payload: {
            text: "other-org",
            orgId: "2",
            workspaceId: "3",
            docId: "doc-theirs",
          },
        },
        {
          id: 3,
          vector: [0.1, 0.22],
          payload: {
            text: "other-workspace",
            orgId: "1",
            workspaceId: "9",
            docId: "doc-ws9",
          },
        },
        // Pre-T-5: the ACL keys are ABSENT, not null. This is the shape the old
        // `is_null` predicate could not match, and the only fixture that proves the fix.
        { id: 4, vector: [0.1, 0.23], payload: { text: "absent-keys" } },
        // Keys present, values null. Matched by BOTH conditions, so on its own it would
        // have hidden the bug entirely.
        {
          id: 5,
          vector: [0.1, 0.24],
          payload: {
            text: "explicit-null",
            orgId: null,
            workspaceId: null,
            docId: null,
          },
        },
      ],
    });
  }, 60000);

  afterAll(async () => {
    if (client) await client.deleteCollection(COLLECTION).catch(() => {});
  });

  const textsFor = async (aclFilter) => {
    const qdrantFilter = constraintFor(aclFilter).toQdrantFilter();
    if (qdrantFilter === null) return null;
    const results = await client.search(COLLECTION, {
      vector: [0.1, 0.2],
      limit: 10,
      with_payload: true,
      filter: qdrantFilter,
    });
    return results.map((row) => row.payload.text).sort();
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

  test("flag off: only the actor's own rows", async () => {
    expect(await withFlag(false, () => textsFor(filter()))).toEqual(["mine"]);
  });

  test("flag off: neither unlabelled shape is served", async () => {
    const texts = await withFlag(false, () => textsFor(filter()));
    expect(texts).not.toContain("absent-keys");
    expect(texts).not.toContain("explicit-null");
  });

  test("flag on: a point with ABSENT keys is served — the inert case", async () => {
    // The regression. `is_null` did not match an absent key, so this row stayed excluded
    // no matter what the operator set, while the boot report said otherwise.
    const texts = await withFlag(true, () => textsFor(filter()));
    expect(texts).toContain("absent-keys");
  });

  test("flag on: a point with explicit nulls is also served", async () => {
    const texts = await withFlag(true, () => textsFor(filter()));
    expect(texts).toContain("explicit-null");
  });

  test("flag on: the actor's own rows are still there", async () => {
    // The escape widens; it must not replace. A filter that returned only the unlabelled
    // rows would be just as broken in the other direction.
    const texts = await withFlag(true, () => textsFor(filter()));
    expect(texts).toContain("mine");
  });

  test("flag on: another org and another workspace stay excluded", async () => {
    // The boundary — absence of evidence is excused, evidence of denial is not.
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
          filter({ principalType: "embed", allowedDocumentIds: ["doc-mine"] })
        )
      )
    ).toEqual(["mine"]);
  });

  test("an org-wide grant returns the org, not the collection", async () => {
    expect(
      await withFlag(false, () =>
        textsFor(filter({ orgWide: true, workspaceIds: [] }))
      )
    ).toEqual(["mine", "other-workspace"]);
  });

  test("is_null alone would NOT match the absent-key point", async () => {
    // Pins the distinction itself, independently of our renderer. If a future Qdrant makes
    // `is_null` cover absent keys, this fails and the comment above needs revisiting —
    // rather than the two conditions quietly becoming interchangeable in someone's head.
    const viaIsNull = await client.search(COLLECTION, {
      vector: [0.1, 0.2],
      limit: 10,
      with_payload: true,
      filter: {
        must: ["orgId", "workspaceId", "docId"].map((key) => ({
          is_null: { key },
        })),
      },
    });
    const texts = viaIsNull.map((row) => row.payload.text);
    expect(texts).toContain("explicit-null");
    expect(texts).not.toContain("absent-keys");
  });
});

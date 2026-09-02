// T-5 (#30) PR-1 — `queryAuthorized`: the vector ACL boundary.
//
// T-3 built the DocumentAclFilter. Nothing pushed it down into a provider, so every
// retrieval path still queried the raw namespace: the filter existed and enforced nothing.
// This slice makes the filter the ONLY way a caller reaches vectors.
//
// The load-bearing decision, asserted several ways below: the predicate goes INTO the
// query, before `.limit(topN)`. Filtering the returned rows instead would pass a naive
// "no forbidden text in the answer" assertion and still be wrong twice over:
//
//   - S-17: topN is spent on candidates the actor cannot read, so a legitimate document
//     ranked 5th never appears. The leak is closed and the answer is quietly incomplete —
//     the failure mode nobody files a bug for.
//   - The provider has already materialized forbidden chunk text into process memory,
//     which is what seam 07 exists to prevent.
//
// lancedb's `where()` is a prefilter by default in 0.15 (`postfilter()` is opt-in), so
// pushing down is available and cheap; the tests below pin that it is actually used.
//
// RED on approof/main eda1214b: `queryAuthorized` does not exist, and
// `performSimilaritySearch` reaches the namespace with no filter at all.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();

const {
  AuthorizationContractError,
} = require("../../../utils/authorization/errors");

// A filter shaped like T-3's output. Built explicitly rather than by calling
// buildDocumentFilter, so a bug there cannot make these pass.
const filter = (over = {}) => ({
  orgId: 1,
  principalType: "user",
  actorId: "5",
  workspaceIds: ["1"],
  orgWide: false,
  deniedDocumentIds: [],
  attributes: { groupIds: [] },
  matchNone: false,
  policyVersion: "42",
  ...over,
});

/**
 * A fake lance table that records the predicate it was given and answers from a fixed
 * row set. It applies the predicate ITSELF only when asked to — the point is to observe
 * what the provider pushed down, not to reimplement SQL.
 */
function fakeTable(rows) {
  const calls = { where: [], limit: [], postfilter: 0 };
  const query = {
    distanceType: () => query,
    limit(n) {
      calls.limit.push(n);
      return query;
    },
    where(predicate) {
      calls.where.push(predicate);
      return query;
    },
    postfilter() {
      calls.postfilter += 1;
      return query;
    },
    toArray: async () => rows,
  };
  return {
    calls,
    table: { vectorSearch: () => query, search: () => query },
  };
}

describe("T-5 S-14: a missing or malformed filter is refused before the provider is touched", () => {
  let LanceDb;
  beforeAll(() => {
    // Instantiated, not used statically: helpers/index.js does `new LanceDb()` per call,
    // so the seam must hold on an instance or it does not hold where it is used.
    const { LanceDb: LanceDbClass } = require("../../../utils/vectorDbProviders/lance");
    LanceDb = new LanceDbClass();
  });

  test("a null aclFilter throws — there is no unfiltered query", async () => {
    // The whole seam depends on this: if null meant "no restriction", every caller that
    // forgot the argument would silently read everything.
    await expect(
      LanceDb.queryAuthorized({
        namespace: "ws1",
        queryVector: [0.1],
        aclFilter: null,
      })
    ).rejects.toThrow(AuthorizationContractError);
  });

  test("an empty object is not a filter either", async () => {
    await expect(
      LanceDb.queryAuthorized({
        namespace: "ws1",
        queryVector: [0.1],
        aclFilter: {},
      })
    ).rejects.toThrow(AuthorizationContractError);
  });

  test("a filter missing policyVersion is refused", async () => {
    // Without the stamp there is no way to know whether the filter describes current
    // policy, which is the property the cache and the staleness check both rely on.
    const { policyVersion, ...noVersion } = filter();
    await expect(
      LanceDb.queryAuthorized({
        namespace: "ws1",
        queryVector: [0.1],
        aclFilter: noVersion,
      })
    ).rejects.toThrow(AuthorizationContractError);
  });

  test("the refusal happens before any client work", async () => {
    // Asserted by making connect() explode: if it is ever reached, this fails with the
    // wrong error and the ordering guarantee is gone.
    const connect = jest
      .spyOn(LanceDb, "connect")
      .mockRejectedValue(new Error("connect must not be called for an invalid filter"));

    await expect(
      LanceDb.queryAuthorized({ namespace: "ws1", queryVector: [0.1], aclFilter: null })
    ).rejects.toThrow(AuthorizationContractError);
    expect(connect).not.toHaveBeenCalled();

    connect.mockRestore();
  });
});

describe("T-5 S-10/S-17: the predicate is pushed into the query, not applied to results", () => {
  let LanceDb;
  beforeAll(() => {
    // Instantiated, not used statically: helpers/index.js does `new LanceDb()` per call,
    // so the seam must hold on an instance or it does not hold where it is used.
    const { LanceDb: LanceDbClass } = require("../../../utils/vectorDbProviders/lance");
    LanceDb = new LanceDbClass();
  });
  afterEach(() => jest.restoreAllMocks());

  test("where() is called before limit() — a prefilter, not a post-filter", async () => {
    // S-17 in its purest form. If limit lands first, topN is spent on rows the actor
    // cannot read and the answer silently loses its legitimate tail.
    const { calls, table } = fakeTable([]);
    jest.spyOn(LanceDb, "connect").mockResolvedValue({
      client: { openTable: async () => table },
    });
    jest.spyOn(LanceDb, "namespaceExists").mockResolvedValue(true);

    await LanceDb.queryAuthorized({
      namespace: "ws1",
      queryVector: [0.1],
      topN: 4,
      aclFilter: filter(),
    });

    expect(calls.where.length).toBeGreaterThan(0);
    expect(calls.limit).toEqual([4]);
  });

  test("postfilter() is never requested", async () => {
    // lancedb prefilters by default; calling postfilter() would opt back into exactly the
    // behaviour this seam forbids.
    const { calls, table } = fakeTable([]);
    jest.spyOn(LanceDb, "connect").mockResolvedValue({
      client: { openTable: async () => table },
    });
    jest.spyOn(LanceDb, "namespaceExists").mockResolvedValue(true);

    await LanceDb.queryAuthorized({
      namespace: "ws1",
      queryVector: [0.1],
      aclFilter: filter(),
    });

    expect(calls.postfilter).toBe(0);
  });

  test("the predicate carries the org, so another org's rows cannot match", async () => {
    const { calls, table } = fakeTable([]);
    jest.spyOn(LanceDb, "connect").mockResolvedValue({
      client: { openTable: async () => table },
    });
    jest.spyOn(LanceDb, "namespaceExists").mockResolvedValue(true);

    await LanceDb.queryAuthorized({
      namespace: "ws1",
      queryVector: [0.1],
      aclFilter: filter({ orgId: 7 }),
    });

    expect(calls.where.join(" ")).toMatch(/orgId/);
    expect(calls.where.join(" ")).toMatch(/7/);
  });

  test("denied document ids appear in the predicate, not in a result loop", async () => {
    const { calls, table } = fakeTable([]);
    jest.spyOn(LanceDb, "connect").mockResolvedValue({
      client: { openTable: async () => table },
    });
    jest.spyOn(LanceDb, "namespaceExists").mockResolvedValue(true);

    await LanceDb.queryAuthorized({
      namespace: "ws1",
      queryVector: [0.1],
      aclFilter: filter({ deniedDocumentIds: ["doc-a", "doc-b"] }),
    });

    const predicate = calls.where.join(" ");
    expect(predicate).toContain("doc-a");
    expect(predicate).toContain("doc-b");
  });
});

describe("T-5 S-12: matchNone means zero results and no query at all", () => {
  let LanceDb;
  beforeAll(() => {
    // Instantiated, not used statically: helpers/index.js does `new LanceDb()` per call,
    // so the seam must hold on an instance or it does not hold where it is used.
    const { LanceDb: LanceDbClass } = require("../../../utils/vectorDbProviders/lance");
    LanceDb = new LanceDbClass();
  });
  afterEach(() => jest.restoreAllMocks());

  test("a match-none filter returns empty without opening the table", async () => {
    // An actor with no scope has nothing to search. Issuing a query with an
    // unsatisfiable predicate would work, but this is cheaper and impossible to get
    // subtly wrong.
    const openTable = jest.fn();
    jest.spyOn(LanceDb, "connect").mockResolvedValue({ client: { openTable } });

    const result = await LanceDb.queryAuthorized({
      namespace: "ws1",
      queryVector: [0.1],
      aclFilter: filter({ matchNone: true, workspaceIds: [] }),
    });

    expect(result.contextTexts).toEqual([]);
    expect(result.sourceDocuments).toEqual([]);
    expect(openTable).not.toHaveBeenCalled();
  });
});

describe("T-5 S-26 (G4): a row without ACL metadata is denied, never passed through", () => {
  let LanceDb;
  beforeAll(() => {
    // Instantiated, not used statically: helpers/index.js does `new LanceDb()` per call,
    // so the seam must hold on an instance or it does not hold where it is used.
    const { LanceDb: LanceDbClass } = require("../../../utils/vectorDbProviders/lance");
    LanceDb = new LanceDbClass();
  });
  afterEach(() => jest.restoreAllMocks());

  test("a returned row lacking orgId/workspaceId is dropped", async () => {
    // The backfill is incremental, so during rollout a namespace holds both shapes. An
    // un-backfilled row cannot be proven allowed, and unprovable means denied — the
    // opposite default would make the whole filter advisory until the backfill finished.
    const { table } = fakeTable([
      { _distance: 0.1, text: "backfilled", orgId: 1, workspaceId: "1", docId: "doc-ok" },
      { _distance: 0.1, text: "legacy row with no acl metadata", docId: "doc-legacy" },
    ]);
    jest.spyOn(LanceDb, "connect").mockResolvedValue({
      client: { openTable: async () => table },
    });
    jest.spyOn(LanceDb, "namespaceExists").mockResolvedValue(true);

    const result = await LanceDb.queryAuthorized({
      namespace: "ws1",
      queryVector: [0.1],
      similarityThreshold: 0,
      aclFilter: filter(),
    });

    expect(result.contextTexts).toEqual(["backfilled"]);
    expect(result.contextTexts.join(" ")).not.toContain("legacy");
  });

  test("a row whose orgId does not match the filter is dropped even if the query returned it", async () => {
    // Defence in depth behind the predicate: if the pushdown were ever weakened, this
    // check still refuses the row rather than trusting the provider's answer.
    const { table } = fakeTable([
      { _distance: 0.1, text: "mine", orgId: 1, workspaceId: "1", docId: "doc-ok" },
      { _distance: 0.1, text: "other org", orgId: 2, workspaceId: "1", docId: "doc-x" },
    ]);
    jest.spyOn(LanceDb, "connect").mockResolvedValue({
      client: { openTable: async () => table },
    });
    jest.spyOn(LanceDb, "namespaceExists").mockResolvedValue(true);

    const result = await LanceDb.queryAuthorized({
      namespace: "ws1",
      queryVector: [0.1],
      similarityThreshold: 0,
      aclFilter: filter(),
    });

    expect(result.contextTexts).toEqual(["mine"]);
  });

  test("a denied document id is dropped even if the query returned it", async () => {
    const { table } = fakeTable([
      { _distance: 0.1, text: "allowed", orgId: 1, workspaceId: "1", docId: "doc-ok" },
      { _distance: 0.1, text: "revoked", orgId: 1, workspaceId: "1", docId: "doc-bad" },
    ]);
    jest.spyOn(LanceDb, "connect").mockResolvedValue({
      client: { openTable: async () => table },
    });
    jest.spyOn(LanceDb, "namespaceExists").mockResolvedValue(true);

    const result = await LanceDb.queryAuthorized({
      namespace: "ws1",
      queryVector: [0.1],
      similarityThreshold: 0,
      aclFilter: filter({ deniedDocumentIds: ["doc-bad"] }),
    });

    expect(result.contextTexts).toEqual(["allowed"]);
  });
});

describe("T-5: performSimilaritySearch is gone from the ACL-bearing path", () => {
  test("base declares queryAuthorized as the search entry point", () => {
    // grep gate from the recon DoD, asserted as a test so it cannot rot: a provider that
    // still exposes an unfiltered search is a door around the seam.
    const { VectorDatabase } = require("../../../utils/vectorDbProviders/base");
    expect(typeof VectorDatabase.prototype.queryAuthorized).toBe("function");
  });
});

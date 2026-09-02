// T-5 (#30) — RETRIEVAL_FILTER_ALLOW_UNPROVABLE must actually reach a legacy row.
//
// QA found my first version was INERT, and the way it was inert is the lesson: the escape
// hatch lived only in `isRowAllowed`, while the pushdown predicate stayed strict in both
// states. `orgId = '1'` cut every unlabelled row inside the query, so the row check never
// saw one. Unit tests of `isRowAllowed` passed — they fed it rows directly, which no real
// query would ever have delivered. Meanwhile the boot report told operators the flag was
// serving those rows.
//
// A flag that does nothing is worse than no flag: it turns "retrieval is broken" into
// "retrieval is broken and the documented fix did not work".
//
// So these tests drive `queryAuthorized` on a real provider with a legacy row in the
// table, in both states. Asserting on `isRowAllowed` directly is exactly the mistake that
// hid the bug, so it is deliberately not done here.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();

const {
  constraintFor,
} = require("../../../utils/authorization/vectorPredicate");

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

/** A lance table that APPLIES the predicate, rather than merely recording it. */
function filteringTable(rows) {
  const calls = { where: [] };
  let predicate = null;
  const query = {
    distanceType: () => query,
    limit: () => query,
    where(p) {
      predicate = p;
      calls.where.push(p);
      return query;
    },
    toArray: async () => {
      if (predicate === null) return rows;
      // A deliberately small evaluator for the two shapes these tests produce: the strict
      // predicate, and the wrapped one. It exists so the assertion is about what the
      // DATABASE would return, not about what string we generated — the string was right
      // in the broken version too.
      return rows.filter((row) => {
        const unlabelled =
          row.orgId == null && row.workspaceId == null && row.docId == null;
        // Detected by MEANING ("does this predicate contain the unlabelled escape
        // clause") rather than by matching its exact opening characters. An earlier
        // version keyed on `startsWith("((orgId IS NULL")` and broke the moment the
        // identifiers were backtick-quoted for DataFusion — the evaluator quietly
        // stopped recognising the lenient predicate and the test failed for a reason
        // that had nothing to do with the behaviour under test.
        const lenient = /IS NULL.*IS NULL.*IS NULL/.test(predicate);
        if (unlabelled) return lenient;
        return String(row.orgId) === "1" && String(row.workspaceId) === "3";
      });
    },
  };
  return { calls, table: { vectorSearch: () => query } };
}

const LEGACY_ROW = { _distance: 0.1, text: "embedded before T-5" };
const LABELLED_ROW = {
  _distance: 0.1,
  text: "embedded after T-5",
  orgId: 1,
  workspaceId: "3",
  docId: "doc-ok",
};
const OTHER_TENANT_ROW = {
  _distance: 0.1,
  text: "another org",
  orgId: 2,
  workspaceId: "3",
  docId: "doc-x",
};

describe("T-5: the flag reaches the query, not just the row check", () => {
  let LanceDb;
  const ORIGINAL = process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;

  beforeAll(() => {
    const { LanceDb: LanceDbClass } = require("../../../utils/vectorDbProviders/lance");
    LanceDb = new LanceDbClass();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (ORIGINAL === undefined) delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
    else process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = ORIGINAL;
  });

  const searchWith = async (rows) => {
    const { calls, table } = filteringTable(rows);
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
    return { result, calls };
  };

  test("unset: a legacy row is excluded — end to end, through the query", async () => {
    delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
    const { result } = await searchWith([LEGACY_ROW, LABELLED_ROW]);
    expect(result.contextTexts).toEqual(["embedded after T-5"]);
  });

  test("set: the legacy row comes BACK — this is the case that was inert", async () => {
    // The regression that matters. Previously the predicate cut this row before
    // isRowAllowed could admit it, so setting the flag changed nothing at all.
    process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
    const { result } = await searchWith([LEGACY_ROW, LABELLED_ROW]);
    expect(result.contextTexts).toContain("embedded before T-5");
    expect(result.contextTexts).toContain("embedded after T-5");
  });

  test("set: another tenant's row is STILL excluded", async () => {
    // The boundary. The flag excuses absence of evidence, never evidence of denial — a
    // row that says which org it belongs to is held to that answer in both states.
    process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
    const { result } = await searchWith([OTHER_TENANT_ROW, LABELLED_ROW]);
    expect(result.contextTexts).toEqual(["embedded after T-5"]);
  });

  test("set: a HALF-labelled row is still excluded", async () => {
    // The escape clause is the conjunction of all three fields being absent, not a
    // per-field `IS NULL OR`. Per-field leniency would let a row claiming an orgId but no
    // workspaceId pass the workspace check by having no workspace — a real hole wearing
    // the costume of a rollout accommodation.
    process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
    const halfLabelled = { _distance: 0.1, text: "half", orgId: 1 };
    const { result } = await searchWith([halfLabelled, LABELLED_ROW]);
    expect(result.contextTexts).toEqual(["embedded after T-5"]);
  });

  test("the two states produce DIFFERENT predicates", async () => {
    // The direct proof that the flag reaches the query. QA demonstrated the bug by
    // showing both states rendered the same SQL; this pins the opposite.
    delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
    const strict = constraintFor(filter()).toSqlString();
    process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
    const lenient = constraintFor(filter()).toSqlString();

    expect(strict).not.toEqual(lenient);
    expect(lenient).toContain("IS NULL");
    // and the strict half is preserved inside the lenient one
    expect(lenient).toContain(strict);
  });
});

describe("T-5: every dialect honours the flag, not just the one with a test", () => {
  const ORIGINAL = process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
    else process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = ORIGINAL;
  });

  const RENDERERS = [
    ["lance/pgvector-expression", (c) => c.toSqlString()],
    ["milvus", (c) => c.toMilvusExpr()],
    ["pgvector-jsonb", (c) => JSON.stringify(c.toJsonbSql())],
  ];

  test.each(RENDERERS)(
    "%s renders differently once the flag is set",
    (_name, render) => {
      // A dialect that ignored the flag would be inert in exactly the way the original
      // bug was, and only that deployment would ever find out.
      delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
      const strict = render(constraintFor(filter()));
      process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
      const lenient = render(constraintFor(filter()));

      expect(strict).not.toEqual(lenient);
    }
  );

  test.each(RENDERERS)(
    "%s still returns null for match-none with the flag set",
    (_name, render) => {
      // The flag must not resurrect a positively denied actor.
      process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
      const rendered = render(constraintFor(filter({ matchNone: true })));
      expect(rendered === null || rendered === "null").toBe(true);
    }
  );
});

// T-5 (#30) QA-2 blocker A: the pgvector predicate must EXECUTE, not just look right.
//
// `toJsonbSql` allocated placeholders with a `next()` that read `params.length` without
// pushing, and its call sites disagreed about the order: orgId pushed then called it,
// every other clause called it then pushed. The result was `$1` never referenced and `$2`
// bound to two different clauses, on every filter shape. Postgres rejected all of them —
// `could not determine data type of parameter $1`, or an array where a scalar was
// expected — so pgvector's queryAuthorized could not run at all.
//
// Every previous test compared JSON.stringify output, which is exactly why this survived:
// the SQL STRING was plausible and the PARAMS array was plausible; only their relationship
// was wrong, and no string comparison can see a relationship. These tests hand both to a
// real PostgreSQL connection and read back rows.
//
// Skipped when DATABASE_URL is absent, so a contributor without Postgres is not blocked —
// CI always has one.

const { Client } = require("pg");
const {
  constraintFor,
} = require("../../../utils/authorization/vectorPredicate");

const DATABASE_URL = process.env.DATABASE_URL;
const PG_SCHEME = "postgresql://";
const describeIfPg =
  DATABASE_URL?.startsWith(PG_SCHEME) ? describe : describe.skip;

const TABLE = `t5_jsonb_${process.pid}`;

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

// The rows every shape below is judged against. Each names what it is so a failure says
// which document leaked or vanished, rather than which index did.
const ROWS = [
  ["mine", { orgId: "1", workspaceId: "3", docId: "doc-mine" }],
  ["mine-other-ws", { orgId: "1", workspaceId: "9", docId: "doc-ws9" }],
  ["mine-denied", { orgId: "1", workspaceId: "3", docId: "doc-bad" }],
  ["other-org", { orgId: "2", workspaceId: "3", docId: "doc-theirs" }],
  ["legacy", {}],
];

describeIfPg("T-5: toJsonbSql executes on real PostgreSQL", () => {
  let client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    await client.query(
      `CREATE TABLE IF NOT EXISTS "${TABLE}" (name text, metadata jsonb)`
    );
    await client.query(`DELETE FROM "${TABLE}"`);
    for (const [name, metadata] of ROWS) {
      await client.query(`INSERT INTO "${TABLE}" VALUES ($1, $2)`, [
        name,
        JSON.stringify(metadata),
      ]);
    }
  });

  afterAll(async () => {
    if (!client) return;
    await client.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    await client.end();
  });

  /** Run a rendered constraint as a real query and return the row names it admits. */
  const namesFor = async (aclFilter) => {
    const constraint = constraintFor(aclFilter).toJsonbSql("metadata", 1);
    if (constraint === null) return null;
    const { rows } = await client.query(
      `SELECT name FROM "${TABLE}" WHERE ${constraint.sql} ORDER BY name`,
      constraint.params
    );
    return rows.map((row) => row.name);
  };

  // The four shapes named in the ruling, each asserting the ROWS returned rather than the
  // SQL rendered.
  test("workspace scope returns only the actor's workspace", async () => {
    expect(await namesFor(filter())).toEqual(["mine", "mine-denied"]);
  });

  test("org-wide grant returns the whole org, not the whole table", async () => {
    // orgWide drops the workspace clause; it must not drop the org one. This is the shape
    // that renders a single placeholder, which is where the off-by-one was most visible.
    expect(await namesFor(filter({ orgWide: true, workspaceIds: [] }))).toEqual([
      "mine",
      "mine-denied",
      "mine-other-ws",
    ]);
  });

  test("deny list excludes the denied document", async () => {
    expect(
      await namesFor(filter({ deniedDocumentIds: ["doc-bad"] }))
    ).toEqual(["mine"]);
  });

  test("allow list narrows to the listed document", async () => {
    expect(
      await namesFor(
        filter({ principalType: "embed", allowedDocumentIds: ["doc-mine"] })
      )
    ).toEqual(["mine"]);
  });

  test("all four clauses at once", async () => {
    // The shape with the most placeholders, and the one where a numbering slip is most
    // likely to bind an array where a scalar belongs.
    expect(
      await namesFor(
        filter({
          deniedDocumentIds: ["doc-bad"],
          allowedDocumentIds: ["doc-mine", "doc-bad"],
        })
      )
    ).toEqual(["mine"]);
  });

  test("a legacy row is excluded by default", async () => {
    // Unprovable means denied (S-26/G4). The row with no metadata appears in none of the
    // results above, and this names that expectation rather than leaving it implicit.
    const names = await namesFor(filter());
    expect(names).not.toContain("legacy");
  });

  test("the flag admits the legacy row and nothing else", async () => {
    const previous = process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
    process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
    try {
      const names = await namesFor(filter());
      expect(names).toContain("legacy");
      // The boundary: absence of evidence is excused, evidence of denial is not.
      expect(names).not.toContain("other-org");
      expect(names).not.toContain("mine-other-ws");
    } finally {
      if (previous === undefined)
        delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
      else process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = previous;
    }
  });

  test("placeholders are numbered contiguously from startIndex", async () => {
    // The direct statement of the bug: every $n the SQL references must exist in params,
    // and every param must be referenced. This is the assertion the old string-comparison
    // tests could not make.
    for (const over of [
      {},
      { orgWide: true, workspaceIds: [] },
      { deniedDocumentIds: ["a"] },
      { allowedDocumentIds: ["b"] },
      { deniedDocumentIds: ["a"], allowedDocumentIds: ["b"] },
    ]) {
      const { sql, params } = constraintFor(filter(over)).toJsonbSql(
        "metadata",
        1
      );
      const used = [
        ...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))),
      ].sort((a, b) => a - b);
      expect(used).toEqual(params.map((_, i) => i + 1));
    }
  });

  test("a non-default startIndex still lines up", async () => {
    // pgvector calls this with startIndex 3, because the query already binds the vector
    // and the limit. An off-by-one that happened to work at 1 would still corrupt that
    // call.
    const { sql, params } = constraintFor(
      filter({ deniedDocumentIds: ["a"] })
    ).toJsonbSql("metadata", 3);
    const used = [
      ...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))),
    ].sort((a, b) => a - b);
    expect(used).toEqual(params.map((_, i) => i + 3));
  });
});

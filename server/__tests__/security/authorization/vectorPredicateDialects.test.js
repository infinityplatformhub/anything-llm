// T-5 (#30) slice 1b — the remaining five providers get a real ACL pushdown.
//
// Slice 1a shipped Lance, PGVector and Milvus; the other five threw
// RetrievalFilterUnsupportedError, which is safe but leaves those deployments without
// retrieval. This closes that.
//
// Each of the five has its own filter DSL, so each gets its own renderer off the SAME
// neutral RetrievalConstraint. The thing being tested here is that the five renderers
// agree about MEANING — a predicate that is subtly weaker in one dialect is a leak that
// only that deployment sees, and nobody would find it by reading the other four.
//
// The shared-contract table below is the real assertion. Testing each renderer in
// isolation would let one of them quietly disagree; asserting the same five properties
// against all of them is what makes "denied" one thing rather than five.
//
// RED on 52b3d176: toQdrantFilter/toPineconeFilter/toChromaWhere/toWeaviateWhere/
// toAstraFilter do not exist.

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

/** Every renderer under test, named so a failure says which dialect broke. */
const RENDERERS = [
  ["qdrant", (c) => c.toQdrantFilter()],
  ["pinecone", (c) => c.toPineconeFilter()],
  ["chroma", (c) => c.toChromaWhere()],
  ["weaviate", (c) => c.toWeaviateWhere()],
  ["astra", (c) => c.toAstraFilter()],
];

describe("T-5 slice 1b: every dialect refuses to render a match-none filter", () => {
  test.each(RENDERERS)("%s returns null for match-none", (_name, render) => {
    // null is the instruction to SKIP the query entirely. A dialect that instead returned
    // an empty filter object would issue an unrestricted search — the exact inversion of
    // what match-none means, and the most dangerous single bug available here.
    expect(render(constraintFor(filter({ matchNone: true })))).toBeNull();
  });

  test.each(RENDERERS)("%s returns null for an empty scope", (_name, render) => {
    // No workspaces and no org-wide grant is the same instruction.
    expect(
      render(constraintFor(filter({ workspaceIds: [], orgWide: false })))
    ).toBeNull();
  });
});

describe("T-5 slice 1b: every dialect carries the org", () => {
  test.each(RENDERERS)("%s constrains orgId", (_name, render) => {
    // The tenant boundary. A dialect that dropped this would let one org's search reach
    // another's vectors in that deployment only.
    const rendered = JSON.stringify(render(constraintFor(filter({ orgId: 7 }))));
    expect(rendered).toContain("orgId");
    expect(rendered).toContain("7");
  });
});

describe("T-5 slice 1b: every dialect carries the workspace scope", () => {
  test.each(RENDERERS)("%s constrains workspaceId", (_name, render) => {
    const rendered = JSON.stringify(
      render(constraintFor(filter({ workspaceIds: ["3", "9"] })))
    );
    expect(rendered).toContain("workspaceId");
    expect(rendered).toContain("3");
    expect(rendered).toContain("9");
  });

  test.each(RENDERERS)(
    "%s omits the workspace clause for an org-wide grant",
    (_name, render) => {
      // orgWide is scope on its own: a service principal has no membership rows to
      // enumerate, so narrowing to an empty workspace list would deny it everything.
      const rendered = JSON.stringify(
        render(constraintFor(filter({ orgWide: true, workspaceIds: [] })))
      );
      expect(rendered).toContain("orgId");
      expect(rendered).not.toContain("workspaceId");
    }
  );
});

describe("T-5 slice 1b: every dialect carries the deny list", () => {
  test.each(RENDERERS)("%s excludes denied documents", (_name, render) => {
    // Deny-wins, inlined rather than applied afterwards, so a denied document cannot
    // occupy a topN slot and displace one the actor may read.
    const rendered = JSON.stringify(
      render(constraintFor(filter({ deniedDocumentIds: ["doc-bad"] })))
    );
    expect(rendered).toContain("doc-bad");
  });
});

describe("T-5 slice 1b: every dialect carries an explicit allow list", () => {
  test.each(RENDERERS)("%s narrows to allowedDocumentIds", (_name, render) => {
    const rendered = JSON.stringify(
      render(
        constraintFor(
          filter({
            principalType: "embed",
            allowedDocumentIds: ["doc-ok"],
          })
        )
      )
    );
    expect(rendered).toContain("doc-ok");
  });

  test.each(RENDERERS)(
    "%s returns null for an EMPTY allow list",
    (_name, render) => {
      // [] means "allow nothing", not "no restriction". Rendering it as an absent clause
      // would turn the most restrictive filter into the least.
      expect(
        render(
          constraintFor(
            filter({ principalType: "embed", allowedDocumentIds: [] })
          )
        )
      ).toBeNull();
    }
  );
});

describe("T-5 slice 1b: all five providers expose queryAuthorized", () => {
  const PROVIDERS = [
    ["QDrant", "qdrant"],
    ["Pinecone", "pinecone"],
    ["Chroma", "chroma"],
    ["Weaviate", "weaviate"],
    ["AstraDB", "astra"],
  ];

  test.each(PROVIDERS)(
    "%s implements its own queryAuthorized",
    (exportName, dir) => {
      // Inheriting base's would throw RetrievalFilterUnsupportedError — correct for a
      // provider without a pushdown, wrong once it has one, and the difference is
      // invisible until someone deploys it.
      const module = require(`../../../utils/vectorDbProviders/${dir}`);
      const Provider = module[exportName];
      const {
        VectorDatabase,
      } = require("../../../utils/vectorDbProviders/base");
      expect(Provider.prototype.queryAuthorized).toBeDefined();
      expect(Provider.prototype.queryAuthorized).not.toBe(
        VectorDatabase.prototype.queryAuthorized
      );
    }
  );

  test.each(PROVIDERS)(
    "%s is listed as supported in the boot report",
    (_exportName, dir) => {
      // The boot report is how an operator learns whether retrieval works at all. A
      // provider that gained a pushdown but stayed off this list would warn about a
      // problem it no longer has.
      const {
        SUPPORTED_PROVIDERS,
      } = require("../../../utils/authorization/retrievalSupport");
      expect(SUPPORTED_PROVIDERS).toContain(dir);
    }
  );
});

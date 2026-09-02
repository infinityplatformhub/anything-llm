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

describe("T-5 slice 1b: the flag reaches every dialect that can express it", () => {
  // The bug slice 1a was failed for, twice: an escape clause that lives only in
  // `isRowAllowed` while the pushdown stays strict. The pushdown removes the unlabelled
  // row before the row check ever sees it, so the flag does nothing while the boot report
  // says otherwise. Four of these five dialects CAN express absence; each is asserted to
  // render differently once the flag is set, so a renderer that silently ignored it
  // cannot ship.
  const CAN_ESCAPE = RENDERERS.filter(([name]) => name !== "chroma");
  const ORIGINAL = process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;

  const withFlag = (on, fn) => {
    if (on) process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
    else delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
    try {
      return fn();
    } finally {
      if (ORIGINAL === undefined)
        delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
      else process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = ORIGINAL;
    }
  };

  test.each(CAN_ESCAPE)(
    "%s renders differently once the flag is set",
    (_name, render) => {
      const strict = JSON.stringify(
        withFlag(false, () => render(constraintFor(filter())))
      );
      const lenient = JSON.stringify(
        withFlag(true, () => render(constraintFor(filter())))
      );
      expect(strict).not.toEqual(lenient);
    }
  );

  test.each(CAN_ESCAPE)(
    "%s keeps the strict predicate intact inside the escape clause",
    (_name, render) => {
      // The escape widens by adding an alternative, never by loosening the original. If
      // the strict half were rewritten, a row WITH metadata could start passing on a
      // technicality rather than on its provenance.
      const strict = JSON.stringify(
        withFlag(false, () => render(constraintFor(filter())))
      );
      const lenient = JSON.stringify(
        withFlag(true, () => render(constraintFor(filter())))
      );
      expect(lenient).toContain(strict);
    }
  );

  test.each(CAN_ESCAPE)(
    "%s checks ALL THREE fields for absence, never one",
    (_name, render) => {
      // All-or-nothing. A per-field relaxation would let a row claiming an orgId but no
      // workspaceId pass the workspace check by having no workspace — a real hole wearing
      // the costume of a rollout accommodation.
      const lenient = JSON.stringify(
        withFlag(true, () => render(constraintFor(filter())))
      );
      const mentions = (field) =>
        (lenient.match(new RegExp(field, "g")) || []).length;
      expect(mentions("orgId")).toBeGreaterThanOrEqual(2);
      expect(mentions("workspaceId")).toBeGreaterThanOrEqual(2);
      expect(mentions("docId")).toBeGreaterThanOrEqual(1);
    }
  );

  test.each(RENDERERS)(
    "%s still returns null for match-none with the flag set",
    (_name, render) => {
      // The flag excuses absence of evidence, never evidence of denial. A positively
      // denied actor stays denied in both states.
      expect(
        withFlag(true, () => render(constraintFor(filter({ matchNone: true }))))
      ).toBeNull();
    }
  );

  test("chroma renders IDENTICALLY in both states — it cannot express absence", () => {
    // Ruling (Techlead, option A): Chroma's operator set is closed
    // ($gt $gte $lt $lte $ne $eq $in $nin) with no $exists, so the escape clause is not
    // expressible. This asserts EQUALITY rather than merely "does not throw" — an
    // accidental partial escape here would be the inert-flag bug again, in one dialect
    // where only that deployment would ever notice.
    const strict = JSON.stringify(
      withFlag(false, () => constraintFor(filter()).toChromaWhere())
    );
    const flagged = JSON.stringify(
      withFlag(true, () => constraintFor(filter()).toChromaWhere())
    );
    expect(flagged).toEqual(strict);
  });
});

describe("T-5 slice 1b: weaviate stays inside its closed operator enum", () => {
  // weaviate-ts-client's WhereFilter operator union is fixed:
  //   And Or Equal Like NotEqual GreaterThan GreaterThanEqual LessThan LessThanEqual
  //   WithinGeoRange IsNull ContainsAny ContainsAll
  // There is no `Not`. An earlier draft of this renderer emitted `operator: "Not"` around
  // a ContainsAny for the deny-list. That is not a valid operator, so the deny-list would
  // have errored or been dropped — and a DROPPED deny-list re-admits revoked documents,
  // the worst direction for this particular bug to fail in.
  const VALID = new Set([
    "And",
    "Or",
    "Equal",
    "Like",
    "NotEqual",
    "GreaterThan",
    "GreaterThanEqual",
    "LessThan",
    "LessThanEqual",
    "WithinGeoRange",
    "IsNull",
    "ContainsAny",
    "ContainsAll",
  ]);

  const operatorsIn = (node, found = []) => {
    if (!node || typeof node !== "object") return found;
    if (typeof node.operator === "string") found.push(node.operator);
    for (const operand of node.operands ?? []) operatorsIn(operand, found);
    return found;
  };

  const CASES = [
    ["plain scope", {}],
    ["deny list", { deniedDocumentIds: ["a", "b"] }],
    ["allow list", { principalType: "embed", allowedDocumentIds: ["ok"] }],
    ["org-wide", { orgWide: true, workspaceIds: [] }],
    ["deny + allow", { deniedDocumentIds: ["a"], allowedDocumentIds: ["ok"] }],
  ];

  test.each(CASES)("%s emits only enum operators", (_name, over) => {
    const operators = operatorsIn(constraintFor(filter(over)).toWeaviateWhere());
    expect(operators.length).toBeGreaterThan(0);
    for (const operator of operators) expect(VALID.has(operator)).toBe(true);
  });

  test.each(CASES)("%s never emits Not", (_name, over) => {
    // Pinned separately from the enum check above: `Not` is the specific mistake that was
    // in this file, and naming it makes a regression legible rather than generic.
    expect(
      operatorsIn(constraintFor(filter(over)).toWeaviateWhere())
    ).not.toContain("Not");
  });

  test("the escape clause also emits only enum operators", () => {
    const previous = process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
    process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
    try {
      const operators = operatorsIn(
        constraintFor(filter({ deniedDocumentIds: ["a"] })).toWeaviateWhere()
      );
      for (const operator of operators) expect(VALID.has(operator)).toBe(true);
      expect(operators).toContain("IsNull");
      expect(operators).toContain("Or");
    } finally {
      if (previous === undefined)
        delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
      else process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = previous;
    }
  });

  test("a multi-id deny list becomes one NotEqual per id", () => {
    // Weaviate has no NOT-IN, so "none of these" is a conjunction. If this collapsed to a
    // single clause, every id after the first would be silently un-denied.
    const rendered = constraintFor(
      filter({ deniedDocumentIds: ["a", "b", "c"] })
    ).toWeaviateWhere();
    expect(operatorsIn(rendered).filter((o) => o === "NotEqual")).toHaveLength(3);
  });
});

describe("T-5 slice 1b: the boot report tells the truth about chroma", () => {
  const {
    reportRetrievalFilterSupport,
    NO_ESCAPE_CLAUSE_PROVIDERS,
  } = require("../../../utils/authorization/retrievalSupport");

  const ORIGINAL = process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
  afterEach(() => {
    if (ORIGINAL === undefined)
      delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
    else process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = ORIGINAL;
  });

  const logger = () => ({ warn: jest.fn(), error: jest.fn() });

  test("chroma is declared as having no escape clause", () => {
    expect(NO_ESCAPE_CLAUSE_PROVIDERS).toContain("chroma");
  });

  test("setting the flag on chroma logs an ERROR at boot", async () => {
    // The whole point of option A. An operator who sets their one documented lever and
    // sees nothing change cannot tell a broken flag from a broken deployment. Silence
    // here is the failure this slice was corrected for twice; this is the correction.
    process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
    const log = logger();
    await reportRetrievalFilterSupport("chroma", log);
    expect(log.error).toHaveBeenCalled();
    const message = log.error.mock.calls[0][0];
    expect(message).toContain("NO EFFECT");
    expect(message).toContain("RETRIEVAL_FILTER_ALLOW_UNPROVABLE");
    expect(message).toContain("backfill");
  });

  test("NOT setting the flag on chroma logs no error", async () => {
    // The error is about a contradiction between what was asked for and what can be
    // delivered. With nothing asked for there is no contradiction, and an unconditional
    // error would train operators to ignore this line.
    delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
    const log = logger();
    await reportRetrievalFilterSupport("chroma", log);
    expect(log.error).not.toHaveBeenCalled();
  });

  test("setting the flag on a provider that CAN escape logs no error", async () => {
    process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
    const log = logger();
    await reportRetrievalFilterSupport("qdrant", log);
    expect(log.error).not.toHaveBeenCalled();
  });

  test("the report says the flag is unavailable, not that rows are served", async () => {
    // The 1a bug in miniature: reporting the VARIABLE rather than its EFFECT is how
    // operators were told their rows were being served when they were not.
    process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
    const result = await reportRetrievalFilterSupport("chroma", logger());
    expect(result.escapeClauseUnavailable).toBe(true);
  });
});

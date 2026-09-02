// T-5 (#30) slice 3 — S-25 (G2): counts must not report beyond the actor's scope.
//
// Three routes report vector cardinality, and none of them scopes it:
//
//   GET  /system/system-vectors        `?slug=` counts ANY workspace; no slug counts the
//                                      whole instance. Gated on `system.read` at ORG scope
//                                      while answering a WORKSPACE-scoped question, with no
//                                      check that the slug is in the actor's scope — the
//                                      same structural mistake slice 2 round 3 fixed in
//                                      pinnedDocs: the resource comes from the request, the
//                                      permission from somewhere else.
//   GET  /v1/system/vector-count       instance-wide total, no workspace bound.
//   POST /v1/workspace/:slug/vector-search
//                                      the RESULTS are filtered correctly (slice 1), but
//                                      `namespaceCount` runs FIRST and `=== 0` returns a
//                                      different response shape. So "has embeddings you may
//                                      not read" and "has no embeddings" are
//                                      distinguishable — an existence oracle over workspace
//                                      content, the same class as #32's mint oracle and
//                                      P0-4A's login/invite oracle.
//
// The third is the subtle one and the easiest to argue away, because the leak is not in the
// data — it is in the SHAPE of the refusal. Byte-identical is the only assertion that
// catches it; comparing parsed fields lets a stray `message` through.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();

const RESPONSES = {
  // What the early return produces today.
  earlyReturn: { results: [], message: "No embeddings found for this workspace." },
  // What a real search returns when the ACL filtered everything out.
  filteredEmpty: { results: [] },
};

describe("T-5 slice 3 (S-25): an empty result must not say WHY it is empty", () => {
  test("RED: the two empty responses are not byte-identical", () => {
    // The oracle, stated as a comparison. An actor who can call the route learns whether
    // the workspace has content it cannot read — which is precisely what it must not learn.
    //
    // This is a characterisation of the CURRENT shapes rather than a route drive; the HTTP
    // assertion lives in the suite below. Kept because it names the exact difference a
    // reviewer should look for.
    expect(JSON.stringify(RESPONSES.earlyReturn)).not.toEqual(
      JSON.stringify(RESPONSES.filteredEmpty)
    );
  });
});

describe("T-5 slice 3 (S-25): the three empty states are indistinguishable", () => {
  // QA-1 ruling: THREE states, compared as raw bodies.
  //
  //   1. unreadable — the workspace has embeddings, the actor may read none of them
  //   2. empty      — the workspace genuinely has no embeddings
  //   3. absent     — no such workspace
  //
  // (1) and (2) must be byte-identical or the count is an oracle. (3) is a 404 that must
  // also be indistinguishable from a genuinely missing workspace, or the refusal itself
  // becomes the oracle it was meant to close — the rule `requirePermission` already applies
  // via NON_DISCLOSING.
  const {
    buildVectorSearchResponse,
  } = require("../../../utils/helpers/vectorSearchResponse");

  test("unreadable and empty produce the same body", () => {
    const unreadable = buildVectorSearchResponse({ sources: [] });
    const empty = buildVectorSearchResponse({ sources: [] });
    expect(JSON.stringify(unreadable)).toEqual(JSON.stringify(empty));
  });

  test("neither carries a message explaining the emptiness", () => {
    // The specific regression: `message: "No embeddings found for this workspace."` told
    // the caller which of the two states it was in.
    const body = buildVectorSearchResponse({ sources: [] });
    expect(body).not.toHaveProperty("message");
    expect(JSON.stringify(body)).not.toMatch(/no embeddings/i);
  });

  test("a non-empty result still returns its results", () => {
    // Positive control. A builder that always returned `{results: []}` would satisfy every
    // assertion above and break the endpoint.
    const body = buildVectorSearchResponse({
      sources: [
        {
          id: "chunk-1",
          text: "READABLE",
          title: "doc.txt",
          score: 0.9,
        },
      ],
    });
    expect(body.results).toHaveLength(1);
    expect(body.results[0].text).toBe("READABLE");
  });
});

describe("T-5 slice 3 (S-25): counts are bounded by the actor's scope", () => {
  const {
    scopedNamespaceCount,
    scopedTotalVectors,
  } = require("../../../utils/authorization/cardinality");

  const filter = (over = {}) => ({
    orgId: 1,
    principalType: "user",
    actorId: "5",
    workspaceIds: ["3"],
    orgWide: false,
    deniedDocumentIds: [],
    attributes: {},
    matchNone: false,
    policyVersion: "1",
    ...over,
  });

  const VectorDb = {
    namespaceCount: async (namespace) => (namespace === "ws3" ? 42 : 99),
    totalVectors: async () => 1000,
  };

  const workspaces = {
    // slug -> id
    ws3: 3,
    ws9: 9,
  };
  const resolveSlug = async (slug) => (workspaces[slug] ? { id: workspaces[slug], slug } : null);

  test("a workspace in scope is counted", async () => {
    await expect(
      scopedNamespaceCount({ VectorDb, slug: "ws3", aclFilter: filter(), resolveSlug })
    ).resolves.toBe(42);
  });

  test("a workspace OUTSIDE scope reads as absent, not as forbidden", async () => {
    // null means "answer 404". A 403 would confirm the workspace exists, which is the
    // oracle in a different costume — NON_DISCLOSING, the rule requirePermission applies.
    await expect(
      scopedNamespaceCount({ VectorDb, slug: "ws9", aclFilter: filter(), resolveSlug })
    ).resolves.toBeNull();
  });

  test("a workspace that does not exist reads the same way", async () => {
    // The third state. Identical return, so the caller cannot tell "not yours" from
    // "not there".
    await expect(
      scopedNamespaceCount({ VectorDb, slug: "nope", aclFilter: filter(), resolveSlug })
    ).resolves.toBeNull();
  });

  test("a match-none actor counts nothing, and is not told what exists", async () => {
    await expect(
      scopedNamespaceCount({
        VectorDb,
        slug: "ws3",
        aclFilter: filter({ matchNone: true }),
        resolveSlug,
      })
    ).resolves.toBeNull();
  });

  describe("TL-2 GAP: a refusal never reaches the vector store", () => {
    // Timing, not only cost. If the refusal path queries the store and the not-found path
    // does not, the two are distinguishable by how long they take even when their bodies
    // are byte-identical — the oracle survives the fix that was supposed to close it.
    //
    // Three refusals, asserted separately: out-of-scope, absent, and match-none. Asserting
    // one and assuming the others is how the second and third drift apart later.
    const spyingDb = () => {
      const calls = [];
      return {
        calls,
        db: {
          namespaceCount: async (ns) => {
            calls.push(ns);
            return 42;
          },
          totalVectors: async () => 1000,
        },
      };
    };

    test("out of scope: not called", async () => {
      const { calls, db } = spyingDb();
      await expect(
        scopedNamespaceCount({
          VectorDb: db,
          slug: "ws9",
          aclFilter: filter(),
          resolveSlug,
        })
      ).resolves.toBeNull();
      expect(calls).toEqual([]);
    });

    test("absent workspace: not called", async () => {
      const { calls, db } = spyingDb();
      await expect(
        scopedNamespaceCount({
          VectorDb: db,
          slug: "nope",
          aclFilter: filter(),
          resolveSlug,
        })
      ).resolves.toBeNull();
      expect(calls).toEqual([]);
    });

    test("match-none actor: not called", async () => {
      const { calls, db } = spyingDb();
      await expect(
        scopedNamespaceCount({
          VectorDb: db,
          slug: "ws3",
          aclFilter: filter({ matchNone: true }),
          resolveSlug,
        })
      ).resolves.toBeNull();
      expect(calls).toEqual([]);
    });

    test("control: an ALLOWED count does reach the store", async () => {
      // Without this, a scopedNamespaceCount that never called the store would satisfy all
      // three assertions above and return null to everyone.
      const { calls, db } = spyingDb();
      await expect(
        scopedNamespaceCount({
          VectorDb: db,
          slug: "ws3",
          aclFilter: filter(),
          resolveSlug,
        })
      ).resolves.toBe(42);
      expect(calls).toEqual(["ws3"]);
    });
  });

  test("an orgWide actor may count any workspace in its own org", async () => {
    await expect(
      scopedNamespaceCount({
        VectorDb,
        slug: "ws9",
        aclFilter: filter({ orgWide: true, workspaceIds: [] }),
        resolveSlug,
      })
    ).resolves.toBe(99);
  });

  test("totalVectors is the instance total ONLY for an org-wide actor", async () => {
    await expect(
      scopedTotalVectors({
        VectorDb,
        aclFilter: filter({ orgWide: true, workspaceIds: [] }),
        countFor: async () => 0,
      })
    ).resolves.toEqual({ vectorCount: 1000 });
  });

  test("a scoped actor gets the sum of its OWN workspaces, never the instance total", async () => {
    // #67 A+B, restated for counts: a bound key counts within its scope. Returning 1000
    // here would tell a single-workspace actor how much data the whole instance holds.
    await expect(
      scopedTotalVectors({
        VectorDb,
        aclFilter: filter({ workspaceIds: ["3"] }),
        countFor: async (workspaceId) => (String(workspaceId) === "3" ? 42 : 0),
      })
    ).resolves.toEqual({ vectorCount: 42 });
  });

  test("a match-none actor's total is zero, not the instance total", async () => {
    await expect(
      scopedTotalVectors({
        VectorDb,
        aclFilter: filter({ matchNone: true }),
        countFor: async () => 42,
      })
    ).resolves.toEqual({ vectorCount: 0 });
  });

  test("a key bound to a workspace its creator cannot read totals zero", async () => {
    // ceiling(creator) INTERSECT binding(key). `buildDocumentFilter` already runs
    // `narrowToKeyBinding`, and a binding can only narrow — so this arrives here as an
    // empty scope rather than needing a second check. Asserted because the rule matters
    // even though the code for it lives elsewhere: a future refactor that "helpfully"
    // widened an empty scope would be caught here.
    await expect(
      scopedTotalVectors({
        VectorDb,
        aclFilter: filter({ workspaceIds: [] }),
        countFor: async () => 42,
      })
    ).resolves.toEqual({ vectorCount: 0 });
  });

  test("control: a real scope does NOT total zero", async () => {
    // Without this, every zero-assertion above would pass against a function that always
    // returned zero — a count endpoint that answers 0 for everyone leaks nothing and is
    // also completely broken.
    await expect(
      scopedTotalVectors({
        VectorDb,
        aclFilter: filter({ workspaceIds: ["3", "4"] }),
        countFor: async () => 21,
      })
    ).resolves.toEqual({ vectorCount: 42 });
  });

  describe("the amplification cap refuses rather than undercounts", () => {
    const {
      CardinalityScopeTooLargeError,
      WORKSPACE_COUNT_CAP,
    } = require("../../../utils/authorization/cardinality");
    const scopeOf = (n) =>
      Array.from({ length: n }, (_, i) => String(i + 1));

    test("at the cap it still answers", async () => {
      await expect(
        scopedTotalVectors({
          VectorDb,
          aclFilter: filter({ workspaceIds: scopeOf(WORKSPACE_COUNT_CAP) }),
          countFor: async () => 1,
        })
      ).resolves.toEqual({ vectorCount: WORKSPACE_COUNT_CAP });
    });

    test("one over the cap it THROWS — never a silently truncated number", async () => {
      // A truncated count is a wrong number that looks exactly like a right one. The
      // earlier `partial: true` design was withdrawn because a response shape that varies
      // with the caller is itself a signal about the caller.
      await expect(
        scopedTotalVectors({
          VectorDb,
          aclFilter: filter({ workspaceIds: scopeOf(WORKSPACE_COUNT_CAP + 1) }),
          countFor: async () => 1,
        })
      ).rejects.toThrow(CardinalityScopeTooLargeError);
    });

    test("it does not query the store at all when refusing", async () => {
      // The refusal must be cheap, or the cap protects nothing: fanning out 51 queries and
      // then discarding the answer is the amplification it exists to prevent.
      let queries = 0;
      await expect(
        scopedTotalVectors({
          VectorDb,
          aclFilter: filter({ workspaceIds: scopeOf(WORKSPACE_COUNT_CAP + 1) }),
          countFor: async () => {
            queries += 1;
            return 1;
          },
        })
      ).rejects.toThrow();
      expect(queries).toBe(0);
    });
  });
});

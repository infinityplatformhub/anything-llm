// T-5 (#30) slice 1b — Weaviate, where the escape clause depends on the CLASS, not the
// provider.
//
// Techlead-2 found that with the flag set every Weaviate query threw. Two separate causes,
// both measured on Weaviate 1.24.10, and both fixed only at class creation:
//
//   1. A class whose first object predated T-5 has no `orgId` PROPERTY at all — Weaviate
//      infers the schema from what is written — so a where naming it fails with
//      "no such prop with name 'orgId' found in class".
//   2. Even with the properties declared, `IsNull` needs
//      `invertedIndexConfig.indexNullState: true`, or it fails with
//      "Nullstate must be indexed to be filterable".
//
// Neither can be added later:
//
//   PUT /v1/schema/<class>
//     -> 422 "inverted index config: IndexNullState cannot be changed when updating a schema"
//
// So an existing class cannot be upgraded in place; it has to be dropped and re-embedded.
//
// And the consequence is stronger than "the escape clause is unavailable there". Because
// the PROPERTIES do not exist, no ACL predicate is expressible on such a class at all —
// `Equal orgId '1'` fails exactly like `IsNull orgId`. There is no strict fallback to keep.
// The read path therefore REFUSES the class in both flag states, the same answer Lance
// gives for a table that predates the ACL columns.
//
// Dropping the `where` and serving the class was considered and rejected. On this provider
// the whole predicate is that one clause, so removing it returns every object with no ACL —
// not the unlabelled ones, all of them. That is a hole rather than a rollout
// accommodation, and it would make the flag mean something different here than everywhere
// else.
//
// Requires Weaviate. Skipped without WEAVIATE_TEST_URL:
//
//   docker run -d --name weaviate -p 8085:8080 \
//     -e AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=true \
//     -e PERSISTENCE_DATA_PATH=/var/lib/weaviate \
//     -e DEFAULT_VECTORIZER_MODULE=none -e CLUSTER_HOSTNAME=node1 \
//     semitechnologies/weaviate:1.24.10
//   WEAVIATE_TEST_URL=localhost:8085 yarn test weaviateRealStoreAcl

const {
  constraintFor,
} = require("../../../utils/authorization/vectorPredicate");
const {
  hasAclSchema,
  aclClassConfig,
  ACL_CLASS_PROPERTIES,
} = require("../../../utils/vectorDbProviders/weaviate");

const HOST = process.env.WEAVIATE_TEST_URL;
const describeIfWeaviate = HOST ? describe : describe.skip;

const MODERN = `Modern${process.pid}`;
const LEGACY = `Legacy${process.pid}`;

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

describeIfWeaviate("T-5: Weaviate ACL filtering on real classes", () => {
  let client;

  beforeAll(async () => {
    const weaviate = require("weaviate-ts-client").default;
    client = weaviate.client({ scheme: "http", host: HOST });

    for (const name of [MODERN, LEGACY]) {
      await client.schema.classDeleter().withClassName(name).do().catch(() => {});
    }

    // A class created the way the provider creates them NOW.
    await client.schema
      .classCreator()
      .withClass({
        class: MODERN,
        vectorizer: "none",
        // Built from the SHIPPING config rather than a hand-written copy, so a change to
        // what the provider creates cannot pass here while breaking production. An
        // earlier version of this test declared the properties itself and missed the
        // tokenization entirely.
        ...aclClassConfig(),
        properties: [
          { name: "text", dataType: ["text"] },
          ...aclClassConfig().properties,
        ],
      })
      .do();
    await client.data
      .creator()
      .withClassName(MODERN)
      .withProperties({
        text: "mine",
        orgId: "1",
        workspaceId: "3",
        docId: "doc-mine",
      })
      .withVector([0.1, 0.2])
      .do();
    await client.data
      .creator()
      .withClassName(MODERN)
      .withProperties({ text: "legacy row" })
      .withVector([0.1, 0.21])
      .do();
    // Two ids sharing the token `doc`. Under `word` tokenization a NotEqual on "doc-bad"
    // drops BOTH; under `field` it drops only the first. This pair is what makes the
    // difference observable at all.
    await client.data
      .creator()
      .withClassName(MODERN)
      .withProperties({
        text: "denied",
        orgId: "1",
        workspaceId: "3",
        docId: "doc-bad",
      })
      .withVector([0.1, 0.22])
      .do();
    await client.data
      .creator()
      .withClassName(MODERN)
      .withProperties({
        text: "shares-a-token",
        orgId: "1",
        workspaceId: "3",
        docId: "doc-good",
      })
      .withVector([0.1, 0.23])
      .do();

    // A class as it exists on a deployment that upgraded: no ACL properties, no
    // indexNullState. Weaviate inferred this schema from a pre-T-5 document.
    await client.schema
      .classCreator()
      .withClass({
        class: LEGACY,
        vectorizer: "none",
        properties: [{ name: "text", dataType: ["text"] }],
      })
      .do();
    await client.data
      .creator()
      .withClassName(LEGACY)
      .withProperties({ text: "pre-T-5 content" })
      .withVector([0.1, 0.2])
      .do();
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    for (const name of [MODERN, LEGACY]) {
      await client.schema.classDeleter().withClassName(name).do().catch(() => {});
    }
  });

  const classDef = (name) =>
    client.schema.classGetter().withClassName(name).do();

  const run = async (className, where) => {
    const response = await client.graphql
      .get()
      .withClassName(className)
      .withFields("text _additional { id }")
      .withNearVector({ vector: [0.1, 0.2] })
      .withWhere(where)
      .withLimit(10)
      .do();
    // Weaviate reports filter errors in `errors`, not by throwing, so a test that only
    // looked at rows would read a rejected filter as "no matches".
    if (response.errors) {
      throw new Error(JSON.stringify(response.errors).slice(0, 300));
    }
    return (response?.data?.Get?.[className] ?? []).map((row) => row.text).sort();
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

  test("hasAclSchema distinguishes the two classes", async () => {
    expect(hasAclSchema(await classDef(MODERN))).toBe(true);
    expect(hasAclSchema(await classDef(LEGACY))).toBe(false);
  });

  test("modern class, flag off: only the actor's own row", async () => {
    const where = await withFlag(false, () =>
      constraintFor(filter()).toWeaviateWhere()
    );
    expect(await run(MODERN, where)).toEqual(["denied", "mine", "shares-a-token"]);
  });

  test("modern class, flag on: the legacy row comes back", async () => {
    // The case the escape clause exists for, and the one that threw before the class
    // carried the properties and indexNullState.
    const where = await withFlag(true, () =>
      constraintFor(filter()).toWeaviateWhere()
    );
    expect(await run(MODERN, where)).toEqual(["denied", "legacy row", "mine", "shares-a-token"]);
  });

  test("NO predicate is expressible on a legacy class — not even the strict one", async () => {
    // The finding that changed the design. The first version of this branch kept the
    // STRICT predicate for a legacy class, on the assumption that only IsNull was
    // unavailable. It is not: the properties themselves do not exist, so
    // `Equal orgId '1'` fails the same way. There is no filtered query to fall back to.
    const strict = await withFlag(false, () =>
      constraintFor(filter()).toWeaviateWhere()
    );
    await expect(run(LEGACY, strict)).rejects.toThrow(/no such prop/i);
  });

  test("the provider REFUSES a legacy class rather than querying it", async () => {
    // So the provider does not query at all: an unfilterable class is treated the way
    // Lance treats a table predating the ACL columns. Refused, not thrown, not served.
    const provider = new (require("../../../utils/vectorDbProviders/weaviate").Weaviate)();
    jest.spyOn(provider, "connect").mockResolvedValue({ client });
    jest.spyOn(provider, "namespaceExists").mockResolvedValue(true);
    jest.spyOn(provider, "namespace").mockResolvedValue(await classDef(LEGACY));
    try {
      for (const flagged of [false, true]) {
        const result = await withFlag(flagged, () =>
          provider.queryAuthorized({
            namespace: LEGACY,
            queryVector: [0.1, 0.2],
            similarityThreshold: 0,
            topN: 10,
            aclFilter: filter(),
          })
        );
        expect(result.contextTexts).toEqual([]);
      }
    } finally {
      jest.restoreAllMocks();
    }
  });

  test("the refusal is LOGGED with the reason and the fix", async () => {
    // An empty result with no explanation reads as "no matching documents" and sends the
    // operator to look at their embeddings rather than at their class schema.
    const provider = new (require("../../../utils/vectorDbProviders/weaviate").Weaviate)();
    const logged = [];
    jest.spyOn(provider, "connect").mockResolvedValue({ client });
    jest.spyOn(provider, "namespaceExists").mockResolvedValue(true);
    jest.spyOn(provider, "namespace").mockResolvedValue(await classDef(LEGACY));
    jest.spyOn(provider, "logger").mockImplementation((...args) => {
      logged.push(args.join(" "));
    });
    try {
      await provider.queryAuthorized({
        namespace: LEGACY,
        queryVector: [0.1, 0.2],
        similarityThreshold: 0,
        topN: 10,
        aclFilter: filter(),
      });
    } finally {
      jest.restoreAllMocks();
    }
    const text = logged.join("\n");
    expect(text).toMatch(/predates the ACL metadata/i);
    expect(text).toMatch(/re-embedding/i);
  });

  test("an IsNull filter really does fail on the legacy class", async () => {
    // Pins the premise the whole branch rests on. If a future Weaviate makes this work,
    // this test fails and the branch should be reconsidered rather than left in place
    // forever on a reason that no longer holds.
    const escapeWhere = await withFlag(true, () =>
      constraintFor(filter()).toWeaviateWhere()
    );
    await expect(run(LEGACY, escapeWhere)).rejects.toThrow();
  });

  test("indexNullState cannot be enabled on an existing class", async () => {
    // The reason there is no in-place migration. Documented as a test so nobody spends an
    // afternoon writing one.
    const current = await classDef(LEGACY);
    const response = await fetch(`http://${HOST}/v1/schema/${LEGACY}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...current,
        invertedIndexConfig: {
          ...current.invertedIndexConfig,
          indexNullState: true,
        },
      }),
    });
    expect(response.ok).toBe(false);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/IndexNullState cannot be changed/i);
  });

  test("the deny-list excludes ONLY the denied document (tokenization)", async () => {
    // BLOCKER-2. With auto-schema's default `word` tokenization, `NotEqual "doc-bad"`
    // matches on TOKENS, so it also drops every document sharing the token `doc` —
    // "doc-good" disappears too. Measured on 1.24.10:
    //
    //   word   -> UUID only          (doc-good wrongly excluded)
    //   field  -> UUID and doc-good  (correct)
    //
    // It fails toward FEWER rows, which is why nothing has broken so far: today's ids are
    // UUIDs with no shared tokens. Any scheme with a common prefix ("invoice-2024-01")
    // breaks it at that customer only, and it presents as poor recall rather than a fault.
    const where = await withFlag(false, () =>
      constraintFor(filter({ deniedDocumentIds: ["doc-bad"] })).toWeaviateWhere()
    );
    const texts = await run(MODERN, where);
    expect(texts).not.toContain("denied");
    expect(texts).toContain("shares-a-token");
  });

  test("the deny-list is still correct with the flag set", async () => {
    // The escape clause widens by adding an alternative branch; the deny-list lives in the
    // strict half and must survive intact. Deny is evidence, not absence.
    const where = await withFlag(true, () =>
      constraintFor(filter({ deniedDocumentIds: ["doc-bad"] })).toWeaviateWhere()
    );
    const texts = await run(MODERN, where);
    expect(texts).not.toContain("denied");
    expect(texts).toContain("shares-a-token");
  });

  test("hasAclSchema rejects a class tokenized `word`", async () => {
    // A class can declare all three properties and still be unusable. Presence is not
    // readiness, so the schema check tests tokenization too — otherwise such a class reads
    // as ACL-ready and quietly over-denies.
    const name = `Wordtok${process.pid}`;
    await client.schema.classDeleter().withClassName(name).do().catch(() => {});
    await client.schema
      .classCreator()
      .withClass({
        class: name,
        vectorizer: "none",
        properties: [
          { name: "text", dataType: ["text"] },
          ...ACL_CLASS_PROPERTIES.map((prop) => ({
            name: prop,
            dataType: ["text"],
          })),
        ],
        invertedIndexConfig: { indexNullState: true },
      })
      .do();
    try {
      const def = await classDef(name);
      expect(
        def.properties.find((prop) => prop.name === "docId").tokenization
      ).toBe("word");
      expect(hasAclSchema(def)).toBe(false);
    } finally {
      await client.schema.classDeleter().withClassName(name).do().catch(() => {});
    }
  });
});

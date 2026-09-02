// T-5 (#30) slice 3 — every provider's `curateSources` must preserve the ACL fields.
//
// A citation is stored in `workspace_chats.response` by whatever `curateSources` returned,
// and `fillSourceWindow` now re-authorizes those stored citations by reading `orgId`,
// `workspaceId` and `docId` off them (S-22). So if a provider's `curateSources` drops those
// three fields, every citation it ever stored becomes UNPROVABLE.
//
// The direction of that failure is what makes it worth a test. It fails CLOSED — the
// citations are excluded, not leaked — so nothing errors, nothing is logged, and retrieval
// quality degrades quietly on that provider alone. It would be debugged as a ranking
// problem, if it were noticed at all.
//
// Techlead-2 measured the current state and found all providers preserve them, because every
// implementation spreads metadata WHOLESALE (`{...metadata}`) rather than picking named
// fields. So this is not fixing a bug; it is pinning a property that is true today and would
// break silently if someone rewrote one of these as an explicit pick.
//
// A pure-function table, NOT eight real-store suites. `curateSources` never touches an
// engine — it maps a plain object. That is the distinction from the five predicate bugs
// (LanceDB quoting, pgvector placeholders, Milvus precedence, Qdrant is_null, Weaviate
// tokenization): those needed a real store because only the engine could judge the
// predicate. This one cannot lie to a mock, so a mock is the right instrument.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();

const fs = require("fs");
const path = require("path");
const {
  ACL_FIELDS,
} = require("../../../utils/authorization/vectorPredicate");

const PROVIDER_DIR = path.resolve(__dirname, "../../../utils/vectorDbProviders");

/**
 * Every provider, discovered from the DIRECTORY rather than hardcoded.
 *
 * QA-1 ruling: a hardcoded list of eight misses `chromacloud` and `zilliz`. Those two do
 * not define `curateSources` themselves — they `extends Chroma` and `extends Milvus` and
 * INHERIT it — but that distinction is exactly why enumeration matters: a subclass that
 * later overrides the method would never appear in a list nobody remembered to update, and
 * its silent field-dropping is what this file exists to catch.
 */
function providerClasses() {
  const found = [];
  for (const entry of fs.readdirSync(PROVIDER_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const modulePath = path.join(PROVIDER_DIR, entry.name, "index.js");
    if (!fs.existsSync(modulePath)) continue;

    const exported = require(modulePath);
    for (const [name, value] of Object.entries(exported)) {
      if (typeof value !== "function") continue;
      if (typeof value.prototype?.curateSources !== "function") continue;
      found.push({ dir: entry.name, name, Provider: value });
    }
  }
  return found;
}

const PROVIDERS = providerClasses();

/**
 * The exact object `authorizedSimilaritySearch` hands to `curateSources`:
 * `sourceDocuments.map((metadata, i) => ({metadata: {...metadata, text: contextTexts[i]}}))`.
 */
const sourceFromSearch = () => ({
  metadata: {
    orgId: "1",
    workspaceId: "3",
    docId: "doc-abc",
    title: "report.pdf",
    published: "2026-01-01",
    score: 0.87,
    text: "THE CHUNK TEXT",
  },
});

describe("T-5 slice 3: curateSources preserves the fields the ACL reads", () => {
  test("the provider directory yields more than the eight that define it", () => {
    // Guards the enumeration itself. If `providerClasses()` silently returned [] — a bad
    // path, a changed export shape — every table test below would vacuously pass, which is
    // the failure mode this suite is meant to prevent rather than reproduce.
    expect(PROVIDERS.length).toBeGreaterThanOrEqual(10);
    const dirs = PROVIDERS.map((entry) => entry.dir);
    // The two that inherit rather than define. Named explicitly because they are the ones
    // a hardcoded list would have missed.
    expect(dirs).toContain("chromacloud");
    expect(dirs).toContain("zilliz");
  });

  test.each(PROVIDERS.map((entry) => [entry.dir, entry.name, entry.Provider]))(
    "%s (%s) keeps orgId, workspaceId and docId",
    (_dir, _name, Provider) => {
      const provider = new Provider();
      const [curated] = provider.curateSources([sourceFromSearch()]);

      expect(curated).toBeDefined();
      // ACL_FIELDS rather than three literals: the predicate and this test then cannot
      // disagree about which fields matter, and adding a fourth field to the filter makes
      // this fail until the providers are checked for it.
      for (const field of ACL_FIELDS) {
        expect(curated).toHaveProperty(field);
      }
      expect(curated.orgId).toBe("1");
      expect(curated.workspaceId).toBe("3");
      expect(curated.docId).toBe("doc-abc");
      // And the text, or the citation is useless even when it is authorized.
      expect(curated.text).toBe("THE CHUNK TEXT");
    }
  );

  test.each(PROVIDERS.map((entry) => [entry.dir, entry.Provider]))(
    "%s output is judged correctly by the same predicate that will re-authorize it",
    (_dir, Provider) => {
      // The end-to-end property, one step beyond field presence: the object a provider
      // stores must be one `isRowAllowed` can actually decide on. Asserting the fields
      // exist proves the shape; this proves the shape is USABLE, in both directions.
      const {
        isRowAllowed,
      } = require("../../../utils/authorization/vectorPredicate");
      const provider = new Provider();
      const [curated] = provider.curateSources([sourceFromSearch()]);

      const allowFilter = {
        orgId: 1,
        principalType: "user",
        actorId: "5",
        workspaceIds: ["3"],
        orgWide: false,
        deniedDocumentIds: [],
        attributes: {},
        matchNone: false,
        policyVersion: "1",
      };
      expect(isRowAllowed(curated, allowFilter)).toBe(true);
      expect(
        isRowAllowed(curated, { ...allowFilter, deniedDocumentIds: ["doc-abc"] })
      ).toBe(false);
      expect(isRowAllowed(curated, { ...allowFilter, workspaceIds: ["99"] })).toBe(
        false
      );
      expect(isRowAllowed(curated, { ...allowFilter, orgId: 2 })).toBe(false);
    }
  );
});

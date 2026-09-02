// T-5 (#30) slice 1a — vectors must be WRITTEN with the ACL metadata the filter reads.
//
// The filter denies any row it cannot prove is allowed (S-26/G4), which is correct and is
// also why the write path matters: ingest never wrote `orgId`, `workspaceId` or `docId`
// into vector metadata, so every row is unprovable and retrieval returns nothing. The recon treated this as a T-6 backfill of OLD data; the real gap was
// that new writes had no metadata either.
//
// So there are two halves, and they fail differently:
//   - New documents get their metadata here, at write time.
//   - Documents embedded before this change have none and cannot be proven allowed. The
//     default for those is DENY; a deployment that has not yet run the backfill and needs
//     the old behaviour must say so by setting RETRIEVAL_FILTER_ALLOW_UNPROVABLE. The
//     unsafe state is opt-in and visible in the environment rather than inherited by
//     everyone who does nothing.
//
// RED on ff443200: the submissions carry no orgId/workspaceId/docId.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();

const {
  aclMetadataFor,
} = require("../../../utils/authorization/vectorAclMetadata");

describe("T-5: every vector written carries the fields the ACL filter reads", () => {
  test("the ACL metadata names org, workspace and document", async () => {
    const meta = aclMetadataFor({ workspaceId: 3, docId: "doc-abc" });
    expect(meta).toEqual({ orgId: "1", workspaceId: "3", docId: "doc-abc" });
  });

  test("ids are stringified — the filter compares them as strings", async () => {
    // A numeric workspaceId in the payload and a string in the filter would never match,
    // and the symptom would be "retrieval quietly returns nothing" rather than an error.
    const meta = aclMetadataFor({ workspaceId: 7, docId: 42 });
    expect(meta.workspaceId).toBe("7");
    expect(meta.docId).toBe("42");
  });

  test("a missing workspaceId throws rather than writing an unprovable row", async () => {
    // Writing the row anyway would produce a vector nothing can ever read: denied by the
    // filter forever, with no error at ingest to explain why. Failing at write time is
    // the only point where the mistake is still cheap.
    expect(() => aclMetadataFor({ docId: "doc-abc" })).toThrow(
      /workspaceId/
    );
  });

  test("a missing docId throws too", async () => {
    expect(() => aclMetadataFor({ workspaceId: 3 })).toThrow(/docId/);
  });
});

describe("T-5: RETRIEVAL_FILTER_ALLOW_UNPROVABLE is an opt-in escape hatch, not a switch", () => {
  const { isRowAllowed } = require("../../../utils/authorization/vectorPredicate");
  const {
    allowUnprovableRows,
  } = require("../../../utils/authorization/retrievalEnforcement");

  const ORIGINAL = process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
    else process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = ORIGINAL;
  });

  const filter = (over = {}) => ({
    orgId: 1,
    workspaceIds: ["1"],
    orgWide: false,
    deniedDocumentIds: [],
    matchNone: false,
    policyVersion: "1",
    ...over,
  });
  const legacyRow = { text: "embedded before T-5" };

  test("the default is FAIL-CLOSED — an unlabelled row is denied", () => {
    // The shipped default. A deployment that needs the old behaviour has to declare
    // itself in its environment; nobody inherits the unsafe state by doing nothing.
    delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
    expect(allowUnprovableRows()).toBe(false);
    expect(isRowAllowed(legacyRow, filter())).toBe(false);
  });

  test("setting it admits the unlabelled row", () => {
    // The pre-backfill deployment: old vectors stay readable, exactly as yesterday.
    process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
    expect(allowUnprovableRows()).toBe(true);
    expect(isRowAllowed(legacyRow, filter())).toBe(true);
  });

  test("any value enables it — presence, not truthiness", () => {
    // Matches EMBED_REQUIRE_ALLOWLIST and the rest of the repo. Documented in
    // .env.example so "false" is not read as off.
    for (const value of ["1", "true", "false", ""]) {
      process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = value;
      expect(allowUnprovableRows()).toBe(true);
    }
  });
});

describe("T-5: a row WITH metadata is judged identically in both states", () => {
  // The boundary that keeps the escape hatch from being a bypass. It excuses absence of
  // evidence; it never excuses evidence of denial.
  const { isRowAllowed } = require("../../../utils/authorization/vectorPredicate");
  const ORIGINAL = process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
    else process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = ORIGINAL;
  });

  const filter = (over = {}) => ({
    orgId: 1,
    workspaceIds: ["1"],
    orgWide: false,
    deniedDocumentIds: [],
    matchNone: false,
    policyVersion: "1",
    ...over,
  });

  const bothStates = (name, row, aclFilter, expected) => {
    test(name, () => {
      delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
      expect(isRowAllowed(row, aclFilter)).toBe(expected);
      process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
      expect(isRowAllowed(row, aclFilter)).toBe(expected);
    });
  };

  bothStates(
    "another org's row is denied in both states",
    { text: "x", orgId: 2, workspaceId: "1", docId: "d" },
    filter(),
    false
  );
  bothStates(
    "a workspace outside scope is denied in both states",
    { text: "x", orgId: 1, workspaceId: "99", docId: "d" },
    filter(),
    false
  );
  bothStates(
    "an explicitly denied document is denied in both states",
    { text: "x", orgId: 1, workspaceId: "1", docId: "doc-bad" },
    filter({ deniedDocumentIds: ["doc-bad"] }),
    false
  );
  bothStates(
    "a match-none filter returns nothing in both states",
    { text: "x", orgId: 1, workspaceId: "1", docId: "d" },
    { matchNone: true, orgId: 1 },
    false
  );
  bothStates(
    "a row inside scope is allowed in both states",
    { text: "x", orgId: 1, workspaceId: "1", docId: "d" },
    filter(),
    true
  );
  bothStates(
    "a HALF-labelled row is denied in both states — it claimed a provenance",
    // Not the legacy shape: this row says which document it is but not which workspace,
    // so it is held to the claim rather than excused as un-backfilled.
    { text: "x", docId: "d" },
    filter(),
    false
  );
});

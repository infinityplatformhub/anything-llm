// T-5 (#30) slice 3 — S-22 (G1): a revoked citation must not come back from history.
//
// `fillSourceWindow` reads citations out of STORED CHAT HISTORY (`workspace_chats.response`,
// a JSON blob written when the answer was produced) and re-injects them into the current
// turn. Its four filters are: not currently pinned, has a score, has text, not a duplicate.
// None of them is an authorization check.
//
// So the ACL that governs a rehydrated citation is the one that was in force WHEN THE ANSWER
// WAS WRITTEN, not the one in force now. This path replays a past decision rather than
// making a new one — the only retrieval surface in T-5 whose data source is our own prior
// output. Slice 1 (the provider) and slice 2 (the pinned path) cannot see it: the text never
// goes near a vector store or a pinned row on the way back.
//
// S-22, stated as a script: ask a question, get a citation, revoke the grant, ask a
// follow-up in the same thread. The revoked document's text returns.
//
// RED before the fix: the "denied" assertions below fail.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();

const {
  fillSourceWindow,
} = require("../../../utils/helpers/chat");

/** A stored citation, in the shape `curateSources` persists (metadata spread flat). */
const citation = (over = {}) => ({
  id: `chunk-${Math.random().toString(16).slice(2)}`,
  score: 0.9,
  text: "CITATION TEXT",
  title: "doc.txt",
  published: "2026-01-01",
  // Since slice 1a every vector carries these, and `curateSources` copies metadata
  // wholesale, so they survive into stored history. They are what makes a replayed
  // citation checkable at all.
  orgId: "1",
  workspaceId: "3",
  docId: "doc-ok",
  ...over,
});

/** One stored chat turn carrying citations, as `recentChatHistory` returns it. */
const turn = (sources) => ({ response: JSON.stringify({ sources }) });

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

describe("T-5 slice 3 (S-22): rehydrated citations are re-authorized", () => {
  test("RED: a revoked document does not come back from history", async () => {
    // The S-22 script. The citation was legitimately returned when the answer was written;
    // the grant has since been revoked, so `deniedDocumentIds` now names it.
    const revoked = citation({ docId: "doc-revoked", text: "REVOKED CONTENT" });
    const allowed = citation({ docId: "doc-ok", text: "STILL ALLOWED" });

    const { sources, contextTexts } = fillSourceWindow({
      nDocs: 4,
      searchResults: [],
      history: [turn([revoked, allowed])],
      aclFilter: filter({ deniedDocumentIds: ["doc-revoked"] }),
    });

    // BOTH arrays. `contextTexts` is what reaches the LLM and is the actual leak;
    // `sources` is what the UI renders. A fix covering one and not the other still hands
    // the revoked text to the model (stream.js:243 sends filled contextTexts).
    expect(contextTexts).not.toContain("REVOKED CONTENT");
    expect(JSON.stringify(sources)).not.toContain("REVOKED CONTENT");
    // Positive control: rehydration still WORKS. A function that returned nothing would
    // pass every assertion above and silently delete a feature.
    expect(contextTexts).toContain("STILL ALLOWED");
  });

  test("another workspace's citation does not come back", async () => {
    // Scope, not just deny lists — the slice 2 lesson. There is no deny row for a document
    // in a workspace the actor was never in, so only the filter's positive scope excludes
    // it.
    const { contextTexts } = fillSourceWindow({
      nDocs: 4,
      searchResults: [],
      history: [
        turn([
          citation({ workspaceId: "99", text: "OTHER WORKSPACE" }),
          citation({ text: "MY WORKSPACE" }),
        ]),
      ],
      aclFilter: filter(),
    });
    expect(contextTexts).not.toContain("OTHER WORKSPACE");
    expect(contextTexts).toContain("MY WORKSPACE");
  });

  test("another org's citation does not come back", async () => {
    const { contextTexts } = fillSourceWindow({
      nDocs: 4,
      searchResults: [],
      history: [
        turn([
          citation({ orgId: "2", text: "OTHER ORG" }),
          citation({ text: "MY ORG" }),
        ]),
      ],
      aclFilter: filter(),
    });
    expect(contextTexts).not.toContain("OTHER ORG");
    expect(contextTexts).toContain("MY ORG");
  });

  test("a match-none actor rehydrates nothing", async () => {
    const { sources, contextTexts } = fillSourceWindow({
      nDocs: 4,
      searchResults: [],
      history: [turn([citation({ text: "ANYTHING" })])],
      aclFilter: filter({ matchNone: true }),
    });
    expect(contextTexts).toEqual([]);
    expect(sources).toEqual([]);
  });

  describe("a citation stored before slice 1a carries no ACL fields", () => {
    // Same rule as an unlabelled vector (S-26/G4): unprovable means denied, unless the
    // operator has said otherwise. Both directions, because a flag asserted in only one
    // state is a flag that can be inert — the slice 1a lesson.
    const legacy = {
      id: "chunk-legacy",
      score: 0.9,
      text: "PRE-T5 CITATION",
      title: "old.txt",
      published: "2025-01-01",
    };
    const ORIGINAL = process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
    afterEach(() => {
      if (ORIGINAL === undefined)
        delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
      else process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = ORIGINAL;
    });

    test("unset: excluded", () => {
      delete process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE;
      const { contextTexts } = fillSourceWindow({
        nDocs: 4,
        searchResults: [],
        history: [turn([legacy])],
        aclFilter: filter(),
      });
      expect(contextTexts).not.toContain("PRE-T5 CITATION");
    });

    test("set: admitted", () => {
      process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
      const { contextTexts } = fillSourceWindow({
        nDocs: 4,
        searchResults: [],
        history: [turn([legacy])],
        aclFilter: filter(),
      });
      expect(contextTexts).toContain("PRE-T5 CITATION");
    });

    test("set: a positively DENIED citation is still denied", () => {
      // The flag governs absence of evidence, never evidence of denial.
      process.env.RETRIEVAL_FILTER_ALLOW_UNPROVABLE = "1";
      const { contextTexts } = fillSourceWindow({
        nDocs: 4,
        searchResults: [],
        history: [turn([citation({ docId: "doc-bad", text: "DENIED" })])],
        aclFilter: filter({ deniedDocumentIds: ["doc-bad"] }),
      });
      expect(contextTexts).not.toContain("DENIED");
    });
  });

  test("denied citations do not consume window slots (S-17 class)", () => {
    // The filter must run BEFORE the `sources.length >= nDocs` check, not after. If a
    // denied citation is pushed and dropped later, it occupies a slot that a readable
    // citation should have had — the actor's own documents silently stop being
    // rehydrated. The count that comes back is also an oracle: it tells the caller how
    // many denied citations existed.
    const denied = Array.from({ length: 3 }, (_, i) =>
      citation({ docId: `doc-bad-${i}`, id: `bad-${i}`, text: `DENIED ${i}` })
    );
    const allowed = Array.from({ length: 3 }, (_, i) =>
      citation({ docId: "doc-ok", id: `ok-${i}`, text: `ALLOWED ${i}` })
    );

    const { contextTexts } = fillSourceWindow({
      nDocs: 3,
      searchResults: [],
      // The denied ones come FIRST, so a filter that runs too late fills the window with
      // them and leaves no room for the readable ones.
      history: [turn([...denied, ...allowed])],
      aclFilter: filter({
        deniedDocumentIds: ["doc-bad-0", "doc-bad-1", "doc-bad-2"],
      }),
    });

    // A full window of readable citations — not a window three-quarters wasted.
    expect(contextTexts).toHaveLength(3);
    for (const text of contextTexts) expect(text).toMatch(/^ALLOWED/);
  });

  test("the filter is REQUIRED — no filter is never 'no restriction'", () => {
    // Same contract as `pinnedDocs` and `queryAuthorized`. An optional security filter is
    // a filter plus a way to skip it, and it fails in the direction that returns more.
    expect(() =>
      fillSourceWindow({
        nDocs: 4,
        searchResults: [],
        history: [turn([citation()])],
      })
    ).toThrow(/aclFilter/i);
  });

  test("dedupe is NOT a security property (M6 must survive)", () => {
    // QA-1 ruling 10: `seenChunks` exists for citation quality, not authorization. A test
    // that dies when dedupe is removed would freeze a refactor of unrelated behaviour and
    // teach the next reader that dedupe is load-bearing for security. It is not — so this
    // asserts only what must hold with or without it: nothing denied gets through.
    const dupe = citation({ docId: "doc-bad", id: "same-id", text: "DENIED DUPE" });
    const { contextTexts } = fillSourceWindow({
      nDocs: 4,
      searchResults: [],
      history: [turn([dupe, { ...dupe }])],
      aclFilter: filter({ deniedDocumentIds: ["doc-bad"] }),
    });
    expect(contextTexts).not.toContain("DENIED DUPE");
  });
});

describe("T-5 slice 3: every fillSourceWindow call site passes a filter", () => {
  // QA-1 ruling: there are FIVE, not four — apiChatHandler.js has two. A site that forgets
  // the filter now throws rather than leaking, so this is defence in depth: it names the
  // offending file at review time instead of at runtime, and it fails on the pull request
  // that adds a sixth site rather than in production.
  const fs = require("fs");
  const path = require("path");

  const SITES = [
    "utils/chats/stream.js",
    "utils/chats/embed.js",
    "utils/chats/apiChatHandler.js",
    "utils/telegramBot/chat/stream.js",
  ];
  const SERVER = path.resolve(__dirname, "../../..");

  test("no call site anywhere is missing an aclFilter", () => {
    // Discovered by walking the tree rather than trusting the list above: a sixth site in
    // a file nobody listed is exactly the case a hardcoded list cannot see.
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".js")) {
          // The definition site is not a call site. Its own JSDoc example contains the
          // string, so without this the scan reports six and the count assertion below
          // would have to be loosened — which would defeat it.
          if (path.relative(SERVER, full) === "utils/helpers/chat/index.js") continue;
          const source = fs.readFileSync(full, "utf-8");
          // Brace-matched rather than regex-terminated. An earlier version keyed on the
          // closing `\n  })` at a fixed indent and silently found 2 of the 5 sites — a
          // guard that quietly inspects a subset is the failure mode this whole issue is
          // about, so the scan counts braces instead of guessing at layout.
          let from = source.indexOf("fillSourceWindow({");
          while (from !== -1) {
            let depth = 0;
            let end = from;
            for (let i = source.indexOf("{", from); i < source.length; i++) {
              if (source[i] === "{") depth += 1;
              else if (source[i] === "}") {
                depth -= 1;
                if (depth === 0) {
                  end = i;
                  break;
                }
              }
            }
            const call = source.slice(from, end + 1);
            found.push(path.relative(SERVER, full));
            expect(call).toContain("aclFilter");
            from = source.indexOf("fillSourceWindow({", end);
          }
        }
      }
    };
    walk(path.join(SERVER, "utils"));

    // Five, and the list must not shrink silently either: a site that disappears because
    // someone renamed the helper would make every assertion above vacuous.
    expect(found).toHaveLength(5);
    for (const site of SITES) expect(found).toContain(site);
    // apiChatHandler carries two of them.
    expect(found.filter((f) => f === "utils/chats/apiChatHandler.js")).toHaveLength(2);
  });
});

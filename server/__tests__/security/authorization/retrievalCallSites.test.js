// T-5 (#30) PR-1 part 2 — every retrieval call site goes through the ACL boundary.
//
// Part 1 built `queryAuthorized` and nothing called it. That is the shape of the original
// bug repeated one layer up: a boundary that exists but is not on the path enforces
// nothing. These tests are the ones that actually close S-10/S-11/S-13, because they
// assert about the CALLERS rather than about the provider.
//
// The grep gate is deliberate and is the most valuable assertion here. A per-call-site
// behavioural test proves the eight sites that exist today are wired; the gate proves the
// ninth one somebody adds next month cannot quietly skip the filter. Reviewers forget;
// grep does not.
//
// RED on eda1214b: every site calls performSimilaritySearch with no filter at all.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();

const fs = require("fs");
const path = require("path");

const SERVER_ROOT = path.resolve(__dirname, "../../..");

// The runtime retrieval sites named in the T-5 recon §1 (Path 1), plus the /v1 endpoint.
const CALL_SITES = [
  "utils/chats/stream.js",
  "utils/chats/embed.js",
  "utils/chats/apiChatHandler.js",
  "utils/chats/openaiCompatible.js",
  "utils/agents/aibitat/plugins/memory.js",
  "utils/telegramBot/chat/stream.js",
  "endpoints/api/workspace/index.js",
];

const read = (relative) =>
  fs.readFileSync(path.join(SERVER_ROOT, relative), "utf8");

describe("T-5 S-10/S-11/S-13: no retrieval path reaches vectors unfiltered", () => {
  test.each(CALL_SITES)("%s does not call performSimilaritySearch", (site) => {
    // The unfiltered entry point must be gone from every caller. Leaving one behind is
    // not a partial fix — it is a complete bypass of the seam for that path.
    const source = read(site);
    expect(source).not.toMatch(/\.performSimilaritySearch\(/);
  });

  test.each(CALL_SITES)("%s searches through the authorized bridge", (site) => {
    // Call sites do not name `aclFilter` themselves — they go through
    // authorizedSimilaritySearch, which builds it. That is deliberate: a site that
    // assembled its own filter could assemble a more generous one, and the filter would
    // stop being a single definition of "what may this actor read".
    const source = read(site);
    expect(source).toMatch(/authorizedSimilaritySearch/);
  });

  test("no call site hands the provider a null filter", () => {
    // The one way to satisfy the check above while defeating it entirely.
    for (const site of CALL_SITES) {
      const source = read(site);
      expect(source).not.toMatch(/aclFilter:\s*null/);
      expect(source).not.toMatch(/aclFilter:\s*undefined/);
    }
  });

  test("the non-HTTP entry points are wired too — agents and Telegram get no private door", () => {
    // S-13. These bypass every HTTP middleware, so if authorization lived only in a route
    // guard they would be unprotected; the filter is built at the retrieval call instead,
    // which is why they are covered by construction.
    for (const site of [
      "utils/agents/aibitat/plugins/memory.js",
      "utils/telegramBot/chat/stream.js",
    ]) {
      expect(read(site)).toMatch(/authorizedSimilaritySearch/);
    }
  });

  test("the /v1 vector-search endpoint is filtered — it returns chunk text directly", () => {
    // S-11, the highest-value leak surface in the recon: this route hands back raw chunks
    // rather than an LLM answer, so an unfiltered result is an immediate verbatim leak.
    const source = read("endpoints/api/workspace/index.js");
    expect(source).toMatch(/authorizedSimilaritySearch/);
    expect(source).not.toMatch(/\.performSimilaritySearch\(/);
  });
});

describe("T-5: the filter is built from the request's own identity", () => {
  test("call sites pass a principal REFERENCE, never a constructed Actor", () => {
    // T-2 makes actorResolver the only place a seam-02 Actor is built. A retrieval site
    // may say WHO is asking (`actorRef: {type, id}` — a reference, resolved by
    // actorResolver into an Actor with database-derived scope), but it must never hand
    // over a finished Actor, because the fields that decide reach — workspaceIds, orgId,
    // grantPrincipal — would then be caller-supplied.
    //
    // The distinction is exactly `orgId`/`workspaceIds` appearing beside a `type`: a ref
    // carries identity, an Actor carries scope.
    for (const site of CALL_SITES) {
      const source = read(site);
      expect(source).not.toMatch(/actor:\s*\{[^}]*orgId/s);
      expect(source).not.toMatch(/actor:\s*\{[^}]*grantPrincipal/s);
    }
  });

  test("actorRef is only ever a bare identity, never a scope", () => {
    // The other half of the same rule: an actorRef that carried orgId would be an Actor
    // wearing a different name, and resolveActorRef would have nothing left to derive.
    const embedSource = read("utils/chats/embed.js");
    expect(embedSource).toMatch(/actorRef:/);
    expect(embedSource).not.toMatch(/actorRef:\s*\{[^}]*orgId/s);
  });
});

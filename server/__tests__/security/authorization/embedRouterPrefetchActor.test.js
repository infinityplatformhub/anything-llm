// T-5 (#30) slice 2 round 3 — the embed's principal must survive the router prefetch.
//
// Techlead-2, item 4. When a workspace uses `anythingllm-router`, the connector resolution
// step PREFETCHES the chat context — pinned documents included — and `streamChatWithForEmbed`
// then reuses that prefetched array instead of fetching its own:
//
//     const pinnedDocs = prefetchedPinnedDocs ?? (await authorizedPinnedDocs({...}))
//
// The embed path passed no principal into that prefetch. It has no `user` — an embed
// visitor is an embed principal, not a person — so the filter was built for nobody, came
// back match-none, and returned []. The `??` then took the empty array as an answer rather
// than as an absence, so the fallback that DOES carry the actorRef never ran.
//
// This direction is fail-closed, which is why it is a regression rather than a leak: a
// router-backed embed silently lost every pinned document it was entitled to serve, and it
// looked exactly like a workspace with nothing pinned. Worth a test precisely because
// nothing about it is visible as an error.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();

const EMBED = {
  uuid: "embed-uuid-1",
  workspace_id: 7,
  workspace: { id: 7, slug: "ws7", openAiHistory: 20 },
};

describe("T-5 slice 2: the router prefetch carries the embed's principal", () => {
  afterEach(() => jest.resetModules());

  test("gatherRoutingContext passes actorRef through to the pinned-document filter", async () => {
    // Asserted at the seam that broke, with the pinned bridge stubbed so this is about the
    // WIRING — whether the principal arrives — rather than about the ACL, which the
    // pinnedContextAcl suite already covers against a real database.
    const seen = [];
    jest.resetModules();
    jest.doMock("../../../utils/authorization/pinnedContext", () => ({
      authorizedPinnedDocs: jest.fn(async (input) => {
        seen.push(input);
        return [];
      }),
    }));
    jest.doMock("../../../models/workspaceParsedFiles", () => ({
      WorkspaceParsedFiles: { getContextFiles: async () => [] },
    }));
    jest.doMock("../../../utils/chats", () => ({
      chatPrompt: async () => "",
      recentChatHistory: async () => ({ rawHistory: [], chatHistory: [] }),
    }));

    const { ModelRouterService } = require("../../../utils/router");
    const actorRef = {
      type: "embed",
      id: EMBED.uuid,
      workspaceIds: [String(EMBED.workspace_id)],
    };
    await ModelRouterService.gatherRoutingContext({
      workspace: EMBED.workspace,
      user: null,
      actorRef,
      message: "hi",
      chatHistoryOverride: { rawHistory: [], chatHistory: [] },
      messageCountOverride: 1,
    });

    expect(seen).toHaveLength(1);
    // Arriving as `undefined` is the bug: the filter would be built for nobody and return
    // match-none, and the [] that comes back is indistinguishable from "nothing pinned".
    expect(seen[0].actorRef).toEqual(actorRef);
  });

  test("the embed chat path hands resolveProviderConnector that same reference", async () => {
    // The other half. `gatherRoutingContext` accepting an actorRef is worth nothing if the
    // embed caller never sends one — which is precisely the state this fixes — so the call
    // site is asserted too, not just the function it calls.
    jest.resetModules();
    const calls = [];
    jest.doMock("../../../utils/helpers", () => ({
      ...jest.requireActual("../../../utils/helpers"),
      resolveProviderConnector: jest.fn(async (input) => {
        calls.push(input);
        return { connector: {}, routingMetadata: null, prefetchedContext: null };
      }),
    }));
    jest.doMock("../../../models/embedChats", () => ({
      EmbedChats: { forEmbedByUser: async () => [], count: async () => 0 },
    }));

    const embedModule = require("../../../utils/chats/embed");
    const resolve =
      embedModule.resolveLLMConnectorForEmbed ??
      embedModule.__test__?.resolveLLMConnectorForEmbed;

    if (typeof resolve !== "function") {
      // Not exported: assert on the source instead of silently skipping. A test that
      // quietly proves nothing is worse than one that states its limit.
      const source = require("fs").readFileSync(
        require.resolve("../../../utils/chats/embed"),
        "utf-8"
      );
      const call = source.match(
        /resolveProviderConnector\(\{[\s\S]*?\n {6}\}\)/
      );
      expect(call).not.toBeNull();
      expect(call[0]).toMatch(/actorRef/);
      expect(call[0]).toMatch(/type: "embed"/);
      return;
    }

    await resolve({ embed: EMBED, chatModel: null, message: "hi", sessionId: "s1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].actorRef).toEqual({
      type: "embed",
      id: EMBED.uuid,
      workspaceIds: [String(EMBED.workspace_id)],
    });
  });
});

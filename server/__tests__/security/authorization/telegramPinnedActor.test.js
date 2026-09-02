// T-5 (#30) slice 2 — the Telegram path must actually REACH its pinned-document filter.
//
// Techlead-2 BLOCKER: `collectPinnedDocs(workspace, LLMConnector)` referenced `actor`,
// which is a parameter of `streamResponse`, not of that helper. Every Telegram chat threw
// ReferenceError before reaching retrieval — the entire channel was down, not degraded.
//
// `node --check` passes on it, because an undefined identifier is a RUNTIME error in
// JavaScript, not a syntax error. Nothing in a static pass can see it. The only thing that
// catches this class of defect is executing the line.
//
// Telegram has no HTTP route, so §7.9's "drive the real entry point" cannot mean a
// supertest request here. It means calling the exported handler and letting it run far
// enough to touch the code that broke — which is what this does, with the LLM and vector
// store stubbed but the pinned-document path real.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();

// Mocked at the MODULE boundary, not with spyOn: stream.js destructures
// `authorizedPinnedDocs` at import time, so it holds its own reference and a later
// spyOn on the module object never reaches it.
const pinnedCalls = [];
jest.mock("../../../utils/authorization/pinnedContext", () => ({
  authorizedPinnedDocs: jest.fn(async (input) => {
    pinnedCalls.push(input);
    return [];
  }),
}));

// Same reason: helpers are destructured at import, so these must be mocked at the module
// boundary too. Without it the handler dies on "No OpenAI API key was set" BEFORE reaching
// the line under test — and a test that never executes the fix proves nothing about it.
// Everything upstream of the line under test, stubbed so execution actually REACHES it.
// The handler otherwise dies on chat history (real DB) or the provider connector, and a
// test that never runs the fixed line proves nothing about the fix.
jest.mock("../../../utils/chats", () => {
  const actual = jest.requireActual("../../../utils/chats");
  return {
    ...actual,
    recentChatHistory: async () => ({ rawHistory: [], chatHistory: [] }),
  };
});

// AgentHandler is a CLASS that EphemeralAgentHandler extends, so it cannot be replaced
// with a plain object — only its static method is overridden, on the real class.
const { AgentHandler } = require("../../../utils/agents");
jest
  .spyOn(AgentHandler, "isAgentInvocation")
  .mockImplementation(async () => false);

jest.mock("../../../utils/helpers", () => {
  const actual = jest.requireActual("../../../utils/helpers");
  return {
    ...actual,
    getVectorDbClass: () => ({ namespaceCount: async () => 0 }),
    resolveProviderConnector: async () => ({
      connector: {
        promptWindowLimit: () => 4096,
        streamGetChatCompletion: async () => ({ type: "abort" }),
        compressMessages: async () => [],
        constructPrompt: async () => "",
        defaultTemp: 0.7,
      },
      routingMetadata: null,
    }),
  };
});

const {
  streamResponse,
} = require("../../../utils/telegramBot/chat/stream");

/** Minimal ctx: enough for the handler to run, capturing what it would have sent. */
function makeCtx() {
  const sent = [];
  return {
    sent,
    bot: {
      sendChatAction: async () => {},
      sendMessage: async (_chatId, text) => {
        sent.push(text);
        return { message_id: 1 };
      },
      editMessageText: async () => ({}),
    },
  };
}

const WORKSPACE = {
  id: 1,
  slug: "ws1",
  name: "ws1",
  chatMode: "chat",
  openAiTemp: 0.7,
  openAiHistory: 20,
};

const ACTOR = {
  type: "user",
  id: "42",
  orgId: 1,
  workspaceIds: ["1"],
};

describe("T-5 slice 2: the Telegram pinned-document path", () => {
  afterEach(() => jest.restoreAllMocks());

  test("streamResponse reaches pinned-document collection without a ReferenceError", async () => {
    // The regression. Before the fix this threw
    // `ReferenceError: actor is not defined` inside collectPinnedDocs, so every Telegram
    // message failed before any retrieval happened.
    pinnedCalls.length = 0;
    const ctx = makeCtx();
    // Rejecting for a LATER reason is fine; rejecting with ReferenceError is the bug.
    await streamResponse({
      ctx,
      chatId: 99,
      workspace: WORKSPACE,
      message: "hello",
      actor: ACTOR,
    }).catch((error) => {
      expect(error).not.toBeInstanceOf(ReferenceError);
      expect(String(error?.message)).not.toMatch(/actor is not defined/i);
    });

    // And it must have reached the filter, carrying the actor — arriving with `undefined`
    // would build a match-none filter and silently return no pinned documents, which looks
    // like "this workspace has none" rather than a wiring fault.
    expect(pinnedCalls.length).toBeGreaterThan(0);
    expect(pinnedCalls[0].actor).toEqual(ACTOR);
  });

  test("collectPinnedDocs takes the actor as an argument, not from an outer scope", async () => {
    // Pins the shape of the fix. A helper that reads `actor` from module scope would pass
    // the test above by accident today and break again the moment it is moved or reused.
    const source = require("fs").readFileSync(
      require.resolve("../../../utils/telegramBot/chat/stream"),
      "utf-8"
    );
    const signature = source.match(
      /async function collectPinnedDocs\(([^)]*)\)/
    );
    expect(signature).not.toBeNull();
    expect(signature[1]).toMatch(/actor/);
  });

  test("streamResponse still refuses to run without an actor", async () => {
    // The pre-existing W-11 contract, re-asserted: threading the actor further must not
    // have made it optional anywhere along the way.
    await expect(
      streamResponse({
        ctx: makeCtx(),
        chatId: 99,
        workspace: WORKSPACE,
        message: "hello",
        actor: null,
      })
    ).rejects.toThrow(/actor/i);
  });
});

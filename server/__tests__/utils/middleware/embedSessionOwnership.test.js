// T-4b (#29) W-10 / S-24 (G12) — an embed session belongs to ONE embed.
//
// PR-0d's `embedHistoryAccess` checks that the sessionId is a well-formed UUID, that the
// embed is enabled, and that the origin is allowlisted. It never checks that the session
// belongs to the embed in the path. Two consequences, both reachable from an allowed
// origin with the embed enabled — exactly the state PR-0d's gates pass:
//
//   1. a visitor who learns any session UUID reads or deletes that history;
//   2. embed A can read embed B's sessions by naming B's session id under A's embedId,
//      which crosses a tenant boundary rather than merely a visitor one.
//
// Binding the session to its embed closes (2) outright and narrows (1) to "you must know a
// session id issued for THIS embed". Making the id unguessable (a signed cookie, or an
// HMAC token minted at session start) is the rest of (1) and is a separate issue by PMO
// ruling — this suite locks the binding, and says so where a reader would otherwise assume
// the whole hole is closed.
//
// RED on main: every ownership case passes through.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();

jest.mock("../../../utils/prisma", () => ({
  embed_chats: { findFirst: jest.fn() },
}));

const prisma = require("../../../utils/prisma");
const {
  embedHistoryAccess,
} = require("../../../utils/middleware/embedMiddleware");

const SESSION = "123e4567-e89b-42d3-a456-426614174000";

const makeResponse = (embed) => ({
  locals: { embedConfig: embed },
  status: jest.fn().mockReturnThis(),
  json: jest.fn(),
  sendStatus: jest.fn().mockReturnThis(),
  end: jest.fn(),
});
const makeRequest = (overrides = {}) => ({
  params: { sessionId: SESSION },
  headers: { origin: "https://allowed.example" },
  ...overrides,
});
const embed = (id) => ({
  id,
  enabled: true,
  allowlist_domains: JSON.stringify(["https://allowed.example"]),
});

beforeEach(() => jest.clearAllMocks());

describe("T-4b W-10: an embed session is bound to the embed that issued it", () => {
  it("S-24: a session belonging to ANOTHER embed is refused, from an allowed origin", async () => {
    // The RED case, and the one that crosses a tenant boundary: embed 2 naming a session
    // that exists under embed 1. Every PR-0d gate passes here.
    prisma.embed_chats.findFirst.mockResolvedValue(null); // no such session under embed 2
    const response = makeResponse(embed(2));
    const next = jest.fn();

    await embedHistoryAccess(makeRequest(), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(404);
    expect(prisma.embed_chats.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { embed_id: 2, session_id: SESSION } })
    );
  });

  it("a session belonging to THIS embed is allowed through", async () => {
    prisma.embed_chats.findFirst.mockResolvedValue({ id: 10 });
    const response = makeResponse(embed(1));
    const next = jest.fn();

    await embedHistoryAccess(makeRequest(), response, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("a session that exists nowhere is refused the same way as a foreign one", async () => {
    // Identical response for "wrong embed" and "no such session": distinguishing them
    // would confirm that some other embed owns that id.
    prisma.embed_chats.findFirst.mockResolvedValue(null);
    const response = makeResponse(embed(1));
    const next = jest.fn();

    await embedHistoryAccess(makeRequest(), response, next);

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringMatching(/session/i) })
    );
  });

  it("a store failure denies rather than falling through to the handler", async () => {
    prisma.embed_chats.findFirst.mockRejectedValue(new Error("db down"));
    const response = makeResponse(embed(1));
    const next = jest.fn();

    await embedHistoryAccess(makeRequest(), response, next);

    expect(next).not.toHaveBeenCalled();
  });

  it("ownership is checked AFTER the cheap gates, so a bad origin never queries", async () => {
    const response = makeResponse({
      ...embed(1),
      allowlist_domains: JSON.stringify(["https://other.example"]),
    });
    const next = jest.fn();

    await embedHistoryAccess(makeRequest(), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(prisma.embed_chats.findFirst).not.toHaveBeenCalled();
  });
});

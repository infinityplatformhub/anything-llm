// #32 — an embed session id must be PROVEN, not merely known.
//
// T-4b (#29) W-10 bound a session to the embed that issued it, which closed the
// cross-tenant half of G12: embed A can no longer read embed B's history. What it
// deliberately did NOT do is make session ids unguessable. The id is a client-chosen UUID
// (embed/src/hooks/useSessionId.js mints it with v4() and stores it in localStorage), so
// anyone who learns one — a shared machine, a screenshot, a log line, a support ticket —
// reads and deletes that visitor's whole conversation from any allowed origin.
//
// This issue closes that half: on session open the server mints
//   token = HMAC(SIG_KEY, embedUuid | sessionUuid | issuedAt)
// and `embedHistoryAccess` verifies it BEFORE the ownership query. Bearing a valid id is no
// longer sufficient; you must bear a token the server signed for that id.
//
// Ordering matters and is asserted: verification runs before the DB read, so an unsigned
// request costs no query, and a forged token cannot be used to probe which sessions exist.
//
// RED on 169e2689: there is no token, so every request bearing a valid-format id passes.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();
process.env.SIG_KEY = process.env.SIG_KEY || "a".repeat(64);
process.env.SIG_SALT = process.env.SIG_SALT || "b".repeat(64);

jest.mock("../../../utils/prisma", () => ({
  embed_chats: { findFirst: jest.fn() },
}));

const prisma = require("../../../utils/prisma");
const {
  embedHistoryAccess,
} = require("../../../utils/middleware/embedMiddleware");
const {
  mintSessionToken,
  SESSION_TOKEN_HEADER,
  SESSION_TOKEN_TTL_MS,
} = require("../../../utils/middleware/embedSessionToken");

const SESSION = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_SESSION = "99999999-e89b-42d3-a456-426614174000";
const EMBED_UUID = "emb-1111-2222-3333";

const embed = (over = {}) => ({
  id: 1,
  uuid: EMBED_UUID,
  enabled: true,
  allowlist_domains: JSON.stringify(["https://allowed.example"]),
  ...over,
});

const makeResponse = (embedConfig) => ({
  locals: { embedConfig },
  statusCode: null,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    this.body = payload;
    return this;
  },
  sendStatus(code) {
    this.statusCode = code;
    return this;
  },
  end() {
    return this;
  },
});

const makeRequest = ({ sessionId = SESSION, token, cookie } = {}) => {
  const headers = { origin: "https://allowed.example" };
  if (token) headers[SESSION_TOKEN_HEADER] = token;
  if (cookie) headers.cookie = cookie;
  return {
    params: { sessionId },
    headers,
    header: (name) => headers[name.toLowerCase()] ?? headers[name] ?? null,
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  prisma.embed_chats.findFirst.mockResolvedValue({ id: 10 });
});

describe("#32: an embed session id must be proven, not merely known", () => {
  test("a valid-format session id with NO token is refused", async () => {
    // The whole point: knowing the UUID is no longer enough.
    const next = jest.fn();
    const response = makeResponse(embed());

    await embedHistoryAccess(makeRequest(), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
  });

  test("a token minted for THIS session is accepted", async () => {
    // Positive control. Without this the suite would pass by refusing everything.
    const next = jest.fn();
    const response = makeResponse(embed());
    const token = mintSessionToken({ embedUuid: EMBED_UUID, sessionId: SESSION });

    await embedHistoryAccess(makeRequest({ token }), response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBeNull();
  });

  test("a token minted for ANOTHER session does not open this one", async () => {
    const next = jest.fn();
    const response = makeResponse(embed());
    const token = mintSessionToken({ embedUuid: EMBED_UUID, sessionId: OTHER_SESSION });

    await embedHistoryAccess(makeRequest({ token }), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(403);
  });

  test("a token minted by ANOTHER embed does not open this one", async () => {
    // The signature covers the embed uuid, so a token is not portable between embeds even
    // when the session id matches — this is the cross-tenant case W-10 closed, re-closed
    // one layer earlier so it never reaches the ownership query.
    const next = jest.fn();
    const response = makeResponse(embed());
    const token = mintSessionToken({ embedUuid: "emb-other", sessionId: SESSION });

    await embedHistoryAccess(makeRequest({ token }), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(403);
  });

  test("an expired token is refused", async () => {
    const next = jest.fn();
    const response = makeResponse(embed());
    const token = mintSessionToken({
      embedUuid: EMBED_UUID,
      sessionId: SESSION,
      issuedAt: Date.now() - SESSION_TOKEN_TTL_MS - 1000,
    });

    await embedHistoryAccess(makeRequest({ token }), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
  });

  test("a tampered issuedAt does not extend a token's life", async () => {
    // The timestamp is inside the signed payload, so rewriting it invalidates the MAC
    // rather than buying more time.
    const expired = mintSessionToken({
      embedUuid: EMBED_UUID,
      sessionId: SESSION,
      issuedAt: Date.now() - SESSION_TOKEN_TTL_MS - 1000,
    });
    const [, signature] = expired.split(".");
    const forged = `${Date.now()}.${signature}`;
    const next = jest.fn();
    const response = makeResponse(embed());

    await embedHistoryAccess(makeRequest({ token: forged }), response, next);

    expect(next).not.toHaveBeenCalled();
  });

  test("a garbage token is refused without throwing", async () => {
    for (const token of ["", "...", "not-a-token", "a.b.c.d", "%%%"]) {
      const next = jest.fn();
      const response = makeResponse(embed());
      await embedHistoryAccess(makeRequest({ token }), response, next);
      expect(next).not.toHaveBeenCalled();
    }
  });

  test("the token is verified BEFORE the ownership query — an unsigned request costs no read", async () => {
    // Two reasons: an unauthenticated caller must not be able to make the database work,
    // and the ownership query must never become an oracle for which sessions exist.
    const response = makeResponse(embed());

    await embedHistoryAccess(makeRequest(), response, jest.fn());

    expect(prisma.embed_chats.findFirst).not.toHaveBeenCalled();
  });

  test("a valid token still does not bypass the W-10 ownership check", async () => {
    // Defence in depth: the token proves the bearer opened this session, the ownership row
    // proves the session belongs to this embed. Neither replaces the other.
    prisma.embed_chats.findFirst.mockResolvedValue(null);
    const next = jest.fn();
    const response = makeResponse(embed());
    const token = mintSessionToken({ embedUuid: EMBED_UUID, sessionId: SESSION });

    await embedHistoryAccess(makeRequest({ token }), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(404);
  });

  test("the token is accepted from a cookie as well as the header", async () => {
    // Cookie for same-origin widgets, bearer header for embeds that cannot set cookies
    // (third-party context, SameSite). PMO ruling: no cookie-parser dependency — the
    // Cookie header is parsed with stdlib string handling.
    const next = jest.fn();
    const response = makeResponse(embed());
    const token = mintSessionToken({ embedUuid: EMBED_UUID, sessionId: SESSION });

    await embedHistoryAccess(
      makeRequest({ cookie: `other=1; allm_session_token=${token}; x=2` }),
      response,
      next
    );

    expect(next).toHaveBeenCalledTimes(1);
  });

  test("a cookie carrying another session's token is still refused", async () => {
    const next = jest.fn();
    const response = makeResponse(embed());
    const token = mintSessionToken({ embedUuid: EMBED_UUID, sessionId: OTHER_SESSION });

    await embedHistoryAccess(
      makeRequest({ cookie: `allm_session_token=${token}` }),
      response,
      next
    );

    expect(next).not.toHaveBeenCalled();
  });

  test("the cheap gates still run first — a bad origin is refused without verifying", async () => {
    const next = jest.fn();
    const response = makeResponse(
      embed({ allowlist_domains: JSON.stringify(["https://other.example"]) })
    );
    const token = mintSessionToken({ embedUuid: EMBED_UUID, sessionId: SESSION });

    await embedHistoryAccess(makeRequest({ token }), response, next);

    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
    expect(prisma.embed_chats.findFirst).not.toHaveBeenCalled();
  });
});

describe("#32: token minting", () => {
  test("two sessions of the same embed get different tokens", async () => {
    const a = mintSessionToken({ embedUuid: EMBED_UUID, sessionId: SESSION });
    const b = mintSessionToken({ embedUuid: EMBED_UUID, sessionId: OTHER_SESSION });
    expect(a).not.toEqual(b);
  });

  test("the token does not contain the raw signing key", async () => {
    const token = mintSessionToken({ embedUuid: EMBED_UUID, sessionId: SESSION });
    expect(token).not.toContain(process.env.SIG_KEY);
  });
});

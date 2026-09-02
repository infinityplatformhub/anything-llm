// issue 32, QA-1 BLOCKER-1 — the mint endpoint was itself the hole.
//
// The history routes verify a signed token, which is what #32 set out to do. But
// stream-chat minted that token for whatever `sessionId` the request body named, with no
// check that the caller had any claim to it. So the gate was a formality:
//
//   POST /embed/:id/stream-chat  {sessionId: "<victim's uuid>"}   → 200 + a valid token
//   GET  /embed/:id/<victim's uuid>   with that token             → 200 + their history
//
// An attacker who learned a session UUID — the exact threat #32 exists to close — could
// mint their way past the gate in one extra request. The token proved possession of a
// UUID, which is precisely the property the raw UUID already had.
//
// The fix is that minting is no longer unconditional either. A token is issued when a
// session is genuinely NEW (no embed_chats row for this embed+session), or when the caller
// already holds a valid token for it (rotation). Naming an existing session without proof
// gets no token.
//
// This suite drives the real route stack through supertest — validEmbedConfig,
// setConnectionMeta, canRespond, the handler — because the bug lives in how those compose,
// and a unit test of the middleware in isolation would not have caught it.
//
// RED on ee4be889: the oracle case returns 200 with a token even with the flag ON.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();
process.env.SIG_KEY = process.env.SIG_KEY || "a".repeat(64);
process.env.SIG_SALT = process.env.SIG_SALT || "b".repeat(64);

const express = require("express");
const request = require("supertest");

jest.mock("../utils/prisma", () => ({
  embed_chats: { findFirst: jest.fn(), count: jest.fn() },
}));
jest.mock("../models/embedConfig", () => {
  const actual = jest.requireActual("../models/embedConfig");
  return {
    EmbedConfig: {
      ...actual.EmbedConfig,
      getWithWorkspace: jest.fn(),
      parseAllowedHosts: actual.EmbedConfig.parseAllowedHosts,
    },
  };
});
jest.mock("../models/embedChats", () => ({
  EmbedChats: { count: jest.fn(), forEmbedByUser: jest.fn(), markHistoryInvalid: jest.fn() },
}));
jest.mock("../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
// The chat itself is not under test; the token in the response headers is.
jest.mock("../utils/chats/embed", () => ({
  streamChatWithForEmbed: jest.fn(async (response) => {
    response.write("data: {}\n\n");
  }),
}));

const prisma = require("../utils/prisma");
const { EmbedConfig } = require("../models/embedConfig");
const { EmbedChats } = require("../models/embedChats");
const { embeddedEndpoints } = require("../endpoints/embed");
const {
  SESSION_TOKEN_HEADER,
  mintSessionToken,
} = require("../utils/middleware/embedSessionToken");

const EMBED_UUID = "emb-1111-2222-3333";
const VICTIM_SESSION = "123e4567-e89b-42d3-a456-426614174000";
const FRESH_SESSION = "99999999-e89b-42d3-a456-426614174000";
const ORIGIN = "https://allowed.example";

const embedRow = (over = {}) => ({
  id: 1,
  uuid: EMBED_UUID,
  enabled: true,
  chat_mode: "chat",
  allowlist_domains: JSON.stringify([ORIGIN]),
  max_chats_per_day: null,
  max_chats_per_session: null,
  workspace: { id: 1 },
  ...over,
});

function appWithEmbed() {
  const app = express();
  app.use(express.json());
  embeddedEndpoints(app);
  return app;
}

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  process.env.EMBED_REQUIRE_SESSION_TOKEN = "true";
  EmbedConfig.getWithWorkspace.mockResolvedValue(embedRow());
  EmbedChats.count.mockResolvedValue(0);
  EmbedChats.forEmbedByUser.mockResolvedValue([]);
  EmbedChats.markHistoryInvalid.mockResolvedValue(undefined);
});
afterEach(() => {
  if (ORIGINAL_ENV.EMBED_REQUIRE_SESSION_TOKEN === undefined)
    delete process.env.EMBED_REQUIRE_SESSION_TOKEN;
  else process.env.EMBED_REQUIRE_SESSION_TOKEN = ORIGINAL_ENV.EMBED_REQUIRE_SESSION_TOKEN;
});

describe("issue 32 BLOCKER-1: stream-chat must not mint a token for someone else's session", () => {
  test("naming an EXISTING session id yields no token — the oracle is closed", async () => {
    // The attack in one request. The victim's session already has chat rows; an attacker
    // who learned the UUID asks for a token against it.
    prisma.embed_chats.findFirst.mockResolvedValue({ id: 55 }); // session exists

    const response = await request(appWithEmbed())
      .post(`/embed/${EMBED_UUID}/stream-chat`)
      .set("Origin", ORIGIN)
      .send({ sessionId: VICTIM_SESSION, message: "hello" });

    expect(response.headers[SESSION_TOKEN_HEADER]).toBeUndefined();
  });

  test("a genuinely NEW session still gets its token — the widget must keep working", async () => {
    // Positive control. Without this the fix could pass by minting nothing, ever.
    prisma.embed_chats.findFirst.mockResolvedValue(null); // no rows yet

    const response = await request(appWithEmbed())
      .post(`/embed/${EMBED_UUID}/stream-chat`)
      .set("Origin", ORIGIN)
      .send({ sessionId: FRESH_SESSION, message: "hello" });

    expect(response.headers[SESSION_TOKEN_HEADER]).toEqual(expect.any(String));
    expect(response.headers[SESSION_TOKEN_HEADER].length).toBeGreaterThan(0);
  });

  test("an existing session WITH a valid token gets a fresh one — rotation still works", async () => {
    // The ongoing-conversation case: second and later messages name a session that now has
    // rows, and the widget holds the token from the first. It must not be locked out.
    prisma.embed_chats.findFirst.mockResolvedValue({ id: 55 });
    const held = mintSessionToken({
      embedUuid: EMBED_UUID,
      sessionId: VICTIM_SESSION,
    });

    const response = await request(appWithEmbed())
      .post(`/embed/${EMBED_UUID}/stream-chat`)
      .set("Origin", ORIGIN)
      .set(SESSION_TOKEN_HEADER, held)
      .send({ sessionId: VICTIM_SESSION, message: "second message" });

    expect(response.headers[SESSION_TOKEN_HEADER]).toEqual(expect.any(String));
  });

  test("an existing session with ANOTHER session's token gets nothing", async () => {
    // A real credential pointed at the wrong session is not proof of this one.
    prisma.embed_chats.findFirst.mockResolvedValue({ id: 55 });
    const wrong = mintSessionToken({
      embedUuid: EMBED_UUID,
      sessionId: FRESH_SESSION,
    });

    const response = await request(appWithEmbed())
      .post(`/embed/${EMBED_UUID}/stream-chat`)
      .set("Origin", ORIGIN)
      .set(SESSION_TOKEN_HEADER, wrong)
      .send({ sessionId: VICTIM_SESSION, message: "hello" });

    expect(response.headers[SESSION_TOKEN_HEADER]).toBeUndefined();
  });

  test("an existing session with another EMBED's token gets nothing", async () => {
    prisma.embed_chats.findFirst.mockResolvedValue({ id: 55 });
    const wrongEmbed = mintSessionToken({
      embedUuid: "emb-somewhere-else",
      sessionId: VICTIM_SESSION,
    });

    const response = await request(appWithEmbed())
      .post(`/embed/${EMBED_UUID}/stream-chat`)
      .set("Origin", ORIGIN)
      .set(SESSION_TOKEN_HEADER, wrongEmbed)
      .send({ sessionId: VICTIM_SESSION, message: "hello" });

    expect(response.headers[SESSION_TOKEN_HEADER]).toBeUndefined();
  });

  test("end to end: mint-then-read cannot reach a victim's history", async () => {
    // The whole chain QA-1 described, asserted as one flow rather than two halves.
    const app = appWithEmbed();
    prisma.embed_chats.findFirst.mockResolvedValue({ id: 55 });

    const minted = await request(app)
      .post(`/embed/${EMBED_UUID}/stream-chat`)
      .set("Origin", ORIGIN)
      .send({ sessionId: VICTIM_SESSION, message: "hello" });
    const stolen = minted.headers[SESSION_TOKEN_HEADER];

    const read = await request(app)
      .get(`/embed/${EMBED_UUID}/${VICTIM_SESSION}`)
      .set("Origin", ORIGIN)
      .set(SESSION_TOKEN_HEADER, stolen ?? "");

    expect(read.status).not.toBe(200);
  });

  test("with the flag OFF the same request still mints nothing for an existing session", async () => {
    // The flag governs whether tokens are DEMANDED on the history routes. It must not be a
    // way to turn the oracle back on: a deployment mid-rollout would otherwise hand out
    // tokens that become valid the moment the flag flips.
    delete process.env.EMBED_REQUIRE_SESSION_TOKEN;
    prisma.embed_chats.findFirst.mockResolvedValue({ id: 55 });

    const response = await request(appWithEmbed())
      .post(`/embed/${EMBED_UUID}/stream-chat`)
      .set("Origin", ORIGIN)
      .send({ sessionId: VICTIM_SESSION, message: "hello" });

    expect(response.headers[SESSION_TOKEN_HEADER]).toBeUndefined();
  });

  test("with the flag OFF a new session is still served — no regression for old widgets", async () => {
    delete process.env.EMBED_REQUIRE_SESSION_TOKEN;
    prisma.embed_chats.findFirst.mockResolvedValue(null);

    const response = await request(appWithEmbed())
      .post(`/embed/${EMBED_UUID}/stream-chat`)
      .set("Origin", ORIGIN)
      .send({ sessionId: FRESH_SESSION, message: "hello" });

    expect(response.status).toBe(200);
  });
});

describe("issue 32 QA-1 (4): the signature is keyed, not merely a hash", () => {
  test("two SIG_KEY values produce different signatures for the same session", async () => {
    // If the key were ignored, anyone could compute a token offline from public inputs.
    const original = process.env.SIG_KEY;
    process.env.SIG_KEY = "k".repeat(64);
    const first = mintSessionToken({
      embedUuid: EMBED_UUID,
      sessionId: VICTIM_SESSION,
      issuedAt: 1700000000000,
    });
    process.env.SIG_KEY = "z".repeat(64);
    const second = mintSessionToken({
      embedUuid: EMBED_UUID,
      sessionId: VICTIM_SESSION,
      issuedAt: 1700000000000,
    });
    process.env.SIG_KEY = original;

    expect(first).not.toEqual(second);
  });
});

describe("issue 32 QA-1 (5): Access-Control-Expose-Headers appends", () => {
  test("an existing expose list is preserved, not overwritten", async () => {
    // Overwriting would silently break any other header a deployment already exposes.
    prisma.embed_chats.findFirst.mockResolvedValue(null);
    const app = express();
    app.use(express.json());
    app.use((_request, response, next) => {
      response.setHeader("Access-Control-Expose-Headers", "X-Existing-Header");
      next();
    });
    embeddedEndpoints(app);

    const response = await request(app)
      .post(`/embed/${EMBED_UUID}/stream-chat`)
      .set("Origin", ORIGIN)
      .send({ sessionId: FRESH_SESSION, message: "hello" });

    const exposed = response.headers["access-control-expose-headers"];
    expect(exposed).toContain("X-Existing-Header");
    expect(exposed.toLowerCase()).toContain(SESSION_TOKEN_HEADER);
  });
});

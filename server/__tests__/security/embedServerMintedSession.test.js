// issue 49 — the embed session id must be minted by the SERVER, not chosen by the client.
//
// #32 closed the "you must PROVE the session id" half of G12 with a signed token, but the
// id itself is still picked by the widget (embed/src/hooks/useSessionId.js mints a v4 UUID
// into localStorage) and the server decides entitlement by asking whether an embed_chats
// row exists yet. All four residual holes recorded in residual-risks.md follow from that
// single fact, which is why tightening the mint RULE again cannot close them — any rule of
// the form "mint for free in some case" leaves that case open, and #32's is already the
// narrowest one that keeps a first message working.
//
//   hole 1  the pre-first-message window: EmbedChats.new writes the row only after the LLM
//           has replied, so between a victim's first request and their first stored reply
//           an attacker naming the same id is also "new" and is handed a valid token.
//   hole 2  two concurrent first requests both read "no row" and both mint.
//   hole 3  entitlement derived from rows means emptying the rows re-opens minting.
//   hole 4  a token in the response headers vs. its absence is itself an existence oracle.
//
// The shape that closes all four: POST /embed/:embedId/session generates the id with
// crypto.randomUUID() and returns it with its token. Nobody chooses an id, so there is
// nothing to race for, nothing to name, and nothing to derive from rows.
//
// Driven through the real route stack with supertest rather than against the middleware in
// isolation, because every one of these holes lives in how the pieces COMPOSE — the same
// reason the #32 oracle suite is written this way.
//
// RED on d39667d: /embed/:embedId/session does not exist, and stream-chat still mints.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();
process.env.SIG_KEY = process.env.SIG_KEY || "a".repeat(64);
process.env.SIG_SALT = process.env.SIG_SALT || "b".repeat(64);

const express = require("express");
const request = require("supertest");
const { validate: validateUuid } = require("uuid");

jest.mock("../../utils/prisma", () => ({
  embed_chats: { findFirst: jest.fn(), count: jest.fn() },
}));
jest.mock("../../models/embedConfig", () => {
  const actual = jest.requireActual("../../models/embedConfig");
  return {
    EmbedConfig: {
      ...actual.EmbedConfig,
      getWithWorkspace: jest.fn(),
      parseAllowedHosts: actual.EmbedConfig.parseAllowedHosts,
    },
  };
});
jest.mock("../../models/embedChats", () => ({
  EmbedChats: {
    count: jest.fn(),
    forEmbedByUser: jest.fn(),
    markHistoryInvalid: jest.fn(),
  },
}));
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
jest.mock("../../utils/chats/embed", () => ({
  streamChatWithForEmbed: jest.fn(async (response) => {
    response.write("data: {}\n\n");
  }),
}));

const prisma = require("../../utils/prisma");
const { EmbedConfig } = require("../../models/embedConfig");
const { EmbedChats } = require("../../models/embedChats");
const { embeddedEndpoints } = require("../../endpoints/embed");
const {
  SESSION_TOKEN_HEADER,
  verifySessionToken,
} = require("../../utils/middleware/embedSessionToken");

const EMBED_UUID = "emb-1111-2222-3333";
const OTHER_EMBED_UUID = "emb-9999-8888-7777";
const VICTIM_SESSION = "123e4567-e89b-42d3-a456-426614174000";
const ABSENT_SESSION = "00000000-e89b-42d3-a456-426614174000";
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

const open = (app, body) => {
  const call = request(app)
    .post(`/embed/${EMBED_UUID}/session`)
    .set("Origin", ORIGIN);
  return body === undefined ? call.send() : call.send(body);
};

const historyGet = (sessionId, token) => {
  const call = request(appWithEmbed())
    .get(`/embed/${EMBED_UUID}/${sessionId}`)
    .set("Origin", ORIGIN);
  return token ? call.set(SESSION_TOKEN_HEADER, token) : call;
};

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  process.env.EMBED_REQUIRE_SESSION_TOKEN = "true";
  EmbedConfig.getWithWorkspace.mockResolvedValue(embedRow());
  EmbedChats.count.mockResolvedValue(0);
  EmbedChats.forEmbedByUser.mockResolvedValue([]);
  EmbedChats.markHistoryInvalid.mockResolvedValue(undefined);
  prisma.embed_chats.findFirst.mockResolvedValue(null);
});
afterEach(() => {
  if (ORIGINAL_ENV.EMBED_REQUIRE_SESSION_TOKEN === undefined)
    delete process.env.EMBED_REQUIRE_SESSION_TOKEN;
  else
    process.env.EMBED_REQUIRE_SESSION_TOKEN =
      ORIGINAL_ENV.EMBED_REQUIRE_SESSION_TOKEN;
});

describe("issue 49: the session-open endpoint mints the id itself", () => {
  test("POST /embed/:embedId/session returns a server-generated id with its token", async () => {
    const response = await open(appWithEmbed());

    expect(response.status).toBe(200);
    expect(validateUuid(String(response.body.sessionId))).toBe(true);
    expect(
      verifySessionToken({
        token: response.body.token,
        embedUuid: EMBED_UUID,
        sessionId: response.body.sessionId,
      })
    ).toEqual({ valid: true });
  });

  test("the minted token is bound to the embed that issued it", async () => {
    // Without this, a token minted under one embed would open another's history — the
    // cross-tenant half of G12 that #29 W-10 closed, reopened by a new endpoint.
    const response = await open(appWithEmbed());

    expect(
      verifySessionToken({
        token: response.body.token,
        embedUuid: OTHER_EMBED_UUID,
        sessionId: response.body.sessionId,
      })
    ).toEqual({ valid: false, reason: "mismatch" });
  });

  test("opening twice yields two different ids", async () => {
    // hole 2 needs no race to be demonstrated: if the server picks the id, two opens cannot
    // collide, and that is the whole of the fix.
    const app = appWithEmbed();
    const first = await open(app);
    const second = await open(app);

    expect(first.body.sessionId).not.toEqual(second.body.sessionId);
  });

  test("an id supplied in the BODY is ignored, not honoured", async () => {
    // The one way hole 2 comes back. An endpoint that accepts a caller's id is a
    // client-chosen id wearing a server-minted name, and every hole returns with it.
    const response = await open(appWithEmbed(), { sessionId: VICTIM_SESSION });

    expect(response.body.sessionId).not.toEqual(VICTIM_SESSION);
    expect(
      verifySessionToken({
        token: response.body.token,
        embedUuid: EMBED_UUID,
        sessionId: VICTIM_SESSION,
      })
    ).toEqual({ valid: false, reason: "mismatch" });
  });

  test("an id supplied in the QUERY is ignored, not honoured", async () => {
    // Asserted separately from the body: a handler reading reqBody() only would pass the
    // test above and still honour ?sessionId=, and the two are different code paths.
    const response = await request(appWithEmbed())
      .post(`/embed/${EMBED_UUID}/session?sessionId=${VICTIM_SESSION}`)
      .set("Origin", ORIGIN)
      .send();

    // The status is asserted first on purpose: without it a 404 satisfies the line below
    // (an absent body has no sessionId to compare), and the test would go green before the
    // route it is testing exists at all.
    expect(response.status).toBe(200);
    expect(response.body.sessionId).not.toEqual(VICTIM_SESSION);
  });

  test("the open endpoint never consults embed_chats", async () => {
    // hole 3 in its most direct form. Entitlement that reads rows is entitlement that comes
    // back the moment the rows go away — an embed delete cascades embed_chats
    // (schema.prisma, onDelete: Cascade), and any future hard-delete of chats does the same.
    // Asserting "no query" is stronger than asserting the outcome, because an implementation
    // that queries and ignores the answer today starts using it tomorrow.
    const response = await open(appWithEmbed());

    // Same trap as above: a route that does not exist queries nothing either.
    expect(response.status).toBe(200);
    expect(prisma.embed_chats.findFirst).not.toHaveBeenCalled();
  });

  test("two opens are identical in shape regardless of what the caller knows", async () => {
    // hole 4. Compared as whole shapes — status, sorted key set, header presence — rather
    // than field by field: a parsed comparison lets a stray key through, which is exactly
    // how a response-shape oracle survives the fix meant to close it (the S-25 lesson).
    const app = appWithEmbed();
    const shape = (res) => ({
      status: res.status,
      keys: Object.keys(res.body).sort(),
      carriesToken: SESSION_TOKEN_HEADER in res.headers,
    });

    prisma.embed_chats.findFirst.mockResolvedValue({ id: 55 });
    const knowsAnExistingSession = await open(app, { sessionId: VICTIM_SESSION });
    prisma.embed_chats.findFirst.mockResolvedValue(null);
    const knowsNothing = await open(app);

    // Two 404s are also identical in shape, so the status is pinned before comparing them.
    expect(knowsNothing.status).toBe(200);
    expect(shape(knowsAnExistingSession)).toEqual(shape(knowsNothing));
  });
});

describe("issue 49: stream-chat stops minting, so the row-shaped holes close", () => {
  const chat = (sessionId, token) => {
    const call = request(appWithEmbed())
      .post(`/embed/${EMBED_UUID}/stream-chat`)
      .set("Origin", ORIGIN);
    return (token ? call.set(SESSION_TOKEN_HEADER, token) : call).send({
      sessionId,
      message: "hello",
    });
  };

  test("hole 1 — a session with no stored reply yet gets no token from stream-chat", async () => {
    // The pre-first-message window. The victim has POSTed but the LLM has not replied, so no
    // embed_chats row exists; under the #32 rule that made the attacker "new" too, and the
    // window is as long as the model takes to answer.
    prisma.embed_chats.findFirst.mockResolvedValue(null);

    const response = await chat(VICTIM_SESSION);

    expect(response.headers[SESSION_TOKEN_HEADER]).toBeUndefined();
  });

  test("hole 3 — emptying embed_chats does not make a session mintable again", async () => {
    // Reaches the same state as hole 1 by a different route, and that IS the result: once
    // entitlement stops being derived from rows, "no rows" stops being a state that grants
    // anything. Kept as its own test because it is its own residual — a future change that
    // re-derives entitlement from rows must fail both, not one.
    prisma.embed_chats.findFirst.mockResolvedValue(null);

    const response = await chat(VICTIM_SESSION);

    expect(response.headers[SESSION_TOKEN_HEADER]).toBeUndefined();
  });

  test("a chat carrying a valid server-minted token still works", async () => {
    // Positive control. Without it every assertion above is satisfied by a server that
    // refuses everything, and the feature ships broken with a green suite.
    const opened = await open(appWithEmbed());

    const response = await chat(opened.body.sessionId, opened.body.token);

    expect(response.status).toBe(200);
  });
});

describe("issue 49: enforcement on the history routes", () => {
  test("a client-minted id is refused once the flag is on", async () => {
    // Ruling 4: existing client-minted sessions are refused rather than honoured. Honouring
    // an id that was never server-issued re-opens hole 3 in a quieter shape, and a visible
    // logout beats a silent hole.
    prisma.embed_chats.findFirst.mockResolvedValue({ id: 55 });

    const response = await historyGet(VICTIM_SESSION);

    expect(response.status).toBe(401);
  });

  test("that refusal is indistinguishable from one for a session that never existed", async () => {
    // If "yours but unproven" and "never existed" differ, the gate is an existence oracle and
    // the visitor's privacy leaks through the error rather than through the data.
    prisma.embed_chats.findFirst.mockResolvedValue({ id: 55 });
    const exists = await historyGet(VICTIM_SESSION);
    prisma.embed_chats.findFirst.mockResolvedValue(null);
    const absent = await historyGet(ABSENT_SESSION);

    expect({ status: absent.status, body: absent.body }).toEqual({
      status: exists.status,
      body: exists.body,
    });
  });

  test("with the flag OFF behaviour is exactly as today", async () => {
    // The rollout path is server, then widget, then flag. Asserted so it is not discovered to
    // be broken at the moment someone needs it.
    delete process.env.EMBED_REQUIRE_SESSION_TOKEN;
    prisma.embed_chats.findFirst.mockResolvedValue({ id: 55 });

    const response = await historyGet(VICTIM_SESSION);

    expect(response.status).toBe(200);
  });

  test("a server-minted token opens its own history", async () => {
    // Positive control for the gate: without it, a route that 401s unconditionally passes
    // both refusal tests above.
    const opened = await open(appWithEmbed());
    prisma.embed_chats.findFirst.mockResolvedValue({ id: 55 });

    const response = await historyGet(opened.body.sessionId, opened.body.token);

    expect(response.status).toBe(200);
  });
});

describe("issue 49: the two #32 gaps that never got tests", () => {
  test("NIT-3 — the session lookup is scoped to this embed, not to the id alone", async () => {
    // Dropping embed_id from the where clause is a cross-tenant mint DoS: one embed's session
    // ids would suppress another's. The scoping exists; nothing asserted it.
    const opened = await open(appWithEmbed());
    prisma.embed_chats.findFirst.mockResolvedValue({ id: 55 });

    await historyGet(opened.body.sessionId, opened.body.token);

    expect(prisma.embed_chats.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ embed_id: 1 }),
      })
    );
  });

  test("NIT-4 — every embed route is behind the IP rate limiter", async () => {
    // The limiter bounds how fast an unauthenticated caller can probe these routes. Asserted
    // by walking the router's own stack rather than by reading index.js: a route added later
    // without it fails here, which is the whole point of the assertion.
    const {
      embedHistoryRateLimit,
    } = require("../../utils/middleware/requestControls");

    const layers = appWithEmbed()._router.stack.filter((layer) => layer.route);
    expect(layers.length).toBeGreaterThan(0);
    for (const layer of layers) {
      const handlers = layer.route.stack.map((entry) => entry.handle);
      expect({
        path: layer.route.path,
        limited: handlers.includes(embedHistoryRateLimit),
      }).toEqual({ path: layer.route.path, limited: true });
    }
  });
});

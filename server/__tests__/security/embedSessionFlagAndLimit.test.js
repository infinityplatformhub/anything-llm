// issue 49, QA-1 probe plan — the two questions the peer raised about how the mint endpoint
// is GOVERNED rather than how it mints.
//
// Q1: `EMBED_REQUIRE_SESSION_TOKEN` is presence-based (`"KEY" in process.env`), so setting it
//     to the string "false" ENABLES enforcement. Deliberate or a bug?
//
//     Deliberate, and asserted here so it stops being rediscovered. Every security flag in
//     this file uses the same convention — EMBED_REQUIRE_ALLOWLIST beside it, and
//     RETRIEVAL_FILTER_ALLOW_UNPROVABLE in the retrieval path — because the alternative
//     fails in the wrong direction: under boolean parsing a typo (`EMBED_REQUIRE_SESSION_
//     TOKEN=ture`, `=0`, `=off`) silently disables a gate the operator believes is on, and
//     nothing anywhere says so. Presence-based, the only way to have the variable and not the
//     gate is to delete the variable, which is a thing an operator does on purpose.
//
//     The cost is real and worth stating: an operator who writes `=false` meaning "off" gets
//     "on". That fails CLOSED — an unexpected 401 is visible within minutes, where an
//     unexpected open gate is not visible at all.
//
// Q2: does `embedHistoryRateLimit` count into ONE bucket shared by everybody, which would
//     make one noisy caller a denial of service for every other visitor (the #80 lesson)?
//
//     Measured below rather than argued: it keys on the client IP, so two callers have two
//     budgets. What it does NOT separate is embeds — one IP's budget is shared across every
//     embed it touches — which is a self-inflicted limit, not a cross-tenant one, and is
//     recorded as a residual rather than left implicit.

process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();
process.env.SIG_KEY = process.env.SIG_KEY || "a".repeat(64);
process.env.SIG_SALT = process.env.SIG_SALT || "b".repeat(64);

const express = require("express");
const request = require("supertest");

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
  resetRequestControls,
} = require("../../utils/middleware/requestControls");

const EMBED_UUID = "emb-1111-2222-3333";
const VICTIM_SESSION = "123e4567-e89b-42d3-a456-426614174000";
const ORIGIN = "https://allowed.example";

const embedRow = () => ({
  id: 1,
  uuid: EMBED_UUID,
  enabled: true,
  chat_mode: "chat",
  allowlist_domains: JSON.stringify([ORIGIN]),
  max_chats_per_day: null,
  max_chats_per_session: null,
  workspace: { id: 1 },
});

function appWithEmbed() {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  embeddedEndpoints(app);
  return app;
}

const ORIGINAL_ENV = { ...process.env };
beforeEach(async () => {
  jest.clearAllMocks();
  await resetRequestControls();
  EmbedConfig.getWithWorkspace.mockResolvedValue(embedRow());
  EmbedChats.count.mockResolvedValue(0);
  EmbedChats.forEmbedByUser.mockResolvedValue([]);
  prisma.embed_chats.findFirst.mockResolvedValue({ id: 55 });
});
afterEach(() => {
  for (const key of ["EMBED_REQUIRE_SESSION_TOKEN", "EMBED_RATE_LIMIT_MAX"]) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
});

describe("issue 49 Q1: EMBED_REQUIRE_SESSION_TOKEN is presence-based on purpose", () => {
  const historyGet = () =>
    request(appWithEmbed())
      .get(`/embed/${EMBED_UUID}/${VICTIM_SESSION}`)
      .set("Origin", ORIGIN);

  test('the string "false" ENABLES enforcement — presence is the signal, not the value', async () => {
    // The surprising direction, asserted so a future reader meets it as a decision rather
    // than as a bug. Fails closed: a confused operator gets a gate they did not expect, not
    // an opening they cannot see.
    process.env.EMBED_REQUIRE_SESSION_TOKEN = "false";

    expect((await historyGet()).status).toBe(401);
  });

  test("an empty value also enables it", async () => {
    // `KEY=` in a .env file is the other way an operator writes "off", and it must not be
    // the one spelling that quietly disables the gate.
    process.env.EMBED_REQUIRE_SESSION_TOKEN = "";

    expect((await historyGet()).status).toBe(401);
  });

  test("deleting the variable is the only way to disable it", async () => {
    delete process.env.EMBED_REQUIRE_SESSION_TOKEN;

    expect((await historyGet()).status).toBe(200);
  });
});

describe("issue 49 Q2: the mint endpoint's rate limit is per caller, not one shared bucket", () => {
  // Two callers are staged by overwriting `socket.remoteAddress` in a middleware mounted
  // BEFORE the limiter, which is what `canonicalIp` actually reads. X-Forwarded-For does not
  // work and must not: a header the caller writes would be a rate-limit bypass with extra
  // steps, and every limiter in this file would be one header away from unlimited.
  //
  // Both addresses are IPv4 on purpose. `canonicalIp` collapses IPv6 to its /64 deliberately
  // — an attacker with a v6 allocation would otherwise have a fresh budget per address — so
  // two v6 addresses in one /64 SHOULD share a bucket, and using them here would assert the
  // opposite of the intended design while looking like a stronger test.
  const appFrom = (currentIp) => {
    const app = express();
    app.use((request_, _response, next) => {
      Object.defineProperty(request_.socket, "remoteAddress", {
        value: currentIp(),
        configurable: true,
      });
      next();
    });
    app.use(express.json());
    embeddedEndpoints(app);
    return app;
  };

  test("one caller exhausting the budget does not lock out a different caller", async () => {
    // The #80 lesson in its concrete form. A single shared counter would make the mint
    // endpoint a denial-of-service lever: anyone could spend the budget and stop every other
    // visitor from opening a session.
    process.env.EMBED_RATE_LIMIT_MAX = "1";
    let ip = "10.0.0.7";
    const app = appFrom(() => ip);
    const open = () =>
      request(app).post(`/embed/${EMBED_UUID}/session`).set("Origin", ORIGIN).send();

    const first = await open();
    const exhausted = await open();
    ip = "10.0.0.8";
    const bystander = await open();

    expect({
      first: first.status,
      exhausted: exhausted.status,
      bystander: bystander.status,
    }).toEqual({ first: 200, exhausted: 429, bystander: 200 });
  });

  test("the second caller's 200 is a different bucket, not a reset one", async () => {
    // Guards the mutant this test would otherwise miss: a limiter with ONE shared bucket that
    // happened to reset between requests would also produce 200/429/200, and the test above
    // could not tell the two apart. Here the first caller comes BACK after the second was
    // served — still refused, so the counter it spent was its own and is still spent.
    process.env.EMBED_RATE_LIMIT_MAX = "1";
    let ip = "10.0.0.7";
    const app = appFrom(() => ip);
    const open = () =>
      request(app).post(`/embed/${EMBED_UUID}/session`).set("Origin", ORIGIN).send();

    await open();
    ip = "10.0.0.8";
    const other = await open();
    ip = "10.0.0.7";
    const back = await open();

    expect({ other: other.status, back: back.status }).toEqual({
      other: 200,
      back: 429,
    });
  });

  test("the budget IS shared across embeds for one caller — recorded, not asserted away", async () => {
    // The key is the IP alone, so a caller's budget spans every embed it touches. That is a
    // self-inflicted limit rather than a cross-tenant one — it cannot be used to throttle
    // anyone else, because the key IS the caller — but it is a real property, and asserting
    // it here means making the key per-(ip, embed) later is a visible decision rather than an
    // accident nobody notices.
    process.env.EMBED_RATE_LIMIT_MAX = "1";
    const app = appWithEmbed();

    const first = await request(app)
      .post(`/embed/${EMBED_UUID}/session`)
      .set("Origin", ORIGIN)
      .send();
    EmbedConfig.getWithWorkspace.mockResolvedValue({
      ...embedRow(),
      id: 2,
      uuid: "emb-second-embed",
    });
    const second = await request(app)
      .post(`/embed/emb-second-embed/session`)
      .set("Origin", ORIGIN)
      .send();

    expect({ first: first.status, second: second.status }).toEqual({
      first: 200,
      second: 429,
    });
  });
});

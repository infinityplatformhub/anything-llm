const { v4: uuidv4, validate } = require("uuid");
const { VALID_CHAT_MODE } = require("../chats/stream");
const { EmbedChats } = require("../../models/embedChats");
const { EmbedConfig } = require("../../models/embedConfig");
const { reqBody } = require("../http");
const prisma = require("../prisma");
const {
  verifySessionToken,
  tokenFromRequest,
} = require("./embedSessionToken");

/**
 * issue 32: is session-token proof required on the history routes?
 *
 * Presence-based, matching EMBED_REQUIRE_ALLOWLIST directly below it rather than inventing
 * a second truthiness convention in the same file. Read per-request, not captured at module
 * load, so a test can flip it without re-requiring the module.
 */
const requireSessionToken = () => "EMBED_REQUIRE_SESSION_TOKEN" in process.env;

// Finds or Aborts request for a /:embedId/ url. This should always
// be the first middleware and the :embedID should be in the URL.
async function validEmbedConfig(request, response, next) {
  const { embedId } = request.params;

  const embed = await EmbedConfig.getWithWorkspace({ uuid: String(embedId) });
  if (!embed) {
    response.sendStatus(404).end();
    return;
  }

  response.locals.embedConfig = embed;
  next();
}

function setConnectionMeta(request, response, next) {
  response.locals.connection = {
    host: request.headers?.origin,
    ip: request?.ip,
  };
  next();
}

async function validEmbedConfigId(request, response, next) {
  const { embedId } = request.params;

  const embed = await EmbedConfig.get({ id: Number(embedId) });
  if (!embed) {
    response.sendStatus(404).end();
    return;
  }

  response.locals.embedConfig = embed;
  next();
}

async function canRespond(request, response, next) {
  try {
    const embed = response.locals.embedConfig;
    if (!embed) {
      response.sendStatus(404).end();
      return;
    }

    // Block if disabled by admin.
    if (!embed.enabled) {
      response.status(503).json({
        id: uuidv4(),
        type: "abort",
        textResponse: null,
        sources: [],
        close: true,
        error:
          "This chat has been disabled by the administrator - try again later.",
      });
      return;
    }

    // Check if requester hostname is in the valid allowlist of domains.
    const host = request.headers.origin ?? "";
    const allowedHosts = EmbedConfig.parseAllowedHosts(embed);

    // Optional hardening for when an embed with no allowlist is created.
    // This would mean the embed will accept requests from ANY origin (parseAllowedHosts returns
    // null). When EMBED_REQUIRE_ALLOWLIST is enabled, treat "no allowlist" as
    // deny-all instead of allow-all, so an embed cannot be queried cross-origin
    // until its owner explicitly sets the allowed domains.
    if (allowedHosts === null && "EMBED_REQUIRE_ALLOWLIST" in process.env) {
      response.status(401).json({
        id: uuidv4(),
        type: "abort",
        textResponse: null,
        sources: [],
        close: true,
        error: "Invalid request.",
      });
      return;
    }

    if (allowedHosts !== null && !allowedHosts.includes(host)) {
      response.status(401).json({
        id: uuidv4(),
        type: "abort",
        textResponse: null,
        sources: [],
        close: true,
        error: "Invalid request.",
      });
      return;
    }

    const { sessionId, message } = reqBody(request);
    if (typeof sessionId !== "string" || !validate(String(sessionId))) {
      response.status(404).json({
        id: uuidv4(),
        type: "abort",
        textResponse: null,
        sources: [],
        close: true,
        error: "Invalid session ID.",
      });
      return;
    }

    if (!message?.length || !VALID_CHAT_MODE.includes(embed.chat_mode)) {
      response.status(400).json({
        id: uuidv4(),
        type: "abort",
        textResponse: null,
        sources: [],
        close: true,
        error: !message?.length
          ? "Message is empty."
          : `${embed.chat_mode} is not a valid mode.`,
      });
      return;
    }

    if (
      !isNaN(embed.max_chats_per_day) &&
      Number(embed.max_chats_per_day) > 0
    ) {
      const dailyChatCount = await EmbedChats.count({
        embed_id: embed.id,
        createdAt: {
          gte: new Date(new Date() - 24 * 60 * 60 * 1000),
        },
      });

      if (dailyChatCount >= Number(embed.max_chats_per_day)) {
        response.status(429).json({
          id: uuidv4(),
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: "Rate limit exceeded",
          errorMsg:
            "The quota for this chat has been reached. Try again later or contact the site owner.",
        });
        return;
      }
    }

    if (
      !isNaN(embed.max_chats_per_session) &&
      Number(embed.max_chats_per_session) > 0
    ) {
      const dailySessionCount = await EmbedChats.count({
        embed_id: embed.id,
        session_id: sessionId,
        createdAt: {
          gte: new Date(new Date() - 24 * 60 * 60 * 1000),
        },
      });

      if (dailySessionCount >= Number(embed.max_chats_per_session)) {
        response.status(429).json({
          id: uuidv4(),
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error:
            "Your quota for this chat has been reached. Try again later or contact the site owner.",
        });
        return;
      }
    }

    next();
  } catch {
    response.status(500).json({
      id: uuidv4(),
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: "Invalid request.",
    });
    return;
  }
}

/**
 * issue 49: gate for the session-open route (POST /embed/:embedId/session).
 *
 * Deliberately NOT canRespond and NOT embedHistoryAccess, though it looks like both:
 *
 *   - canRespond reads `sessionId` and `message` out of the body and 404s when the session
 *     id is not a UUID. At session open there is no session id yet — that is the whole
 *     point of the route — so canRespond would refuse every legitimate call.
 *   - embedHistoryAccess verifies a token for a session in the URL, and queries
 *     embed_chats to prove the session belongs to this embed. Neither exists yet either,
 *     and the query would put an embed_chats read back on the one path that must not have
 *     one (hole 3: entitlement that consults rows returns when the rows change).
 *
 * What it keeps is what actually applies before a session exists: the embed must be enabled,
 * and the caller must be on an allowed origin. An embed that restricts its origins must
 * restrict who can open a session on it, or the restriction is decorative.
 *
 * Answers with the same shapes those two use for the same conditions, so a caller cannot
 * tell which gate refused it.
 *
 * Must run after validEmbedConfig.
 */
async function embedSessionOpen(request, response, next) {
  try {
    const embed = response.locals.embedConfig;
    if (!embed) {
      response.status(404).json({ error: "Embed not found." });
      return;
    }

    if (!embed.enabled) {
      response.status(503).json({
        error:
          "This chat has been disabled by the administrator - try again later.",
      });
      return;
    }

    const host = request.headers?.origin ?? "";
    const allowedHosts = EmbedConfig.parseAllowedHosts(embed);
    // EMBED_REQUIRE_ALLOWLIST: an embed with no allowlist is denied, not allowed — the same
    // rule canRespond and embedHistoryAccess apply (F-12a).
    if (
      (allowedHosts === null && "EMBED_REQUIRE_ALLOWLIST" in process.env) ||
      (allowedHosts !== null && !allowedHosts.includes(host))
    ) {
      response.status(401).json({ error: "Invalid request." });
      return;
    }

    next();
  } catch {
    response.status(500).json({ error: "Invalid request." });
  }
}

/**
 * PR-0d (issue #12, G12): access gate for the history read/invalidate routes
 * (GET/DELETE /embed/:embedId/:sessionId). These previously ran with only
 * validEmbedConfig — no enabled check, no origin allowlist, no sessionId format
 * check — so anyone holding the public embedId could enumerate or invalidate
 * session histories cross-origin. Applies the same gates canRespond enforces
 * for chat, minus the chat-only quota/message checks.
 * Must run after validEmbedConfig.
 */
async function embedHistoryAccess(request, response, next) {
  try {
    const embed = response.locals.embedConfig;
    if (!embed) {
      response.status(404).json({ error: "Embed not found." });
      return;
    }

    const { sessionId } = request.params;
    if (typeof sessionId !== "string" || !validate(sessionId)) {
      response.status(404).json({ error: "Invalid session ID." });
      return;
    }

    if (!embed.enabled) {
      response.status(503).json({
        error:
          "This chat has been disabled by the administrator - try again later.",
      });
      return;
    }

    const host = request.headers?.origin ?? "";
    const allowedHosts = EmbedConfig.parseAllowedHosts(embed);
    // EMBED_REQUIRE_ALLOWLIST: same rule as canRespond — an embed with no
    // allowlist is denied, not allowed (F-12a).
    if (
      (allowedHosts === null && "EMBED_REQUIRE_ALLOWLIST" in process.env) ||
      (allowedHosts !== null && !allowedHosts.includes(host))
    ) {
      response.status(401).json({ error: "Invalid request." });
      return;
    }

    // issue 32: the session id must be PROVEN, not merely known. W-10 below closes the
    // cross-tenant half of G12 (embed A cannot name embed B's session); this closes the
    // other half, where anyone who learns a visitor's UUID reads their conversation.
    //
    // Before the ownership query on purpose, for two reasons: an unsigned caller must not
    // be able to make the database work, and that query must never become an oracle for
    // which session ids exist.
    //
    // Behind EMBED_REQUIRE_SESSION_TOKEN, default OFF (PMO ruling on #32). The widget that
    // stores the minted token and presents it back lives in the `embed/` submodule — a
    // separate repository shipping on its own cadence — so enforcing here by default would
    // 401 every existing widget the moment a server upgraded ahead of it. The server mints
    // unconditionally (see endpoints/embed/index.js), so a deployment can roll the widget
    // out first, confirm tokens are flowing, and only then set this flag. Turn it on once
    // the widget half has landed; until then this route is exactly as it was after W-10.
    if (requireSessionToken()) {
      const verdict = verifySessionToken({
        token: tokenFromRequest(request),
        embedUuid: String(embed.uuid),
        sessionId,
      });
      if (!verdict.valid) {
        // A token for a different session or embed is a real credential pointed at the
        // wrong thing (403); no token, a malformed one, or an expired one is simply
        // unproven (401). Neither answer says whether the session exists.
        const status = verdict.reason === "mismatch" ? 403 : 401;
        response.status(status).json({ error: "Invalid session credentials." });
        return;
      }
    }

    // T-4b (#29) W-10 / S-24 (G12): the session must belong to THIS embed. The gates above
    // prove the id is well-formed and the caller is on an allowed origin; none of them
    // prove the session was issued here, so embed A could read embed B's history by naming
    // B's session id under A's embedId — a tenant boundary, not just a visitor one.
    //
    // Last, on purpose: it is the only gate that queries, so a bad origin or a malformed
    // id is refused without touching the database.
    //
    // This narrows the hole to "you must know a session id issued for this embed"; it does
    // NOT make session ids unguessable. A signed cookie or an HMAC token minted at session
    // start is the rest of G12 and is a separate issue (PMO ruling).
    const ownsSession = await prisma.embed_chats.findFirst({
      where: { embed_id: embed.id, session_id: sessionId },
      select: { id: true },
    });
    // A session that belongs to another embed and one that exists nowhere get the same
    // answer: distinguishing them would confirm that some other embed owns that id.
    if (!ownsSession) {
      response.status(404).json({ error: "Invalid session ID." });
      return;
    }

    next();
  } catch {
    response.status(500).json({ error: "Invalid request." });
  }
}

module.exports = {
  setConnectionMeta,
  validEmbedConfig,
  validEmbedConfigId,
  canRespond,
  embedHistoryAccess,
  embedSessionOpen,
};

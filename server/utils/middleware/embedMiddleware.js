const { v4: uuidv4, validate } = require("uuid");
const { VALID_CHAT_MODE } = require("../chats/stream");
const { EmbedChats } = require("../../models/embedChats");
const { EmbedConfig } = require("../../models/embedConfig");
const { reqBody } = require("../http");

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
};

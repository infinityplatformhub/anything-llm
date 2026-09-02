const { v4: uuidv4 } = require("uuid");
const { reqBody, multiUserMode } = require("../../utils/http");
const { Telemetry } = require("../../models/telemetry");
const { streamChatWithForEmbed } = require("../../utils/chats/embed");
const { EmbedChats } = require("../../models/embedChats");
const {
  validEmbedConfig,
  canRespond,
  setConnectionMeta,
  embedHistoryAccess,
  embedSessionOpen,
} = require("../../utils/middleware/embedMiddleware");
const {
  embedHistoryRateLimit,
} = require("../../utils/middleware/requestControls");
const {
  mintIfEntitled,
  openSession,
  SESSION_TOKEN_HEADER,
} = require("../../utils/middleware/embedSessionToken");
const {
  convertToChatHistory,
  writeResponseChunk,
} = require("../../utils/helpers/chat/responses");

function embeddedEndpoints(app) {
  if (!app) return;

  // issue 32 QA-1 (3): rate-limited like the history routes. The per-embed quotas in
  // canRespond count chats, so they cap conversation volume — they do not cap how fast an
  // unauthenticated caller can probe this route, and mintIfEntitled now answers a question
  // about whether a session exists (by whether a token comes back). An IP limiter bounds
  // that probing at the same rate the history routes already use.
  // issue 49: where a session begins. The server picks the id here and signs it in the same
  // response, which is what closes the four holes #32 left — see openSession for why no
  // tightening of the old mint rule could.
  //
  // The caller sends nothing. Any sessionId in the body or query is ignored rather than
  // rejected: rejecting it would answer "was that a real id" to whoever asked, and ignoring
  // it cannot, because the reply is the same either way. That sameness is hole 4, and it is
  // why this returns one shape unconditionally — no branch on what the caller knows.
  //
  // Behind the same gates the history routes use, minus the chat-only checks: rate limited
  // because an unauthenticated caller can reach it, and origin-checked because an embed that
  // restricts its origins must restrict this too. NOT behind canRespond — that reads a
  // sessionId and a message out of the body, neither of which exists yet at session open.
  app.post(
    "/embed/:embedId/session",
    [embedHistoryRateLimit, validEmbedConfig, setConnectionMeta, embedSessionOpen],
    async (_, response) => {
      try {
        const { sessionId, token } = openSession({
          embed: response.locals.embedConfig,
        });
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.status(200).json({ sessionId, token });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/embed/:embedId/stream-chat",
    [embedHistoryRateLimit, validEmbedConfig, setConnectionMeta, canRespond],
    async (request, response) => {
      try {
        const embed = response.locals.embedConfig;
        const {
          sessionId,
          message,
          // optional keys for override of defaults if enabled.
          prompt = null,
          model = null,
          temperature = null,
          username = null,
        } = reqBody(request);

        // issue 49: this route no longer opens sessions — POST /embed/:embedId/session does,
        // and the id it returns is the server's own. What is left here is ROTATION: a caller
        // presenting a valid token for this session gets a fresh one, so a conversation
        // running past the 24h TTL is not logged out mid-thread.
        //
        // A caller without that proof gets no token and the chat still proceeds, rather than
        // a 4xx — refusing would answer "does this session exist" just as usefully as a
        // token would (#32 QA-1 BLOCKER-1, and hole 4 in the same shape).
        //
        // Sent as a header rather than only a cookie: an embed on a third-party origin
        // cannot rely on cookies surviving SameSite, and the widget already keeps its
        // session id in localStorage. Set before flushHeaders — an SSE response cannot
        // add headers once the stream is open.
        const sessionToken = await mintIfEntitled({
          embed,
          sessionId,
          request,
        });
        if (sessionToken) {
          response.setHeader(SESSION_TOKEN_HEADER, sessionToken);
          // Appended, not assigned: a deployment may already expose other headers, and
          // overwriting the list would silently stop them reaching the browser (QA-1 NIT-2).
          const exposed = response.getHeader("Access-Control-Expose-Headers");
          response.setHeader(
            "Access-Control-Expose-Headers",
            exposed ? `${exposed}, ${SESSION_TOKEN_HEADER}` : SESSION_TOKEN_HEADER
          );
        }

        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("Content-Type", "text/event-stream");
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Connection", "keep-alive");
        response.flushHeaders();

        await streamChatWithForEmbed(response, embed, message, sessionId, {
          promptOverride: prompt,
          modelOverride: model,
          temperatureOverride: temperature,
          username,
        });
        await Telemetry.sendTelemetry("embed_sent_chat", {
          multiUserMode: multiUserMode(response),
          LLMSelection: process.env.LLM_PROVIDER || "openai",
          Embedder: process.env.EMBEDDING_ENGINE || "inherit",
          VectorDbSelection: process.env.VECTOR_DB || "lancedb",
        });
        response.end();
      } catch (e) {
        console.error(e);
        writeResponseChunk(response, {
          id: uuidv4(),
          type: "abort",
          sources: [],
          textResponse: null,
          close: true,
          error: e.message,
        });
        response.end();
      }
    }
  );

  app.get(
    "/embed/:embedId/:sessionId",
    [embedHistoryRateLimit, validEmbedConfig, embedHistoryAccess],
    async (request, response) => {
      try {
        const { sessionId } = request.params;
        const embed = response.locals.embedConfig;
        const history = await EmbedChats.forEmbedByUser(
          embed.id,
          sessionId,
          null,
          null,
          true
        );

        response.status(200).json({ history: convertToChatHistory(history) });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/embed/:embedId/:sessionId",
    [embedHistoryRateLimit, validEmbedConfig, embedHistoryAccess],
    async (request, response) => {
      try {
        const { sessionId } = request.params;
        const embed = response.locals.embedConfig;

        await EmbedChats.markHistoryInvalid(embed.id, sessionId);
        response.status(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = { embeddedEndpoints };

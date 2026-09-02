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
} = require("../../utils/middleware/embedMiddleware");
const {
  embedHistoryRateLimit,
} = require("../../utils/middleware/requestControls");
const {
  mintIfEntitled,
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

        // issue 32: this is where a session first reaches the server, so it is where its
        // token is minted. The widget stores it and presents it on the history routes,
        // which is what turns a known session id into a proven one.
        //
        // QA-1 BLOCKER-1: minting is NOT unconditional. Issuing a token for whatever
        // sessionId the body named made the gate a formality — an attacker who learned a
        // victim's UUID could POST here, collect a valid token, and read their history with
        // it. mintIfEntitled issues one only for a genuinely new session, or to a caller
        // who already holds a valid token for this one (rotation); otherwise null, and the
        // chat still proceeds without a token rather than 4xx-ing, which would answer
        // "does this session exist" just as usefully.
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

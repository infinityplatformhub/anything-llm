const { EmbedChats } = require("../models/embedChats");
const { EmbedConfig } = require("../models/embedConfig");
const { emitAuditEvent } = require("../utils/events");
const { reqBody, userFromSession } = require("../utils/http");
const { validEmbedConfigId } = require("../utils/middleware/embedMiddleware");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { requirePermission } = require("../utils/middleware/requirePermission");
const { orgResource } = require("../utils/middleware/resourceResolvers");
const {
  chatHistoryViewable,
} = require("../utils/middleware/chatHistoryViewable");

function embedManagementEndpoints(app) {
  if (!app) return;

  app.get(
    "/embeds",
    [validatedRequest, requirePermission("embed.read", orgResource)],
    async (_, response) => {
      try {
        const embeds = await EmbedConfig.whereWithWorkspace({}, null, {
          createdAt: "desc",
        });
        response.status(200).json({ embeds });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/embeds/new",
    [validatedRequest, requirePermission("embed.write", orgResource)],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const data = reqBody(request);
        const { embed, message: error } = await EmbedConfig.new(data, user?.id);
        await emitAuditEvent("embed_created", { embedId: embed.id }, user?.id);
        response.status(200).json({ embed, error });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/embed/update/:embedId",
    [
      validatedRequest,
      requirePermission("embed.write", orgResource),
      validEmbedConfigId,
    ],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { embedId } = request.params;
        const updates = reqBody(request);
        const { success, error } = await EmbedConfig.update(embedId, updates);
        await emitAuditEvent("embed_updated", { embedId }, user?.id);
        response.status(200).json({ success, error });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/embed/:embedId",
    [
      validatedRequest,
      requirePermission("embed.delete", orgResource),
      validEmbedConfigId,
    ],
    async (request, response) => {
      try {
        const { embedId } = request.params;
        await EmbedConfig.delete({ id: Number(embedId) });
        await emitAuditEvent(
          "embed_deleted",
          { embedId },
          response?.locals?.user?.id
        );
        response.status(200).json({ success: true, error: null });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/embed/chats",
    [
      chatHistoryViewable,
      validatedRequest,
      requirePermission("chat.read_others", orgResource),
    ],
    async (request, response) => {
      try {
        const { offset = 0, limit = 20 } = reqBody(request);
        const embedChats = await EmbedChats.whereWithEmbedAndWorkspace(
          {},
          limit,
          { id: "desc" },
          offset * limit
        );
        const totalChats = await EmbedChats.count();
        const hasPages = totalChats > (offset + 1) * limit;
        response.status(200).json({ chats: embedChats, hasPages, totalChats });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/embed/chats/:chatId",
    [validatedRequest, requirePermission("chat.write", orgResource)],
    async (request, response) => {
      try {
        const { chatId } = request.params;
        await EmbedChats.delete({ id: Number(chatId) });
        response.status(200).json({ success: true, error: null });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = { embedManagementEndpoints };

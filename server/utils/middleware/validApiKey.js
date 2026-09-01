const { ApiKey } = require("../../models/apiKeys");
const { SystemSettings } = require("../../models/systemSettings");
const { emitAuditEvent } = require("../events");
const prisma = require("../prisma");

function validApiKey(action) {
  if (typeof action !== "string" || !action) throw new Error("validApiKey requires an explicit scope");
  const middleware = async function apiKeyRequired(request, response, next) {
    response.locals.multiUserMode = await SystemSettings.isMultiUserMode();
    const bearerKey = request.header("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const apiKey = bearerKey ? await ApiKey.resolve(bearerKey) : null;
    if (!apiKey) return response.status(403).json({ error: "No valid api key found." });
    const context = {
      keyId: String(apiKey.id), keyPrefix: apiKey.keyPrefix, scopes: apiKey.scopes,
      workspaceId: apiKey.workspaceId ? String(apiKey.workspaceId) : null,
      expiresAt: apiKey.expiresAt, revokedAt: apiKey.revokedAt,
    };
    response.locals.apiKeyContext = context;
    const allowed = context.scopes.includes("*") || context.scopes.includes(action);
    await prisma.$transaction(async (transaction) => {
      await transaction.api_keys.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } });
      await emitAuditEvent("auth.key_used", {
        scopedKeyId: context.keyId, keyPrefix: context.keyPrefix, action, allowed, orgId: 1,
      }, null, { resource: { type: "api_key", id: context.keyId }, transaction });
    });
    if (!allowed) return response.status(403).json({ error: "Insufficient scope." });
    next();
  };
  middleware.isApiKeyGuard = true;
  middleware.scope = action;
  return middleware;
}

module.exports = { validApiKey };

const { ApiKey } = require("../../models/apiKeys");
const { SystemSettings } = require("../../models/systemSettings");
const { emitAuditEvent } = require("../events");
const prisma = require("../prisma");


async function workspaceBindingMatches(context, request, binding, db = prisma) {
  if (!context?.workspaceId || !binding) return true;
  if (binding.workspaceParam)
    return context.workspaceId === String(request.params?.[binding.workspaceParam]);
  if (binding.workspaceSlugParam) {
    const workspace = await db.workspaces.findUnique({
      where: { slug: String(request.params?.[binding.workspaceSlugParam]) },
      select: { id: true },
    });
    return !!workspace && context.workspaceId === String(workspace.id);
  }
  return true;
}

function validApiKey(action, binding = null) {
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
    const scopeAllowed = context.scopes.includes("*") || context.scopes.includes(action);
    const workspaceAllowed = await workspaceBindingMatches(context, request, binding);
    const allowed = scopeAllowed && workspaceAllowed;
    await prisma.$transaction(async (transaction) => {
      await transaction.api_keys.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } });
      await emitAuditEvent("auth.key_used", {
        scopedKeyId: context.keyId, keyPrefix: context.keyPrefix, action, allowed, orgId: "default",
      }, null, { resource: { type: "api_key", id: context.keyId }, transaction });
    });
    if (!allowed) return response.status(403).json({ error: "Insufficient scope." });
    next();
  };
  middleware.isApiKeyGuard = true;
  middleware.scope = action;
  return middleware;
}

module.exports = { validApiKey, workspaceBindingMatches };

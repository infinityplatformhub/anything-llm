const { BrowserExtensionApiKey } = require("../../models/browserExtensionApiKey");
const { SystemSettings } = require("../../models/systemSettings");
const { User } = require("../../models/user");
const { emitAuditEvent } = require("../events");
const prisma = require("../prisma");

function validBrowserExtensionApiKey(action) {
  if (typeof action !== "string" || !action) throw new Error("validBrowserExtensionApiKey requires an explicit scope");
  return async function browserKeyRequired(request, response, next) {
    const multiUserMode = await SystemSettings.isMultiUserMode();
    response.locals.multiUserMode = multiUserMode;
    const secret = request.header("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    const apiKey = secret ? await BrowserExtensionApiKey.validate(secret) : null;
    if (!apiKey) return response.status(403).json({ error: "No valid api key found." });
    const user = apiKey.user_id ? await User.get({ id: apiKey.user_id }) : null;
    if (multiUserMode && (!user || user.suspended)) return response.status(403).json({ error: "No valid api key found." });
    response.locals.user = user;
    const context = {
      keyId: String(apiKey.id), keyPrefix: apiKey.keyPrefix, scopes: ["*"],
      workspaceId: null, expiresAt: null, revokedAt: null,
    };
    response.locals.apiKeyContext = context;
    const allowed = context.scopes.includes("*") || context.scopes.includes(action);
    await prisma.$transaction(async (transaction) => {
      await emitAuditEvent("auth.key_used", {
        scopedKeyId: context.keyId, keyPrefix: context.keyPrefix, action, allowed, orgId: "default",
      }, null, { resource: { type: "browser_extension_api_key", id: context.keyId }, transaction });
    });
    if (!allowed) return response.status(403).json({ error: "Insufficient scope." });
    next();
  };
}

module.exports = { validBrowserExtensionApiKey };

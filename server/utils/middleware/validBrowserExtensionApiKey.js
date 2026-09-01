const { BrowserExtensionApiKey } = require("../../models/browserExtensionApiKey");
const { SystemSettings } = require("../../models/systemSettings");
const { User } = require("../../models/user");
const { emitAuditEvent } = require("../events");

async function validBrowserExtensionApiKey(request, response, next) {
  const multiUserMode = await SystemSettings.isMultiUserMode();
  response.locals.multiUserMode = multiUserMode;
  const bearerKey = request.header("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const apiKey = bearerKey ? await BrowserExtensionApiKey.validate(bearerKey) : null;
  if (!apiKey) return response.status(403).json({ error: "No valid API key found." });
  const user = apiKey.user_id ? await User.get({ id: apiKey.user_id }) : null;
  if (multiUserMode && !user) return response.status(403).json({ error: "User not found." });
  if (user?.suspended) return response.status(401).json({ error: "User is suspended from system" });

  response.locals.user = user;
  response.locals.actor = {
    type: "service", id: `browser-key:${apiKey.id}`, orgId: "default",
    workspaceIds: apiKey.workspaceId ? [String(apiKey.workspaceId)] : [], groupIds: [], scopes: apiKey.scopes,
    scopedKeyId: String(apiKey.id), onBehalfOf: user ? { type: "user", id: String(user.id) } : undefined,
  };
  response.locals.apiKey = { id: apiKey.id, keyPrefix: apiKey.keyPrefix, scopes: apiKey.scopes, workspaceId: apiKey.workspaceId };
  await BrowserExtensionApiKey.touch(apiKey.id);
  await emitAuditEvent("browser_extension_api_key_authenticated", { scopedKeyId: apiKey.id, keyPrefix: apiKey.keyPrefix }, null, {
    actor: response.locals.actor, resource: { type: "browser_extension_api_key", id: String(apiKey.id) },
  });
  next();
}

module.exports = { validBrowserExtensionApiKey };

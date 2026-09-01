const { ApiKey } = require("../../models/apiKeys");
const { SystemSettings } = require("../../models/systemSettings");
const { emitAuditEvent } = require("../events");

async function validApiKey(request, response, next) {
  response.locals.multiUserMode = await SystemSettings.isMultiUserMode();
  const auth = request.header("Authorization");
  const bearerKey = auth?.match(/^Bearer\s+(.+)$/i)?.[1];
  const apiKey = bearerKey ? await ApiKey.resolve(bearerKey) : null;
  if (!apiKey) return response.status(403).json({ error: "No valid api key found." });

  const workspaceIds = apiKey.workspaceId ? [String(apiKey.workspaceId)] : [];
  response.locals.actor = {
    type: "service", id: `api-key:${apiKey.id}`, orgId: "default", workspaceIds, groupIds: [],
    scopes: apiKey.scopes, scopedKeyId: String(apiKey.id),
  };
  response.locals.apiKey = { id: apiKey.id, keyPrefix: apiKey.keyPrefix, scopes: apiKey.scopes, workspaceId: apiKey.workspaceId };
  await ApiKey.touch(apiKey.id);
  await emitAuditEvent("api_key_authenticated", { scopedKeyId: apiKey.id, keyPrefix: apiKey.keyPrefix }, null, {
    actor: response.locals.actor, resource: { type: "api_key", id: String(apiKey.id) },
  });
  next();
}

module.exports = { validApiKey };

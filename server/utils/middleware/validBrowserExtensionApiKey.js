const { BrowserExtensionApiKey } = require("../../models/browserExtensionApiKey");
const { SystemSettings } = require("../../models/systemSettings");
const { User } = require("../../models/user");
const { emitAuditEvent } = require("../events");
const { EXTENSION_SCOPES } = require("../apiKeySecurity/scopes");
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
      // PR-4b(3): the extension's grant is fixed in code (EXTENSION_SCOPES), not stored
      // per key. It was a wildcard before, which also reached actorResolver and produced
      // a service Actor holding every scope in the system.
      keyId: String(apiKey.id), keyPrefix: apiKey.keyPrefix, scopes: [...EXTENSION_SCOPES],
      workspaceId: null, expiresAt: null, revokedAt: null,
      // T-4b (#29): this id belongs to `browser_extension_api_keys`, not `api_keys`. The
      // tables have independent id sequences, so the resolver must not look it up there —
      // extension key 7 would inherit API key 7's creator's grants. Tagged rather than
      // inferred, so a future context shape cannot silently land in the wrong branch.
      keyKind: "browser-extension",
    };
    response.locals.apiKeyContext = context;
    response.locals.apiKey = { id: apiKey.id, keyPrefix: apiKey.keyPrefix };
    const allowed = context.scopes.includes(action);
    await prisma.$transaction(async (transaction) => {
      await emitAuditEvent("auth.key_used", {
        scopedKeyId: context.keyId, keyPrefix: context.keyPrefix, action, allowed, orgId: 1,
      }, null, { resource: { type: "browser_extension_api_key", id: context.keyId }, transaction });
    });
    if (!allowed) return response.status(403).json({ error: "Insufficient scope." });
    next();
  };
}

module.exports = { validBrowserExtensionApiKey };

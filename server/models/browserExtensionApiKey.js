const prisma = require("../utils/prisma");
const { ROLES } = require("../utils/middleware/multiUserProtected");
const { digestSecret, keyPrefix, matchesDigest } = require("../utils/apiKeySecurity");

const BrowserExtensionApiKey = {
  /**
   * Creates a new secret for a browser extension API key.
   * @returns {string} apw-brx-*** API key to use with extension
   */
  makeSecret: () => {
    const crypto = require("crypto");
    return `apw-brx-${crypto.randomBytes(32).toString("base64url")}`;
  },

  /**
   * Creates a new api key for the browser Extension
   * @param {number|null} userId - User id to associate creation of key with.
   * @returns {Promise<{apiKey: import("@prisma/client").browser_extension_api_keys|null, error:string|null}>}
   */
  create: async function (userId = null, options = {}) {
    try {
      const secret = this.makeSecret();
      const record = await prisma.browser_extension_api_keys.create({ data: {
        secretDigest: digestSecret(secret), keyPrefix: keyPrefix(secret), user_id: userId,
      } });
      return { apiKey: { ...record, secretDigest: undefined, secret }, error: null };
    } catch (error) {
      console.error("Failed to create browser extension API key", error.message);
      return { apiKey: null, error: error.message };
    }
  },
  validate: async function (secret) {
    if (typeof secret !== "string" || !secret.startsWith("apw-brx-")) return false;
    const record = await prisma.browser_extension_api_keys.findUnique({ where: { secretDigest: digestSecret(secret) }, include: { user: true } });
    if (!record) return false;
    try { if (!matchesDigest(secret, record.secretDigest)) return false; } catch { return false; }
    return record;
  },
  get: (clause = {}) => prisma.browser_extension_api_keys.findFirst({ where: clause }).then((row) => { if (!row) return null; const { secretDigest, ...safe } = row; return safe; }).catch(() => null),
  delete: async (id) => prisma.browser_extension_api_keys.delete({ where: { id: Number(id) } }).then(() => ({ success: true, error: null })).catch((error) => ({ success: false, error: error.message })),
  deleteAllForUser: async function (userId) {
    if (!userId) return { success: false, error: "User ID is required" };
    return prisma.browser_extension_api_keys.deleteMany({ where: { user_id: Number(userId) } })
      .then(() => ({ success: true, error: null })).catch((error) => ({ success: false, error: error.message }));
  },
  where: (clause = {}, limit = null, orderBy = null) => prisma.browser_extension_api_keys.findMany({
    where: clause, ...(limit !== null ? { take: limit } : {}), ...(orderBy ? { orderBy } : {}), include: { user: true },
  }).then((rows) => rows.map(({ secretDigest, ...row }) => row)).catch(() => []),
  whereWithUser: async function (user, clause = {}, limit = null, orderBy = null) {
    if (user.role === ROLES.admin) return this.where(clause, limit, orderBy);
    return this.where({ ...clause, user_id: user.id }, limit, orderBy);
  },
  migrateApiKeysToMultiUser: async (userId) => prisma.browser_extension_api_keys.updateMany({ where: { user_id: null }, data: { user_id: userId } }),
};

module.exports = { BrowserExtensionApiKey };

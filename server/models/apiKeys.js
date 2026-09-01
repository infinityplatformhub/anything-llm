const prisma = require("../utils/prisma");
const {
  digestSecret,
  keyPrefix,
  matchesDigest,
  parseScopes,
} = require("../utils/apiKeySecurity");

const ApiKey = {
  tablename: "api_keys",
  writable: ["name"],
  // 256 bits from crypto.randomBytes (R6/R7 floor); uuid-apikey was 122 bits.
  makeSecret: () => {
    const crypto = require("crypto");
    return `apw-key-${crypto.randomBytes(32).toString("base64url")}`;
  },

  create: async function (createdByUserId = null, name = null, options = {}) {
    try {
      const secret = this.makeSecret();
      const record = await prisma.api_keys.create({
        data: {
          name: typeof name === "string" && name.trim() ? name.trim() : null,
          secretDigest: digestSecret(secret),
          keyPrefix: keyPrefix(secret),
          scopes: JSON.stringify(options.scopes || ["*"]),
          workspaceId: options.workspaceId || null,
          expiresAt: options.expiresAt || null,
          createdBy: createdByUserId,
        },
      });
      return { apiKey: { ...record, secretDigest: undefined, secret }, error: null };
    } catch (error) {
      console.error("FAILED TO CREATE API KEY.", error.message);
      return { apiKey: null, error: error.message };
    }
  },

  resolve: async function (secret) {
    if (typeof secret !== "string" || !secret.startsWith("apw-key-")) return null;
    const record = await prisma.api_keys.findUnique({ where: { secretDigest: digestSecret(secret) } });
    if (!record || record.revokedAt || (record.expiresAt && record.expiresAt <= new Date())) return null;
    try {
      if (!matchesDigest(secret, record.secretDigest)) return null;
    } catch {
      return null;
    }
    return { ...record, scopes: parseScopes(record.scopes) };
  },

  touch: (id) => prisma.api_keys.update({ where: { id }, data: { lastUsedAt: new Date() } }),
  get: (clause = {}) => prisma.api_keys.findFirst({ where: clause }).then((row) => { if (!row) return null; const { secretDigest, ...safe } = row; return safe; }).catch(() => null),
  count: (clause = {}) => prisma.api_keys.count({ where: clause }).catch(() => 0),
  delete: async (clause = {}) => prisma.api_keys.deleteMany({ where: clause }).then(() => true).catch(() => false),
  where: (clause = {}, limit) => prisma.api_keys.findMany({ where: clause, take: limit }).then((rows) => rows.map(({ secretDigest, ...row }) => row)).catch(() => []),
  whereWithUser: async function (clause = {}, limit) {
    const { User } = require("./user");
    const rows = await this.where(clause, limit);
    for (const row of rows) {
      if (!row.createdBy) continue;
      const user = await User.get({ id: row.createdBy });
      if (user) row.createdBy = { id: user.id, username: user.username, role: user.role };
    }
    return rows;
  },
};

module.exports = { ApiKey };

const prisma = require("../utils/prisma");
const {
  digestSecret,
  keyPrefix,
  matchesDigest,
  parseScopes,
} = require("../utils/apiKeySecurity");
const { KNOWN_SCOPES } = require("../utils/apiKeySecurity/scopes");
const {
  applyScopeCeiling,
} = require("../utils/apiKeySecurity/scopeCeiling");

/**
 * @param {string[]} scopes the caller's requested scope list
 * @returns {string[]} the same list, validated
 * @throws when absent, empty, or naming a scope no route asks for
 */
/**
 * Scopes that existed and no longer do, mapped to what replaced them.
 *
 * `Unknown scope(s): chat.read` is true but unhelpful — it reads as a typo, and the
 * caller's next move is to check their spelling rather than to grant the right thing.
 * A name that WAS valid deserves to say so, and to say what took its place.
 */
const RETIRED_SCOPES = Object.freeze({
  "chat.read":
    "chat.read was retired in #64 (/v1 chat listings return every user's chats); use chat.read_others",
});

function validateScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0)
    throw new Error("An API key must be created with an explicit, non-empty scope list.");
  if (scopes.includes("*"))
    throw new Error("The wildcard scope no longer exists; name the scopes the key needs.");
  const retired = scopes.filter((scope) => scope in RETIRED_SCOPES);
  if (retired.length)
    throw new Error(retired.map((scope) => RETIRED_SCOPES[scope]).join("; "));
  const unknown = scopes.filter((scope) => !KNOWN_SCOPES.includes(scope));
  if (unknown.length)
    throw new Error(`Unknown scope(s): ${unknown.join(", ")}`);
  return [...scopes];
}

const ApiKey = {
  tablename: "api_keys",
  writable: ["name"],
  // 256 bits from crypto.randomBytes (R6/R7 floor); uuid-apikey was 122 bits.
  makeSecret: () => {
    const crypto = require("crypto");
    return `apw-key-${crypto.randomBytes(32).toString("base64url")}`;
  },

  // PR-4c: scopes are required. The old fallback minted a wildcard key that
  // satisfied every route no matter how precisely the routes were scoped, and the model
  // always writes the column, so it won even after the schema default changed.
  // PR-4d (#35): the shape check above says the list is well-formed; the ceiling says
  // the creator is allowed to grant it. `trimToCeiling` marks a list the caller never
  // named (an endpoint default) — those narrow, an explicit request refuses.
  create: async function (createdByUserId = null, name = null, options = {}) {
    try {
      const requested = validateScopes(options.scopes);
      const scopes = await applyScopeCeiling({
        creatorId: createdByUserId,
        scopes: requested,
        workspaceId: options.workspaceId || null,
        trimToCeiling: options.trimToCeiling === true,
        db: prisma,
      });
      const secret = this.makeSecret();
      const record = await prisma.api_keys.create({
        data: {
          name: typeof name === "string" && name.trim() ? name.trim() : null,
          secretDigest: digestSecret(secret),
          keyPrefix: keyPrefix(secret),
          scopes: JSON.stringify(scopes),
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

module.exports = { ApiKey, RETIRED_SCOPES };

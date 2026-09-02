// PR-4c: names the API keys that held the wildcard scope when it was retired.
//
// The 045000 migration rewrote those keys to an enumerated legacy set so they keep
// working, but "still works" is exactly why nobody would go looking for them. This
// prints them at boot until an operator narrows or revokes each one and clears the row.

const prisma = require("../prisma");

/**
 * @param {Object} db injectable for tests
 * @returns {Promise<{count:number, prefixes:string[]}>} what was reported
 */
async function reportLegacyWildcardGrants(db = prisma) {
  try {
    const rows = await db.api_key_legacy_wildcard_grants.findMany({
      where: { acknowledged: false },
      select: { api_key_id: true, keyPrefix: true },
    });
    if (rows.length === 0) return { count: 0, prefixes: [] };

    const prefixes = rows.map((row) => row.keyPrefix);
    console.warn(
      `[api-key-scopes] ${rows.length} API key(s) were migrated off the wildcard scope ` +
        `and now hold the full legacy scope set. Narrow or revoke each one, then clear ` +
        `its row in api_key_legacy_wildcard_grants: ${prefixes.join(", ")}`
    );
    return { count: rows.length, prefixes };
  } catch (error) {
    // A boot report must never stop the server booting.
    console.error("[api-key-scopes] could not read legacy wildcard grants:", error.message);
    return { count: 0, prefixes: [] };
  }
}

module.exports = { reportLegacyWildcardGrants };

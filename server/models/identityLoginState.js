// S1 (#36): one in-flight SSO login — state, nonce, PKCE verifier.
//
// State and nonce are single-use (seam 01: "mandatory and single-use"). The row
// is CONSUMED, never deleted on use: a consumed row that still exists is how a
// replay is told apart from an expiry, and those are different incidents. The
// T-6 retention purge is what finally removes them.

const crypto = require("crypto");
const prismaDefault = require("../utils/prisma");
const {
  IdentityAuthenticationError,
} = require("../utils/identityProviders/errors");

// Long enough that a login cannot be completed at leisure, short enough that an
// interrupted one is a fresh start rather than a resumable window.
const TTL_MS = 15 * 60 * 1000;
const TOKEN_BYTES = 32;

const secret = () => crypto.randomBytes(TOKEN_BYTES).toString("base64url");

const IdentityLoginState = {
  TTL_MS,

  /**
   * Start a login: mint state, nonce and a PKCE verifier, and record them.
   *
   * @param {{provider:string, redirectUri:string, db?:Object}} input
   * @returns {Promise<{state:string, nonce:string, codeVerifier:string, expiresAt:Date}>}
   */
  issue: async function ({ provider, redirectUri, db = prismaDefault }) {
    if (!provider || !redirectUri)
      throw new Error("A login state needs a provider and a redirectUri.");

    const state = secret();
    const nonce = secret();
    const codeVerifier = secret();
    const expiresAt = new Date(Date.now() + TTL_MS);

    await db.identity_login_state.create({
      data: { state, nonce, provider, redirectUri, codeVerifier, expiresAt },
    });
    return { state, nonce, codeVerifier, expiresAt };
  },

  /**
   * Spend a state exactly once.
   *
   * The consuming write is a CONDITIONAL update — `consumedAt: null` and an
   * unexpired `expiresAt` are part of the WHERE, not checked beforehand. Reading
   * the row and then updating it would let two concurrent callbacks both pass
   * the check and both log in, which is the whole attack this table prevents.
   *
   * @param {string} state
   * @param {{db?:Object, now?:Date}} options
   * @returns {Promise<{nonce:string, codeVerifier:string, provider:string, redirectUri:string}>}
   */
  consume: async function (state, { db = prismaDefault, now = new Date() } = {}) {
    if (typeof state !== "string" || !state)
      throw new IdentityAuthenticationError("This login could not be verified.");

    const claimed = await db.identity_login_state.updateMany({
      where: { state, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });

    if (claimed.count === 1) {
      const row = await db.identity_login_state.findUnique({ where: { state } });
      return {
        nonce: row.nonce,
        codeVerifier: row.codeVerifier,
        provider: row.provider,
        redirectUri: row.redirectUri,
      };
    }

    // Nothing was claimed. Read the row to say WHY — an operator needs "someone
    // re-sent a used callback" and "this login sat too long" to look different,
    // even though the user-facing outcome is the same refusal.
    const existing = await db.identity_login_state.findUnique({ where: { state } });
    if (!existing)
      throw new IdentityAuthenticationError("This login could not be verified.");
    if (existing.consumedAt)
      throw new IdentityAuthenticationError(
        "This login was already completed (replayed state)."
      );
    throw new IdentityAuthenticationError("This login has expired. Start again.");
  },

  /**
   * Delete rows past their TTL. Called by the T-6 retention job, not by a route.
   *
   * Expiry is the only criterion: a consumed row inside its TTL must stay, or a
   * replay becomes indistinguishable from an expiry the moment the sweep runs.
   *
   * @param {{db?:Object, now?:Date}} options
   * @returns {Promise<number>} rows removed
   */
  purgeExpired: async function ({ db = prismaDefault, now = new Date() } = {}) {
    const { count } = await db.identity_login_state.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return count;
  },
};

module.exports = { IdentityLoginState };

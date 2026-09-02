// S2 (#43): spend a SAML assertion exactly once.
//
// SAML has no PKCE and no nonce. The bearer assertion IS the credential, so a
// captured response is a working login for the whole of its validity window —
// unless the second presentation fails. That refusal is this module.
//
// The claim is an INSERT that relies on the unique constraint, never a lookup
// followed by a write. "Is this recorded? no → record it" loses the race two
// simultaneous presentations create: both read `no`, both proceed, and the
// defence is gone for an attacker who sends the response twice at once.

const prismaDefault = require("../utils/prisma");
const {
  IdentityAuthenticationError,
} = require("../utils/identityProviders/errors");

// Prisma's unique-constraint violation. The ONLY error that means "already
// spent" — anything else is infrastructure trouble and must surface, because
// swallowing it would turn a dead connection into an unlimited replay window.
const UNIQUE_VIOLATION = "P2002";

const AssertionReplay = {
  /**
   * Record an assertion as spent, or refuse it.
   *
   * @param {{provider:string, assertionId:string, expiresAt:Date, db?:Object}} input
   * @returns {Promise<void>} resolves when this is the FIRST presentation
   * @throws {IdentityAuthenticationError} when it has been presented before
   */
  claim: async function ({ provider, assertionId, expiresAt, db = prismaDefault }) {
    if (!provider || !assertionId || !expiresAt)
      throw new IdentityAuthenticationError("This login could not be verified.");

    try {
      await db.identity_assertion_ids.create({
        data: { provider, assertionId, expiresAt },
      });
    } catch (error) {
      if (error?.code !== UNIQUE_VIOLATION) throw error;
      // The message reaches an unauthenticated caller, so it says nothing about
      // the assertion ID or the table — only that this login is not usable.
      throw new IdentityAuthenticationError(
        "This login was already completed (replayed assertion)."
      );
    }
  },

  /**
   * Delete rows past their expiry. Called by the T-6 retention job, not a route.
   *
   * Expiry alone is the criterion. Keeping a row past its assertion's validity
   * window protects nothing — the assertion is refused on its own Conditions by
   * then — while deleting one early reopens the replay this table exists to stop.
   *
   * @param {{db?:Object, now?:Date}} options
   * @returns {Promise<number>} rows removed
   */
  purgeExpired: async function ({ db = prismaDefault, now = new Date() } = {}) {
    const { count } = await db.identity_assertion_ids.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return count;
  },
};

module.exports = { AssertionReplay };

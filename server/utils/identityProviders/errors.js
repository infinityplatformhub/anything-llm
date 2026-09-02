// S1 (#36): the five failure modes seam 01 §"Failure semantics" names.
//
// Core branches on WHICH of these it caught — retry, fail closed, or hand it to
// an admin — so a driver that throws a bare Error collapses three different
// outcomes into one and the caller has to string-match a message to tell them
// apart. `retryable` is a property of the failure, not a caller's guess.

class IdentityError extends Error {
  /** @param {string} message @param {{cause?: unknown}} [options] */
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    // The route returns a generic authentication failure; the cause is for the
    // operator's log, and must not reach the response body.
    if (options.cause !== undefined) this.cause = options.cause;
    Error.captureStackTrace?.(this, new.target);
  }

  /** @returns {boolean} whether retrying the same call could succeed. */
  get retryable() {
    return false;
  }
}

/** Missing/unusable provider configuration or discovery document. Fails closed. */
class IdentityConfigurationError extends IdentityError {}

/**
 * Invalid or replayed state/nonce, bad signature/issuer/audience, or an
 * unverified email the IdP tried to assert. Never retryable: the same input
 * fails the same way, and retrying a replay is the attack running twice.
 */
class IdentityAuthenticationError extends IdentityError {}

/** Provider timeout or outage. The ONLY retryable case — and it creates no local session. */
class IdentityUnavailableError extends IdentityError {
  get retryable() {
    return true;
  }
}

/**
 * The external identity is already linked to a different local user, or its
 * email belongs to an existing account (R1). Requires admin resolution — a
 * retry would just re-attempt the takeover.
 */
class IdentityConflictError extends IdentityError {}

/**
 * An optional method was called on a driver whose capability flag says it is
 * unsupported. Without this the flag is decoration.
 */
class IdentityCapabilityError extends IdentityError {}

module.exports = {
  IdentityError,
  IdentityConfigurationError,
  IdentityAuthenticationError,
  IdentityUnavailableError,
  IdentityConflictError,
  IdentityCapabilityError,
};

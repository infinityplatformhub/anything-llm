// S11a (#80): the four failure modes seam 6 §"Failure semantics" names.
//
// Same reasoning as the identity seam's errors: core branches on WHICH of these
// it caught — retry with backoff, disable the channel, or dead-letter and alert
// — so a driver that throws a bare Error collapses those outcomes into one and
// the caller is left string-matching a message to tell them apart.
//
// `retryable` is a property of the failure, not a caller's guess. Getting it
// wrong in either direction is expensive: retrying a permanent rejection means
// hammering a relay that will never accept, and dead-lettering a transient one
// means an invite that silently never arrives.

class NotificationError extends Error {
  /** @param {string} message @param {{cause?: unknown}} [options] */
  constructor(message, options = {}) {
    super(message);
    this.name = new.target.name;
    // For the operator's log only. Nothing here reaches a recipient, and the
    // cause of an SMTP failure routinely carries the connection details.
    if (options.cause !== undefined) this.cause = options.cause;
    Error.captureStackTrace?.(this, new.target);
  }

  /** @returns {boolean} whether retrying the same send could succeed. */
  get retryable() {
    return false;
  }
}

/**
 * The notification itself is malformed — no recipient, unknown template,
 * unsupported recipient type. Never retryable: the same payload fails the same
 * way, and the queue would spin on it until the attempt limit.
 */
class NotificationContractError extends NotificationError {}

/**
 * Authentication rejected, or the channel is not configured well enough to send
 * at all. Fails closed AND disables the channel: a relay that refuses our
 * credentials will refuse every subsequent message, and retrying a bad password
 * is how an account gets locked.
 */
class NotificationConfigurationError extends NotificationError {}

/**
 * Timeout, connection refused, a 4xx from the relay, or a rate limit. The ONLY
 * retryable case.
 *
 * TL-1 F3: this deliberately carries NO `retryAfterMs`. Seam 6 allows one, and
 * an earlier draft declared the field — but SMTP has no standard way to say
 * "come back in N seconds", so nothing could ever populate it honestly. A
 * declared-but-never-set field is worse than an absent one: `CoreJobWorker`
 * falls back to its own backoff silently, so the value looks respected while
 * being undefined at every call site. A channel that CAN report a retry delay
 * (an HTTP webhook reading `Retry-After`) should add it there, where something
 * real fills it in.
 */
class NotificationUnavailableError extends NotificationError {
  get retryable() {
    return true;
  }
}

/**
 * The relay permanently refused this message — 5xx, mailbox does not exist,
 * message rejected. Distinct from Unavailable because retrying cannot help, and
 * distinct from Contract because nothing about OUR payload was wrong: the
 * failure is a fact about the recipient, and core emits a delivery-failed event
 * rather than treating it as a bug.
 */
class NotificationRejectedError extends NotificationError {}

module.exports = {
  NotificationError,
  NotificationContractError,
  NotificationConfigurationError,
  NotificationUnavailableError,
  NotificationRejectedError,
};

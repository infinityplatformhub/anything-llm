// S11a (#80): the SMTP notification driver — seam 6's first driver.
//
// What this file is careful about, in order of how badly it goes wrong:
//
//   1. THE PASSWORD NEVER LEAVES THE TRANSPORT. QA-3 measured that an SMTP
//      password matches no redaction pattern — `Sup3rSecret!Mail#2026` and a
//      Google app password both scored zero hits — so nothing downstream will
//      catch one that escapes. It cannot be logged, cannot appear in an error
//      message, and cannot be handed to `emitAuditEvent`. That is a structural
//      rule here, not a habit: the audit sink is not a safety net for it.
//
//      For the same reason the connection is described by SEPARATE FIELDS —
//      host, port, secure, username — and never a URL. `smtps://user:pass@smtp`
//      would carry the credential as one string, and QA-3 showed a dotless host
//      makes even the accidental email-pattern match miss it. A shape that
//      cannot hold a credential cannot leak one.
//
//   2. NO BODIES, TOKENS OR INVITE LINKS IN LOGS (seam 6 §Boundaries). A relay
//      rejection is exactly where a driver is tempted to print the message it
//      could not send.
//
//   3. FAILURES ARE CLASSIFIED BY WHAT THE CALLER MUST DO, not by what went
//      wrong. Core retries `Unavailable`, disables the channel on
//      `Configuration`, and dead-letters `Rejected`; collapsing those into one
//      error means retrying a locked account or dropping a transient blip.
//
// This driver decides NO policy: not who the recipient is, not whether the event
// was notifiable, not what the message says. It is handed a finished
// notification and puts it on the wire.

const {
  NotificationContractError,
  NotificationConfigurationError,
  NotificationUnavailableError,
  NotificationRejectedError,
} = require("./errors");

/**
 * Deliberately strict, and deliberately not RFC 5322. This rejects input that is
 * obviously not an address so a typo fails at the ingress with a message an
 * operator can act on, rather than as a relay rejection minutes later inside a
 * queue. Anything that gets past this is the relay's judgement to make.
 */
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

class SmtpNotificationDriver {
  /** @returns {string} */
  static channelId() {
    return "smtp";
  }

  constructor(config = {}) {
    this.host = config.host;
    this.port = config.port;
    this.secure = config.secure === true;
    // TL-1 F1: TWO consents, because they are two different risks and an
    // operator may hold one without the other.
    //
    //   allowInsecureTransport — "send over an unencrypted connection". About
    //     confidentiality on the wire.
    //   allowUntrustedCertificate — "do not verify who the far end is". About
    //     authenticating the peer, and it matters MOST when the connection is
    //     encrypted, since the certificate is then the only thing identifying it.
    //
    // They were one flag, so accepting plaintext on a trusted LAN silently also
    // turned off certificate validation for every TLS connection this driver
    // made. `allowInsecure` is still read for compatibility with the older
    // spelling, but only for the transport half.
    this.allowInsecureTransport =
      config.allowInsecureTransport === true || config.allowInsecure === true;
    this.allowUntrustedCertificate = config.allowUntrustedCertificate === true;
    this.username = config.username;
    // Held only to hand to the transport. Never read anywhere else in this file,
    // and never interpolated into a string.
    this.password = config.password;
    this.fromAddress = config.fromAddress;
    this.fromName = config.fromName;
    this.connectionTimeoutMs =
      config.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    /**
     * notificationId → { deliveryId, acceptedAt }.
     *
     * TL-1 F2: keyed by NOTIFICATION, not delivery, because that is what makes
     * it an idempotency key. `event_deliveries` retries on its own schedule, so
     * without this a transient failure that actually reached the relay becomes a
     * second invitation email to a real person.
     *
     * TL-1 NIT-3: bounded. It is fed by a queue, so an unbounded map is a slow
     * leak; entries also expire, because idempotency only needs to span a retry
     * window, not the life of the process.
     */
    this._accepted = new Map();
    this._idempotencyTtlMs = config.idempotencyTtlMs ?? 24 * 60 * 60 * 1000;
    this._idempotencyMaxEntries = config.idempotencyMaxEntries ?? 10_000;
  }

  /**
   * QA-1 NIT-2: what this object looks like when something prints it.
   *
   * Measured before this existed: `JSON.stringify(driver)` and
   * `util.inspect(driver)` both returned the password in full. The second is
   * what `console.log(driver)` calls, so one debugging line — here, or inside a
   * dependency that logs the objects it is handed — publishes the credential.
   *
   * Both hooks are needed and neither substitutes for the other: `toJSON` covers
   * serialization, the inspect symbol covers logging, and node's error printing
   * walks `cause` chains with the latter. The safe shape is an allowlist, so a
   * field added to the constructor later is invisible here until someone
   * deliberately adds it.
   */
  toJSON() {
    return {
      channel: SmtpNotificationDriver.channelId(),
      host: this.host,
      port: this.port,
      secure: this.secure,
      username: this.username,
    };
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return { ...this.toJSON(), password: "[redacted]" };
  }

  /**
   * Ask the relay whether this configuration works, and answer with DATA.
   *
   * A connection test that throws makes the caller catch to learn the answer.
   * This is a question an admin asked; the answer belongs in a return value.
   * `details` reaches a settings screen, so it carries no credential.
   */
  static async validateConnection(config = {}) {
    const driver = new SmtpNotificationDriver(config);
    try {
      driver._assertTransportAllowed();
      const transport = driver._transport();
      await transport.verify();
      return { ok: true, details: { host: driver.host, port: driver.port } };
    } catch (error) {
      return {
        ok: false,
        details: {
          host: driver.host,
          port: driver.port,
          // The CLASS of failure, never the transport's raw message: relay
          // errors quote the command that failed, and AUTH is a command.
          reason: driver._classify(error).name,
        },
      };
    }
  }

  /**
   * @param {Object} notification
   * @returns {Promise<{deliveryId: string, acceptedAt: Date}>}
   */
  async send(notification) {
    const to = this._recipientAddress(notification);
    this._assertTransportAllowed();

    // TL-1 F2: idempotency, BEFORE anything is sent. The queue retries on its
    // own schedule, and a retry of a send that actually reached the relay is a
    // second invitation email to a real person.
    const key = notification?.notificationId;
    const previous = key ? this._rememberedDelivery(key) : null;
    if (previous) return { ...previous };

    try {
      const info = await this._transport().sendMail({
        from: this._header(
          this.fromName
            ? `${this._header(this.fromName)} <${this.fromAddress}>`
            : this.fromAddress
        ),
        to,
        subject: this._header(
          notification?.subject ?? "You have been invited"
        ),
        text: notification?.text ?? "",
        html: notification?.html,
      });

      // The relay's own id where it gave one. Used for idempotency and for
      // correlating a log line with a message — NOT for querying state later;
      // SMTP has no such query, which is what `status()` is honest about.
      const deliveryId = info?.messageId || `smtp-${key ?? "unkeyed"}`;
      const acceptedAt = new Date();
      // Only a SUCCESSFUL send is remembered. Recording a failure here would
      // turn one transient outage into permanent silence — the retry is the
      // reason the queue exists.
      if (key) this._rememberDelivery(key, { deliveryId, acceptedAt });
      return { deliveryId, acceptedAt };
    } catch (error) {
      throw this._classify(error);
    }
  }

  /**
   * @param {{deliveryId: string}} input
   * @returns {Promise<{status: "queued"|"failed"|"unknown", occurredAt: Date|null}>}
   *
   * NEVER returns "delivered", and cannot be made to. SMTP's 250 says the next
   * hop accepted the message; what happens after that — forwarding, greylisting,
   * a bounce two hops away — is invisible here. Reporting "delivered" would be
   * trusted by an operator while mail silently fails downstream, which is worse
   * than admitting the protocol does not know.
   */
  async status({ deliveryId } = {}) {
    if (!deliveryId) return { status: "unknown", occurredAt: null };
    // The map is keyed by notificationId, because THAT is the idempotency key
    // (TL-1 F2). A caller holds a deliveryId from a previous `send`, so this
    // scans rather than re-keying the map and losing the deduplication it
    // provides. The map is bounded, so the scan is bounded with it.
    for (const entry of this._accepted.values())
      if (entry.deliveryId === deliveryId)
        return { status: "queued", occurredAt: entry.acceptedAt };
    return { status: "unknown", occurredAt: null };
  }

  /**
   * TL-1 NIT-2: strip CR and LF from anything that becomes a header.
   *
   * `fromName` is an admin-editable setting and `subject` comes from the
   * template lane, so both are attacker-adjacent text reaching a header. A bare
   * CRLF is how `Bcc:` gets appended to somebody else's message. Stripped rather
   * than rejected: a stray newline in a display name is a typo, and failing an
   * invitation over it helps nobody.
   */
  _header(value) {
    return String(value ?? "").replace(/[\r\n]+/g, " ");
  }

  /** A remembered delivery, if it has not aged out. */
  _rememberedDelivery(notificationId) {
    const entry = this._accepted.get(notificationId);
    if (!entry) return null;
    if (Date.now() - entry.acceptedAt.getTime() > this._idempotencyTtlMs) {
      this._accepted.delete(notificationId);
      return null;
    }
    return entry;
  }

  _rememberDelivery(notificationId, entry) {
    // TL-1 NIT-3: bounded. Insertion order is age order, so the oldest key is
    // the first one — dropping it is dropping the least useful entry.
    if (this._accepted.size >= this._idempotencyMaxEntries) {
      const oldest = this._accepted.keys().next().value;
      if (oldest !== undefined) this._accepted.delete(oldest);
    }
    this._accepted.set(notificationId, entry);
  }

  /** Resolve and validate the recipient, before anything is connected. */
  _recipientAddress(notification) {
    const recipient = notification?.recipient;
    if (!recipient || typeof recipient !== "object")
      throw new NotificationContractError("A notification needs a recipient.");

    // `users` has no verified email column, so an id cannot become an address
    // here. Seam 6 forbids the driver reading app models to find one, and
    // guessing would mail a stranger. Refusing is the honest answer until the
    // separate users.email work lands.
    if (recipient.type !== "address")
      throw new NotificationContractError(
        `This channel can only send to an address; got "${recipient.type}".`
      );

    const address = String(recipient.id ?? "").trim();
    if (!ADDRESS.test(address))
      throw new NotificationContractError(
        "The recipient address is not a valid email address."
      );
    return address;
  }

  /**
   * Ruling 3, carried from S3: plaintext is REFUSED unless an operator has
   * explicitly accepted it. A warning refuses nothing, and the credential
   * crosses the wire either way.
   */
  _assertTransportAllowed() {
    if (this.secure || this.allowInsecureTransport) return;
    throw new NotificationConfigurationError(
      "Refusing to send over an unencrypted SMTP connection. Use TLS, or " +
        "explicitly allow insecure transport if the link is already inside a " +
        "trusted network."
    );
  }

  /**
   * The options handed to the transport. Public so a test can assert the TLS
   * decision WITHOUT needing a certificate authority to stage a real untrusted
   * peer — the decision is the property under test, and it is made here.
   */
  transportOptions() {
    return {
      host: this.host,
      port: this.port,
      secure: this.secure,
      auth:
        this.username || this.password
          ? { user: this.username, pass: this.password }
          : undefined,
      connectionTimeout: this.connectionTimeoutMs,
      greetingTimeout: this.connectionTimeoutMs,
      socketTimeout: this.connectionTimeoutMs,
      // TL-1 F1: ONLY the certificate consent reaches this. Accepting plaintext
      // says nothing about whether we should believe who answered.
      tls: this.allowUntrustedCertificate
        ? { rejectUnauthorized: false }
        : undefined,
    };
  }

  _transport() {
    if (this._cachedTransport) return this._cachedTransport;
    const nodemailer = require("nodemailer");
    this._cachedTransport = nodemailer.createTransport(this.transportOptions());
    return this._cachedTransport;
  }

  /**
   * Map a transport failure onto the class that says what the caller should do.
   *
   * The error's own message is NOT propagated: nodemailer quotes the failing
   * command, and for an auth failure that command contains the credential.
   * `cause` keeps the original for an operator's log, where the identity seam
   * puts it for the same reason.
   */
  _classify(error) {
    if (error instanceof NotificationContractError) return error;
    if (error instanceof NotificationConfigurationError) return error;

    const code = String(error?.code ?? "");
    const responseCode = Number(error?.responseCode);

    // Authentication rejected, or the relay demanded auth we did not satisfy.
    // Not retryable: the same credential fails the same way, and repeating it is
    // how a relay account gets locked.
    if (code === "EAUTH" || responseCode === 535 || responseCode === 530)
      return new NotificationConfigurationError(
        "The mail server rejected these credentials.",
        { cause: error }
      );

    // 4xx: the relay is asking us to come back. The only retryable class.
    if (responseCode >= 400 && responseCode < 500)
      return new NotificationUnavailableError(
        "The mail server temporarily refused the message.",
        { cause: error }
      );

    // 5xx: a permanent statement about this message or recipient. Retrying
    // cannot change it, and core emits a delivery-failed event instead.
    if (responseCode >= 500)
      return new NotificationRejectedError(
        "The mail server permanently rejected the message.",
        { cause: error }
      );

    // No response at all — refused, timed out, DNS, or the socket died. An
    // outage, so retryable; reporting it as a bad payload would send an operator
    // hunting through templates while the relay is simply down.
    return new NotificationUnavailableError(
      "The mail server could not be reached.",
      { cause: error }
    );
  }
}

module.exports = { SmtpNotificationDriver };

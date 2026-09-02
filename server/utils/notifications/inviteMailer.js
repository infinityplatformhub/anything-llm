// S11a (#80): sending an invite by mail — the step between "an invite exists"
// and "a person was told about it".
//
// This is core, not the driver. It decides WHO may send, whether the channel is
// usable at all, and what the message says; the driver only puts it on the wire.
// Seam 6 draws that line deliberately — a driver that resolved recipients or
// read app models would have to be trusted with policy it cannot see.

const { SmtpNotificationDriver } = require("./SmtpNotificationDriver");
const mailerSettings = require("./mailerSettings");

/**
 * Deliberately strict, and matching the driver's own check. Applied at the
 * INGRESS so a typo is refused with something an operator can act on, rather
 * than surfacing later as a relay rejection inside a queue.
 */
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class InviteMailError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status = 400) {
    super(message);
    this.name = "InviteMailError";
    this.status = status;
  }
}

/**
 * Validate the requested recipient, before anything is created.
 *
 * Ruling D: exactly ONE address per request. A list turns an invite endpoint
 * into a bulk mailer, which is the shape abuse takes — and the UI has no need
 * for it, since an admin inviting five people is five deliberate acts.
 *
 * @returns {string|null} the address, or null when this is a copy-link invite.
 */
function requestedAddress(body = {}) {
  const raw = body?.email;
  if (raw === undefined || raw === null || raw === "") return null;
  if (Array.isArray(raw))
    throw new InviteMailError("Send one invitation at a time.", 400);
  if (typeof raw !== "string")
    throw new InviteMailError("The email address is not valid.", 400);

  const address = raw.trim();
  if (!address) return null;
  if (!ADDRESS.test(address))
    throw new InviteMailError("The email address is not valid.", 400);
  return address;
}

/**
 * Is the channel actually usable right now?
 *
 * Ruling D: when it is not, an address in the request is a 4xx — never a silent
 * 200. The failure this prevents is an admin typing an address, seeing success,
 * and assuming somebody was invited when nothing was sent and nobody is coming.
 */
async function assertChannelReady() {
  const settings = await mailerSettings.readSettings();
  const password = process.env[mailerSettings.PASSWORD_ENV_KEY];
  if (!settings.smtp_host)
    throw new InviteMailError(
      "Email delivery is not configured, so this invite cannot be sent. Create it without an address and share the link yourself.",
      409
    );
  // The save gate, enforced at SEND time as well as at save time. Settings can
  // be written by another path, and "verified" is a claim about a configuration
  // that actually sent something — checking it only on save would let an
  // unverified configuration through the moment anything else wrote a row.
  if (!(await mailerSettings.isVerified(password)))
    throw new InviteMailError(
      "Email delivery has not been verified since it was last changed. Send a test message from the email settings page first.",
      409
    );
}

/** Build the driver from stored settings. Never from request input. */
async function driverFromSettings() {
  const settings = await mailerSettings.readSettings();
  return new SmtpNotificationDriver({
    host: settings.smtp_host,
    port: Number(settings.smtp_port) || 587,
    secure: settings.smtp_secure === "true",
    // TL-1 F1/OBS-1: each setting feeds exactly one consent. Accepting plaintext
    // on a trusted network says nothing about whether an encrypted peer should
    // be believed, so `smtp_allow_insecure` must never reach the TLS decision.
    allowInsecureTransport: settings.smtp_allow_insecure === "true",
    allowUntrustedCertificate: settings.smtp_allow_untrusted_cert === "true",
    username: settings.smtp_username,
    password: process.env[mailerSettings.PASSWORD_ENV_KEY],
    fromAddress: settings.smtp_from_address,
    fromName: settings.smtp_from_name,
  });
}

/**
 * Mail one invite.
 *
 * The link is built HERE and passed as finished text — the driver renders
 * nothing (TL-1 NIT-1), and the code never reaches a log on the way (#71).
 */
async function sendInvite({ invite, address, appUrl }) {
  await assertChannelReady();
  const driver = await driverFromSettings();
  const base = String(appUrl || "").replace(/\/+$/, "");
  const link = `${base}/accept-invite/${invite.code}`;

  return driver.send({
    // Seam 6: the idempotency key is the event and the recipient together, so a
    // retry cannot double-send and two recipients of one event still both get a
    // message.
    notificationId: `invite:${invite.id}:${address}`,
    templateId: "invite",
    recipient: { type: "address", id: address },
    locale: "en",
    subject: "You have been invited",
    text: `You have been invited to join. Use this link to create your account:\n\n${link}\n`,
    severity: "info",
  });
}

module.exports = {
  InviteMailError,
  requestedAddress,
  assertChannelReady,
  sendInvite,
};

// S11a (#80): the mailer settings routes.
//
// Two endpoints and one rule between them: SAVING requires a successful TEST
// bound to the exact configuration being saved. The wizard shows that rule; this
// is where it is true, because the endpoint is reachable without the page and a
// client-side gate protects nobody.
//
// Behind `system.write` rather than `settings.write` (ruling A). These carry a
// relay credential and open an outbound connection to a host the caller names —
// closer to changing how the instance runs than to editing a preference.

const {
  SmtpNotificationDriver,
} = require("../utils/notifications/SmtpNotificationDriver");
const mailerSettings = require("../utils/notifications/mailerSettings");
const { SystemSettings } = require("../models/systemSettings");
const { reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { requirePermission } = require("../utils/middleware/requirePermission");
const { orgResource } = require("../utils/middleware/resourceResolvers");
const { mailerTestRateLimit } = require("../utils/middleware/requestControls");

/** Pull only the known settings out of a request body. */
function settingsFrom(body = {}) {
  const settings = {};
  for (const key of mailerSettings.SETTING_KEYS)
    settings[key] = body?.[key] === undefined ? "" : String(body[key]);
  return settings;
}

/** A driver for one candidate configuration, never from stored state. */
function driverFor(settings, password) {
  return new SmtpNotificationDriver({
    host: settings.smtp_host,
    port: Number(settings.smtp_port) || 587,
    secure: settings.smtp_secure === "true",
    // Each consent feeds exactly one option (TL-1 F1/OBS-1).
    allowInsecureTransport: settings.smtp_allow_insecure === "true",
    allowUntrustedCertificate: settings.smtp_allow_untrusted_cert === "true",
    username: settings.smtp_username,
    password,
    fromAddress: settings.smtp_from_address,
    fromName: settings.smtp_from_name,
  });
}

function mailerEndpoints(app) {
  if (!app) return;

  app.get(
    "/mailer/settings",
    [validatedRequest, requirePermission("system.write", orgResource)],
    async (_request, response) => {
      try {
        const settings = await mailerSettings.readSettings();
        const password = process.env[mailerSettings.PASSWORD_ENV_KEY];
        // The password itself is NEVER returned — the settings page renders a
        // form, and a password rendered into a form is a password in the page
        // source, in the browser cache, and in any screenshot of it. Whether one
        // is set is a different question, and the admin does need that answer.
        response.status(200).json({
          settings: {
            ...settings,
            hasPassword: Boolean(password),
          },
          verified: await mailerSettings.isVerified(password),
        });
      } catch (e) {
        console.error(e.message);
        response.sendStatus(500).end();
      }
    }
  );

  // Rate limited per credential: this opens a socket to an arbitrary host and
  // port the caller supplies, which is a port scanner if left unmetered.
  app.post(
    "/mailer/test",
    [
      validatedRequest,
      requirePermission("system.write", orgResource),
      mailerTestRateLimit,
    ],
    async (request, response) => {
      try {
        const body = reqBody(request);
        const settings = settingsFrom(body);
        const password = String(body?.password ?? "");
        const to = String(body?.to ?? "").trim();
        if (!to)
          return response
            .status(400)
            .json({ ok: false, error: "A test address is required." });

        const driver = driverFor(settings, password);
        await driver.send({
          notificationId: `mailer-test:${Date.now()}`,
          templateId: "test",
          recipient: { type: "address", id: to },
          locale: "en",
          subject: "Test message",
          text: "This is a test message confirming email delivery works.",
          severity: "info",
        });

        // The proof, written only now: a hash over the configuration that just
        // sent something. Any later edit to a connection field — or a rotated
        // password — stops matching, so the proof expires by construction rather
        // than by anyone remembering to clear a flag.
        await SystemSettings.updateSettings({
          [mailerSettings.VERIFIED_HASH_KEY]: mailerSettings.configHash(
            settings,
            password
          ),
        });

        response.status(200).json({ ok: true, error: null });
      } catch (e) {
        // The class of failure, never the transport's own message: it quotes the
        // failing command, and for an auth failure that command carries the
        // credential.
        console.error("[mailer] test failed:", e.name);
        response
          .status(400)
          .json({
            ok: false,
            error: "The mail server could not be reached with these settings.",
          });
      }
    }
  );

  app.post(
    "/mailer/settings",
    [validatedRequest, requirePermission("system.write", orgResource)],
    async (request, response) => {
      try {
        const body = reqBody(request);
        const settings = settingsFrom(body);
        const password = String(body?.password ?? "");

        // Ruling B: REFUSE BEFORE WRITING EITHER TABLE. A configuration that was
        // never proven to work would otherwise be saved and reported as fine,
        // and the first thing to notice would be an invitation nobody received.
        const expected = mailerSettings.configHash(settings, password);
        const stored = await SystemSettings.get({
          label: mailerSettings.VERIFIED_HASH_KEY,
        });
        if (stored?.value !== expected)
          return response.status(409).json({
            saved: false,
            error:
              "Send a test message with these exact settings before saving them.",
          });

        // The credential first, and the settings only if it persisted. TL-1: a
        // verified marker written against a credential the next boot cannot find
        // would claim a working configuration while every send failed.
        const { persistCredential } = require("../utils/helpers/updateENV");
        const { error: persistError } = await persistCredential(
          mailerSettings.PASSWORD_ENV_KEY,
          password
        );
        if (persistError)
          return response.status(500).json({
            saved: false,
            error: "The password could not be stored. Nothing was saved.",
          });
        process.env[mailerSettings.PASSWORD_ENV_KEY] = password;

        await SystemSettings.updateSettings(settings);
        response.status(200).json({ saved: true, error: null });
      } catch (e) {
        console.error("[mailer] save failed:", e.message);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = { mailerEndpoints };

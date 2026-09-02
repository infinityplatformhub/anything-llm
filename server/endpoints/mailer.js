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
//
// TL-1 follow-up (2): the gate binds a CONFIGURATION, not an ACTOR. One admin
// may test and another may save, and that is intended — the question the gate
// answers is "were these exact settings proven to work", which is a fact about
// the settings and not about who established it. Binding it to a session would
// also make it useless across a page reload, and tempting to work around.

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

        // TL-1 follow-up (3): the body is FIXED, deliberately. The caller
        // supplies a destination and nothing else — no subject, no text. This
        // endpoint authenticates with the deployment's own relay credentials and
        // sends from its own domain, so a caller-controlled body would make it a
        // free mailer wearing this instance's reputation.
        //
        // `notificationId` carries a timestamp rather than a stable key because
        // repeat tests are the POINT here: an operator retrying after fixing a
        // setting must actually send again, not receive a deduplicated no-op.
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
        // #65 sweep: `updateSettings` REPORTS failure rather than throwing, so
        // discarding its return silently drops the write. That matters more here
        // than for most settings — the hash is the record that this
        // configuration was proven to work, and a save that quietly failed to
        // write it leaves the operator believing a test they watched succeed was
        // remembered.
        const recorded = await SystemSettings._updateSettings({
          [mailerSettings.VERIFIED_HASH_KEY]: mailerSettings.configHash(
            settings,
            password
          ),
        });
        // ALWAYS 500, never 400. `unknown_keys` and `protected_keys` are
        // unreachable here by construction — every label written comes from
        // SETTING_KEYS, which is exactly what `supportedFields` contains — so any
        // failure is OUR write failing, and a 4xx would blame the caller for a
        // bug no change to their request could fix (#78's dead-branch note).
        //
        // The message says what actually happened: the mail WAS sent, so an
        // operator who watched it arrive is not told it failed, but the proof the
        // save gate looks for is missing. Silence here strands them in a 409 loop
        // — save refusing for want of a hash a successful test never wrote.
        if (recorded?.error)
          return response.status(500).json({
            ok: false,
            error:
              "The test message was sent, but this configuration could not be recorded as verified. Send another test before saving.",
          });

        response.status(200).json({ ok: true, error: null });
      } catch (e) {
        // The class of failure, never the transport's own message: it quotes the
        // failing command, and for an auth failure that command carries the
        // credential.
        console.error("[mailer] test failed:", e.name);
        response.status(400).json({
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

        const written = await SystemSettings.updateSettings(settings);
        // Same reasoning: 500, because every label here is in `supportedFields`.
        //
        // And the message names the SPLIT STATE, because there is one. The
        // credential was persisted and is live in this process, while the
        // settings it belongs to were not saved — so the stored hash no longer
        // matches, and after a restart the mailer would fail every send with
        // nothing on screen explaining why. No rollback: nothing spans
        // `credential_store` and `system_settings` transactionally, which is a
        // recorded residual risk rather than something to paper over here.
        if (written?.error)
          return response.status(500).json({
            saved: false,
            error:
              "The password was stored but the settings could not be saved, so email delivery is not configured. Try saving again.",
          });

        response.status(200).json({ saved: true, error: null });
      } catch (e) {
        console.error("[mailer] save failed:", e.message);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = { mailerEndpoints };

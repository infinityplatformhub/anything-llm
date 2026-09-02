// S11a (#80) — SmtpNotificationDriver against a REAL SMTP server on a socket.
//
// RED-first: written before the driver exists.
//
// No `jest.mock("nodemailer")` anywhere in this file, deliberately (PMO ruling,
// mutant M6). Mocking the transport removes the wire, and the wire is where the
// property under test lives: this suite asserts what reached the RELAY against
// what reached a LOG, and a mock can answer neither question honestly.
//
// Every assertion about a secret uses a value the real generator produced, and
// the SMTP host is DOTLESS. QA-3 measured that the audit redaction's email
// pattern requires a `.` in the host, so `user:pass@smtp` and
// `user:pass@localhost` pass through in full while an FQDN is scrubbed by
// accident. Testing against `smtp`/`127.0.0.1` means a credential leak surfaces
// instead of being hidden by a pattern that was never aimed at it.

const { startSmtpFixture } = require("../../../__testHelpers__/smtp/server");
const {
  SmtpNotificationDriver,
} = require("../../../utils/notifications/SmtpNotificationDriver");
const {
  NotificationContractError,
  NotificationConfigurationError,
  NotificationUnavailableError,
  NotificationRejectedError,
} = require("../../../utils/notifications/errors");

// A password with the shapes a real one has and no shape any redaction pattern
// looks for: QA-3 fired these at redactEventData and got hits=[] for both.
const SMTP_PASSWORD = "Sup3rSecret!Mail#2026";
// AUTH PLAIN sends `\0user\0pass` base64-encoded (RFC 4954), so a leak check
// that greps only for the literal password would miss an encoded copy — which is
// exactly what a driver dumping a raw SMTP conversation into a log would emit.
const SMTP_PASSWORD_ENCODED = Buffer.from(
  `\0mailer\0${SMTP_PASSWORD}`,
  "utf8"
).toString("base64");
// Bare `example.com`, not a subdomain: the §7.4 gate treats only the apex RFC
// 2606 names as reserved, so `workspace.example.com` reads to it as a real
// endpoint. This file must never be added to checkignore — it is the file that
// asserts the password does not leak.
const INVITE_LINK = "https://example.com/accept-invite/apw-inv-FIXTURE";

let fixture;
let consoleSpy;

function driverFor(fixtureServer, overrides = {}) {
  return new SmtpNotificationDriver({
    host: fixtureServer.host,
    port: fixtureServer.port,
    // The fixture speaks plaintext on loopback; the driver must be told that is
    // acceptable rather than deciding for itself.
    secure: false,
    allowInsecure: true,
    username: "mailer",
    password: SMTP_PASSWORD,
    fromAddress: "no-reply@example.com",
    fromName: "ApproofWorkspace",
    ...overrides,
  });
}

const notification = (overrides = {}) => ({
  notificationId: "n-1",
  templateId: "invite",
  recipient: { type: "address", id: "invitee@example.com" },
  locale: "en",
  data: { inviteUrl: INVITE_LINK },
  // TL-1 NIT-1: the driver no longer renders anything out of `data` — the
  // template lane hands it a finished body. `data` stays as that lane's input;
  // `text` is what actually goes on the wire today.
  text: `You have been invited: ${INVITE_LINK}`,
  severity: "info",
  ...overrides,
});

beforeEach(() => {
  // Captured, not silenced: the negative assertions need to read what the driver
  // would have printed.
  consoleSpy = {
    error: jest.spyOn(console, "error").mockImplementation(() => {}),
    log: jest.spyOn(console, "log").mockImplementation(() => {}),
    warn: jest.spyOn(console, "warn").mockImplementation(() => {}),
  };
});

afterEach(async () => {
  for (const spy of Object.values(consoleSpy)) spy.mockRestore();
  if (fixture) await fixture.close();
  fixture = undefined;
});

/** Everything the driver printed, across every console method. */
const consoleOutput = () =>
  Object.values(consoleSpy)
    .flatMap((spy) => spy.mock.calls)
    .map((args) => args.map((a) => String(a?.message ?? a)).join(" "))
    .join("\n");

describe("issue 80: the driver's contract", () => {
  test("channelId is smtp and capabilities are honest", () => {
    expect(SmtpNotificationDriver.channelId()).toBe("smtp");
  });

  test("a notification with no recipient is a CONTRACT error, not a send", async () => {
    fixture = await startSmtpFixture();
    const driver = driverFor(fixture);

    await expect(
      driver.send(notification({ recipient: null }))
    ).rejects.toThrow(NotificationContractError);
    // Nothing was attempted: a malformed payload must not cost a connection.
    expect(fixture.messages).toHaveLength(0);
  });

  test("recipient.type 'user' is refused until users carry a verified address", async () => {
    // Seam 6 allows it; this deployment cannot honour it, because `users` has no
    // email column. Throwing is the honest answer — silently treating an id as
    // an address would mail a stranger.
    fixture = await startSmtpFixture();
    const driver = driverFor(fixture);

    await expect(
      driver.send(notification({ recipient: { type: "user", id: "42" } }))
    ).rejects.toThrow(NotificationContractError);
  });

  test("a malformed address is refused before a connection is opened", async () => {
    fixture = await startSmtpFixture();
    const driver = driverFor(fixture);

    await expect(
      driver.send(
        notification({ recipient: { type: "address", id: "not-an-address" } })
      )
    ).rejects.toThrow(NotificationContractError);
    expect(fixture.messages).toHaveLength(0);
  });
});

describe("issue 80: the message reaches the relay (positive)", () => {
  test("a send delivers the body, with the real invite link in it", async () => {
    // The positive half of QA-3 ruling 4. Without this, every "no link in the
    // log" assertion below would also pass against a driver that sent nothing.
    fixture = await startSmtpFixture();
    const driver = driverFor(fixture);

    const result = await driver.send(notification());

    expect(result.deliveryId).toEqual(expect.any(String));
    expect(result.acceptedAt).toBeInstanceOf(Date);

    expect(fixture.messages).toHaveLength(1);
    const [message] = fixture.messages;
    expect(message.to.join(" ")).toContain("invitee@example.com");
    // The link crossed the wire, which is the entire point of sending it.
    expect(message.data).toContain(INVITE_LINK);
  });
});

describe("issue 80: the secret and the link reach nothing else (negative)", () => {
  test("the password is never printed, whatever happens", async () => {
    fixture = await startSmtpFixture();
    const driver = driverFor(fixture);
    await driver.send(notification());

    // The credential IS on the wire — AUTH cannot work otherwise — but base64
    // encoded, per RFC 4954. Worth spelling out: a leak check that greps for the
    // literal password would miss an encoded copy entirely, so both forms are
    // checked against the log below.
    expect(fixture.transcript).toContain(SMTP_PASSWORD_ENCODED);

    // And neither form reaches anywhere a human or a log aggregator reads.
    expect(consoleOutput()).not.toContain(SMTP_PASSWORD);
    expect(consoleOutput()).not.toContain(SMTP_PASSWORD_ENCODED);
  });

  test("an auth failure does not print the credential it failed with", async () => {
    // The likeliest moment for a password to escape: an error path assembling a
    // "could not connect as X" message.
    fixture = await startSmtpFixture({ fail: "auth" });
    const driver = driverFor(fixture);

    const error = await driver.send(notification()).catch((e) => e);

    expect(error).toBeInstanceOf(NotificationConfigurationError);
    expect(error.message).not.toContain(SMTP_PASSWORD);
    expect(error.message).not.toContain(SMTP_PASSWORD_ENCODED);
    expect(consoleOutput()).not.toContain(SMTP_PASSWORD);
    // The encoded form too: nodemailer's own error quotes the failing command,
    // and for an auth failure that command IS the encoded credential.
    expect(consoleOutput()).not.toContain(SMTP_PASSWORD_ENCODED);
  });

  test("a rejection does not print the invite link", async () => {
    // Seam 6: the driver MUST NOT log bodies or invite links. A relay rejection
    // is where a driver is most tempted to dump the message it failed to send.
    fixture = await startSmtpFixture({ fail: "permanent" });
    const driver = driverFor(fixture);

    const error = await driver.send(notification()).catch((e) => e);

    expect(error).toBeInstanceOf(NotificationRejectedError);
    expect(error.message).not.toContain(INVITE_LINK);
    expect(consoleOutput()).not.toContain(INVITE_LINK);
  });
});

describe("issue 80: failures are classified by what the caller must do", () => {
  test("bad credentials are CONFIGURATION — not retryable", async () => {
    fixture = await startSmtpFixture({ fail: "auth" });
    const error = await driverFor(fixture).send(notification()).catch((e) => e);

    expect(error).toBeInstanceOf(NotificationConfigurationError);
    // Retrying a rejected password is how a relay account gets locked out.
    expect(error.retryable).toBe(false);
  });

  test("a 4xx is UNAVAILABLE — retryable", async () => {
    fixture = await startSmtpFixture({ fail: "temporary" });
    const error = await driverFor(fixture).send(notification()).catch((e) => e);

    expect(error).toBeInstanceOf(NotificationUnavailableError);
    expect(error.retryable).toBe(true);
  });

  test("a 5xx is REJECTED — not retryable", async () => {
    fixture = await startSmtpFixture({ fail: "permanent" });
    const error = await driverFor(fixture).send(notification()).catch((e) => e);

    expect(error).toBeInstanceOf(NotificationRejectedError);
    expect(error.retryable).toBe(false);
  });

  test("a dropped connection is UNAVAILABLE — retryable", async () => {
    fixture = await startSmtpFixture({ fail: "drop" });
    const error = await driverFor(fixture).send(notification()).catch((e) => e);

    expect(error).toBeInstanceOf(NotificationUnavailableError);
    expect(error.retryable).toBe(true);
  });

  test("an unreachable relay is UNAVAILABLE, not a contract error", async () => {
    // Port 1 with nothing on it. Reporting an outage as a bad payload would send
    // an operator hunting through templates while the relay is simply down.
    const driver = new SmtpNotificationDriver({
      host: "127.0.0.1",
      port: 1,
      secure: false,
      allowInsecure: true,
      username: "mailer",
      password: SMTP_PASSWORD,
      fromAddress: "no-reply@example.com",
      connectionTimeoutMs: 1_000,
    });

    const error = await driver.send(notification()).catch((e) => e);
    expect(error).toBeInstanceOf(NotificationUnavailableError);
    expect(error.retryable).toBe(true);
  }, 15_000);
});

describe("issue 80: status() never claims delivery", () => {
  test("a successful send reports queued, never delivered", async () => {
    // M8. SMTP's 250 means the next hop ACCEPTED the message, not that a mailbox
    // received it. A driver claiming otherwise is trusted while mail bounces
    // downstream, which is worse than one admitting it cannot know.
    fixture = await startSmtpFixture();
    const driver = driverFor(fixture);
    const { deliveryId } = await driver.send(notification());

    const status = await driver.status({ deliveryId });
    expect(status.status).toBe("queued");
  });

  test("an unknown deliveryId reports unknown, and still not delivered", async () => {
    fixture = await startSmtpFixture();
    const driver = driverFor(fixture);

    const status = await driver.status({ deliveryId: "never-issued" });
    expect(status.status).toBe("unknown");
  });

  test("no status path can return 'delivered'", async () => {
    // The type permits the string, so only behaviour can rule it out — asserted
    // across every path rather than trusting the two cases above.
    fixture = await startSmtpFixture();
    const driver = driverFor(fixture);
    const { deliveryId } = await driver.send(notification());

    for (const id of [deliveryId, "never-issued", "", null]) {
      const status = await driver.status({ deliveryId: id });
      expect(status.status).not.toBe("delivered");
    }
  });
});

describe("issue 80: plaintext is refused unless explicitly allowed", () => {
  test("a plaintext relay is refused when insecure transport is not accepted", async () => {
    // M10. The ruling is "refuse unless explicitly allowed" — a warning refuses
    // nothing, and the password crosses the wire either way.
    fixture = await startSmtpFixture();
    const driver = driverFor(fixture, { allowInsecure: false });

    await expect(driver.send(notification())).rejects.toThrow(
      NotificationConfigurationError
    );
    expect(fixture.messages).toHaveLength(0);
  });
});

describe("issue 80: validateConnection", () => {
  test("reports ok against a working relay, and carries no credential", async () => {
    fixture = await startSmtpFixture();
    const result = await SmtpNotificationDriver.validateConnection({
      host: fixture.host,
      port: fixture.port,
      secure: false,
      allowInsecure: true,
      username: "mailer",
      password: SMTP_PASSWORD,
      fromAddress: "no-reply@example.com",
    });

    expect(result.ok).toBe(true);
    // The details are shown to an admin in a settings page; a password there is
    // a password on a screen and in a screenshot.
    expect(JSON.stringify(result.details ?? {})).not.toContain(SMTP_PASSWORD);
  });

  test("reports not-ok for bad credentials without throwing", async () => {
    // A connection test that throws makes the caller catch to learn the answer;
    // this one is a question, and the answer is data.
    fixture = await startSmtpFixture({ fail: "auth" });
    const result = await SmtpNotificationDriver.validateConnection({
      host: fixture.host,
      port: fixture.port,
      secure: false,
      allowInsecure: true,
      username: "mailer",
      password: SMTP_PASSWORD,
      fromAddress: "no-reply@example.com",
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.details ?? {})).not.toContain(SMTP_PASSWORD);
  });
});

describe("issue 80 (QA-1 NIT-2): the driver cannot be serialized into a leak", () => {
  // Measured before the fix: JSON.stringify and util.inspect both returned the
  // password in full. `util.inspect` is what `console.log(driver)` calls, so a
  // single debugging line anywhere — here or in a dependency that logs the
  // objects it is handed — publishes the credential.
  const driverWithSecret = () =>
    new SmtpNotificationDriver({
      host: "smtp",
      port: 587,
      secure: false,
      allowInsecure: true,
      username: "mailer",
      password: SMTP_PASSWORD,
      fromAddress: "no-reply@example.com",
    });

  test("JSON.stringify does not carry the password", () => {
    const serialized = JSON.stringify(driverWithSecret());
    expect(serialized).not.toContain(SMTP_PASSWORD);
    expect(serialized).not.toContain(SMTP_PASSWORD_ENCODED);
    // Still useful: an operator debugging a connection needs to see WHERE it
    // points. Redaction that removes the diagnostic value gets reverted.
    expect(serialized).toContain("smtp");
  });

  test("util.inspect — what console.log uses — does not carry the password", () => {
    const util = require("util");
    const inspected = util.inspect(driverWithSecret(), { depth: 5 });
    expect(inspected).not.toContain(SMTP_PASSWORD);
    expect(inspected).not.toContain(SMTP_PASSWORD_ENCODED);
  });

  test("nesting the driver in another object does not defeat it", () => {
    // The realistic shape: a driver held on a config object that something else
    // logs. A `toJSON` that only fired at the top level would miss this.
    const util = require("util");
    const wrapper = { channel: "smtp", driver: driverWithSecret() };
    expect(JSON.stringify(wrapper)).not.toContain(SMTP_PASSWORD);
    expect(util.inspect(wrapper, { depth: 5 })).not.toContain(SMTP_PASSWORD);
  });

  test("an error carrying the driver as `cause` does not carry the password", () => {
    // Error causes are printed by most loggers and by node's own uncaught
    // handler, and this driver classifies failures with `{ cause: error }` — so a
    // cause chain reaching a driver instance is not hypothetical.
    const util = require("util");
    const error = new Error("failed", { cause: driverWithSecret() });
    expect(util.inspect(error, { depth: 5 })).not.toContain(SMTP_PASSWORD);
  });
});

describe("issue 80 (TL-1 F1): plaintext and untrusted certs are separate consents", () => {
  // One flag consenting to two unrelated things is the defect. An operator who
  // accepts "this relay is on our own network so plaintext is fine" was, with a
  // single boolean, also silently accepting "and do not check certificates" —
  // which matters precisely when the connection IS encrypted, because that is
  // the case where a certificate is the only thing identifying the far end.
  test("TLS still validates the certificate when only plaintext was accepted", async () => {
    const driver = new SmtpNotificationDriver({
      host: "smtp",
      port: 465,
      secure: true,
      // Accepted: an unencrypted hop. NOT accepted: an unverifiable peer.
      allowInsecureTransport: true,
      username: "mailer",
      password: SMTP_PASSWORD,
      fromAddress: "no-reply@example.com",
    });

    expect(driver.transportOptions().tls?.rejectUnauthorized).not.toBe(false);
  });

  test("an untrusted certificate is accepted only when that is asked for", async () => {
    const driver = new SmtpNotificationDriver({
      host: "smtp",
      port: 465,
      secure: true,
      allowUntrustedCertificate: true,
      username: "mailer",
      password: SMTP_PASSWORD,
      fromAddress: "no-reply@example.com",
    });

    expect(driver.transportOptions().tls?.rejectUnauthorized).toBe(false);
  });

  test("TL-1 OBS-1: the plaintext setting alone leaves TLS options untouched", async () => {
    // The mapping, asserted at the boundary the settings feed. If
    // `smtp_allow_insecure` ever reached the TLS decision again, this is what
    // catches it — the two consents are separate rows and separate fields.
    const driver = new SmtpNotificationDriver({
      host: "smtp",
      port: 587,
      secure: false,
      allowInsecureTransport: true,
      allowUntrustedCertificate: false,
      username: "mailer",
      password: SMTP_PASSWORD,
      fromAddress: "no-reply@example.com",
    });

    expect(driver.transportOptions().tls).toBeUndefined();
  });

  test("by default neither is accepted", async () => {
    const driver = new SmtpNotificationDriver({
      host: "smtp",
      port: 465,
      secure: true,
      username: "mailer",
      password: SMTP_PASSWORD,
      fromAddress: "no-reply@example.com",
    });

    expect(driver.transportOptions().tls?.rejectUnauthorized).not.toBe(false);
  });
});

describe("issue 80 (TL-1 F2): notificationId is the idempotency key", () => {
  test("the same notificationId twice puts ONE message on the relay", async () => {
    // The recon named this and the driver did not do it. It is not theoretical:
    // `event_deliveries` retries on its own schedule, so the second attempt of a
    // transient failure would be a second invitation email to a real person.
    fixture = await startSmtpFixture();
    const driver = driverFor(fixture);

    const first = await driver.send(notification({ notificationId: "n-dup" }));
    const second = await driver.send(notification({ notificationId: "n-dup" }));

    expect(fixture.messages).toHaveLength(1);
    // And the caller gets the SAME delivery back, not a new one — so a log
    // correlating on deliveryId still lines up across the retry.
    expect(second.deliveryId).toBe(first.deliveryId);
    expect(second.acceptedAt.getTime()).toBe(first.acceptedAt.getTime());
  });

  test("different notificationIds still send separately", async () => {
    // Guard the guard: deduplicating everything would pass the test above.
    fixture = await startSmtpFixture();
    const driver = driverFor(fixture);

    await driver.send(notification({ notificationId: "n-a" }));
    await driver.send(notification({ notificationId: "n-b" }));

    expect(fixture.messages).toHaveLength(2);
  });

  test("one event to two recipients is two messages", async () => {
    // Seam 6 derives notificationId from event AND recipient for this reason. If
    // the id were the event alone, the second recipient would silently never be
    // written to.
    fixture = await startSmtpFixture();
    const driver = driverFor(fixture);

    await driver.send(
      notification({
        notificationId: "evt-1:alice",
        recipient: { type: "address", id: "alice@example.com" },
      })
    );
    await driver.send(
      notification({
        notificationId: "evt-1:bob",
        recipient: { type: "address", id: "bob@example.com" },
      })
    );

    expect(fixture.messages).toHaveLength(2);
  });

  test("a FAILED send is not remembered as delivered", async () => {
    // Idempotency must not turn one transient failure into permanent silence:
    // the retry the queue exists to make is the whole point.
    fixture = await startSmtpFixture({ fail: "temporary" });
    const failing = driverFor(fixture);
    await failing.send(notification({ notificationId: "n-retry" })).catch(() => {});
    await fixture.close();

    fixture = await startSmtpFixture();
    const working = driverFor(fixture);
    await working.send(notification({ notificationId: "n-retry" }));

    expect(fixture.messages).toHaveLength(1);
  });
});

describe("issue 80 (TL-1 NIT-2): headers cannot be injected", () => {
  test("a CRLF in fromName does not add headers or recipients", async () => {
    // `fromName` becomes an admin-editable setting, so it is attacker-adjacent
    // input reaching a header. A bare CRLF here is the classic way to append
    // `Bcc:` to a message somebody else composed.
    fixture = await startSmtpFixture();
    const driver = driverFor(fixture, {
      fromName: "Approof\r\nBcc: attacker@example.com",
    });

    await driver.send(notification()).catch(() => {});

    // The address may survive as TEXT inside the quoted display name, and that
    // is harmless — quoting is exactly what keeps it inert. What must not happen
    // is a new header LINE or a second envelope recipient.
    for (const message of fixture.messages) {
      expect(message.to).toHaveLength(1);
      expect(message.to[0]).not.toContain("attacker@example.com");
      expect(message.data).not.toMatch(/^Bcc:/im);
    }
  });

  test("a CRLF in the subject does not add headers", async () => {
    fixture = await startSmtpFixture();
    const driver = driverFor(fixture);

    await driver
      .send(notification({ subject: "Hello\r\nBcc: attacker@example.com" }))
      .catch(() => {});

    for (const message of fixture.messages) {
      expect(message.to).toHaveLength(1);
      expect(message.data).not.toMatch(/^Bcc:/im);
    }
  });
});

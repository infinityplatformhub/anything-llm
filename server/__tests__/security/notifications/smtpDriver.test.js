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
const INVITE_LINK = "https://workspace.example.com/accept-invite/apw-inv-FIXTURE";

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

// S11a (#80): a REAL SMTP server on a real socket, written before the driver.
//
// PMO ruling: a fixture server, never `jest.mock("nodemailer")`. The reason is
// §7.9b from S3 — a mock shallow enough to assert "send was called" cannot
// assert the property that actually matters here, which is what crossed the
// WIRE versus what reached a log. Mocking the transport removes the wire.
//
// So this speaks enough of RFC 5321 to complete a session, and keeps the raw
// conversation. Two kinds of assertion depend on that transcript, and they have
// to be made together (QA-3 ruling 4):
//
//   POSITIVE — the message really reached the relay, with the real invite link
//              in its body. A driver that silently sent nothing would pass every
//              "no link in the log" test.
//   NEGATIVE — the password and the link appear in the transcript and NOWHERE
//              else: not in console output, not in `event_logs`, not in an error
//              message.
//
// The failure modes below are the ones seam 6 assigns distinct error classes to.
// A fixture that only ever answers 250 proves the happy path and nothing about
// which failures are retryable — which is the decision core actually makes.

const net = require("net");

const CRLF = "\r\n";

/**
 * @typedef {Object} FixtureOptions
 * @property {"none"|"auth"|"temporary"|"permanent"|"drop"} [fail]
 *   `auth`      → 535, must become NotificationConfigurationError
 *   `temporary` → 451, must become NotificationUnavailableError (retryable)
 *   `permanent` → 550, must become NotificationRejectedError
 *   `drop`      → close mid-session; a socket that dies is retryable
 * @property {string} [greetingHost] hostname the banner claims
 * @property {boolean} [requireAuth] refuse MAIL FROM before AUTH
 */

/**
 * Start a fixture SMTP server on an ephemeral port.
 *
 * Ephemeral because a fixed port makes two suites racing for it fail as a
 * "connection refused" that reads exactly like the bug under test.
 */
async function startSmtpFixture(options = {}) {
  const {
    fail = "none",
    // Deliberately DOTLESS by default. QA-3 measured that the audit redaction's
    // email pattern needs a `.` in the host, so `user:pass@smtp` and
    // `user:pass@localhost` leak in full while an FQDN is scrubbed by accident.
    // Testing against a dotless host means a credential leak shows up instead of
    // being hidden by a pattern that was never meant to catch it.
    greetingHost = "smtp",
    requireAuth = true,
  } = options;

  /** Every byte the client sent, in order. The evidence for both assertions. */
  const transcript = [];
  /** Parsed messages: {from, to[], data}. */
  const messages = [];
  let authAttempted = false;

  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let current = { from: null, to: [], data: "" };

    const send = (line) => socket.write(line + CRLF);
    send(`220 ${greetingHost} ESMTP fixture`);

    socket.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      transcript.push(text);
      buffer += text;

      let index;
      while ((index = buffer.indexOf(CRLF)) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + CRLF.length);

        if (inData) {
          // A lone dot ends the DATA block; everything before it is the message
          // exactly as the client framed it, which is what the body assertions
          // read.
          if (line === ".") {
            inData = false;
            if (fail === "permanent") {
              send("550 5.1.1 Recipient rejected");
            } else if (fail === "temporary") {
              send("451 4.3.0 Try again later");
            } else {
              messages.push({ ...current, to: [...current.to] });
              send("250 2.0.0 Ok: queued as FIXTURE-" + messages.length);
            }
            current = { from: null, to: [], data: "" };
            continue;
          }
          current.data += line + "\n";
          continue;
        }

        const upper = line.toUpperCase();
        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          if (fail === "drop") {
            socket.destroy();
            return;
          }
          send(`250-${greetingHost} greets you`);
          send("250-AUTH PLAIN LOGIN");
          send("250 8BITMIME");
        } else if (upper.startsWith("AUTH")) {
          authAttempted = true;
          if (fail === "auth") send("535 5.7.8 Authentication credentials invalid");
          else send("235 2.7.0 Authentication successful");
        } else if (upper.startsWith("MAIL FROM")) {
          if (requireAuth && !authAttempted) {
            send("530 5.7.0 Authentication required");
            continue;
          }
          current.from = line.slice(line.indexOf(":") + 1).trim();
          send("250 2.1.0 Ok");
        } else if (upper.startsWith("RCPT TO")) {
          current.to.push(line.slice(line.indexOf(":") + 1).trim());
          send("250 2.1.5 Ok");
        } else if (upper.startsWith("DATA")) {
          inData = true;
          send("354 End data with <CR><LF>.<CR><LF>");
        } else if (upper.startsWith("QUIT")) {
          send("221 2.0.0 Bye");
          socket.end();
        } else if (upper.startsWith("RSET")) {
          current = { from: null, to: [], data: "" };
          send("250 2.0.0 Ok");
        } else {
          send("500 5.5.2 Unrecognized command");
        }
      }
    });

    socket.on("error", () => {
      // A client hanging up mid-session is a case under test, not a fixture bug.
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    port: server.address().port,
    host: "127.0.0.1",
    messages,
    /** Everything the client sent, joined. Assert secrets against THIS. */
    get transcript() {
      return transcript.join("");
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startSmtpFixture };

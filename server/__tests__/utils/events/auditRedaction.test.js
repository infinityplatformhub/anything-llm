// T-6 Phase A (#28): the sentinel test. Fires a payload carrying every PDPA class
// and a non-allowlisted secret directly at AuditEventSubscriber.handle(), then
// reads the stored row back. Asserts on what LANDED IN THE DATABASE, not on what
// the redaction function returned — the guard has to be at the sink, and a unit
// test of redaction alone would pass with the subscriber unwired.
//
// Real Postgres per code-standards section 7.1: the row is written through Prisma
// and read back through Prisma.

const crypto = require("crypto");
const path = require("path");
const { execFileSync } = require("child_process");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const SERVER_DIR = path.resolve(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const PRISMA_BIN = path.join(SERVER_DIR, "node_modules/.bin/prisma");
const suffix = crypto.randomBytes(4).toString("hex");
const testSchemaName = `t6_redaction_${suffix}`;

const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
  throw new Error("DATABASE_URL must point at PostgreSQL for this suite");
const testUrl = new URL(baseDatabaseUrl);
testUrl.searchParams.set("schema", testSchemaName);

let prisma;
let subscriber;

const SENTINEL = {
  email: "somchai.pdpa@example.co.th",
  thaiId: "1234567890123",
  phone: "0812345678",
  card: "4111111111111111",
};

function auditEvent(data, overrides = {}) {
  return {
    eventId: crypto.randomUUID(),
    type: "user_updated",
    version: 1,
    occurredAt: new Date(),
    actor: { type: "user", id: "4242", orgId: "default" },
    resource: { type: "system", id: null },
    data,
    ...overrides,
  };
}

async function storedFor(event) {
  await subscriber.handle(event);
  return prisma.event_logs.findUnique({ where: { eventId: event.eventId } });
}

beforeAll(async () => {
  execFileSync(PRISMA_BIN, ["migrate", "deploy", "--schema", SCHEMA], {
    cwd: SERVER_DIR,
    env: { ...process.env, DATABASE_URL: testUrl.toString() },
    stdio: "pipe",
  });
  prisma = new PrismaClient({
    datasources: { db: { url: testUrl.toString() } },
  });
  const {
    AuditEventSubscriber,
  } = require("../../../utils/events/AuditEventSubscriber");
  subscriber = new AuditEventSubscriber({ db: prisma });
});

afterAll(async () => {
  await prisma?.$disconnect();
  const admin = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await admin.$executeRawUnsafe(
    `DROP SCHEMA IF EXISTS "${testSchemaName}" CASCADE`
  );
  await admin.$disconnect();
});

describe("audit sink redacts PDPA data before the row exists", () => {
  test("no raw PDPA value from a sentinel payload reaches event_logs", async () => {
    const row = await storedFor(
      auditEvent({
        username: SENTINEL.email,
        prevSystemPrompt: `contact ${SENTINEL.phone} or ${SENTINEL.email}`,
        newSystemPrompt: `id ${SENTINEL.thaiId} card ${SENTINEL.card}`,
      })
    );

    for (const raw of Object.values(SENTINEL))
      expect(row.metadata).not.toContain(raw);
    expect(row.metadata).toContain("[redacted:email]");
    expect(row.metadata).toContain("[redacted:phone_th]");
    expect(row.metadata).toContain("[redacted:thai_national_id]");
    expect(row.metadata).toContain("[redacted:credit_card]");
  });

  test("a key outside the allowlist is dropped rather than stored", async () => {
    const row = await storedFor(
      auditEvent({
        username: "plain-user",
        password: "hunter2-plaintext",
        apiSecret: "sk-live-should-never-land",
      })
    );

    expect(row.metadata).not.toContain("hunter2-plaintext");
    expect(row.metadata).not.toContain("sk-live-should-never-land");
    expect(JSON.parse(row.metadata).username).toBe("plain-user");
  });

  test("changes never stores a prev to next pair for a PII field", async () => {
    const row = await storedFor(
      auditEvent({
        username: "editor",
        changes: {
          password: "old-secret => new-secret",
          email: `old@example.com => ${SENTINEL.email}`,
          bio: "old bio => new bio",
        },
      })
    );

    const changes = JSON.parse(row.metadata).changes;
    expect(changes.password).toBe("[redacted:changed]");
    expect(changes.email).toBe("[redacted:changed]");
    expect(row.metadata).not.toContain("old-secret");
    expect(row.metadata).not.toContain("new-secret");
    expect(row.metadata).not.toContain("old@example.com");
    expect(changes.bio).toBe("old bio => new bio");
  });

  test("join keys survive redaction untouched", async () => {
    const event = auditEvent({ username: SENTINEL.email });
    const row = await storedFor(event);

    expect(row.eventId).toBe(event.eventId);
    expect(row.event).toBe("user_updated");
    expect(row.userId).toBe(4242);
    expect(row.occurredAt.toISOString()).toBe(event.occurredAt.toISOString());
  });

  test("a dropped key name is not echoed back into the row", async () => {
    // A key name is caller-controlled free text, so a payload can carry its PII in
    // the key rather than the value. Recording the names of dropped keys would
    // walk it straight past both guards.
    const row = await storedFor(
      auditEvent({
        username: "plain-user",
        [SENTINEL.email]: "value-under-a-pii-key",
        some_unknown_field: "UNKNOWN-SENTINEL-VALUE",
      })
    );

    expect(row.metadata).not.toContain(SENTINEL.email);
    expect(row.metadata).not.toContain("UNKNOWN-SENTINEL-VALUE");
    expect(JSON.parse(row.metadata)._droppedKeyCount).toBe(2);
  });

  test("nested string values are scanned at depth", async () => {
    const row = await storedFor(
      auditEvent({
        embeddedFiles: [{ note: `sent to ${SENTINEL.email}` }],
      })
    );

    expect(row.metadata).not.toContain(SENTINEL.email);
    expect(row.metadata).toContain("[redacted:email]");
  });
});

// issue 71: an invite code is a BEARER CREDENTIAL, not metadata.
//
// RED-first: written before the fix. `inviteCode` was on the allowlist and no
// PDPA pattern matches `apw-inv-<base64url>`, so the code reached event_logs
// byte for byte.
//
// Why that is worse than it sounds: `POST /invite/:code` is public and creates
// an account with workspace access, invites have no expiry, and the audit log is
// built to be exported to a SIEM. The credential therefore outlives, and travels
// further than, the system that issued it.
describe("issue 71: invite codes never reach the audit log", () => {
  const { Invite } = require("../../../models/invite");
  const { ALLOWED_KEYS } = require("../../../utils/events/redaction");

  test("a real generated invite code does not survive redaction", async () => {
    // Generated by the real function, not a hand-written lookalike: a fixture
    // that merely resembles the format proves nothing once the format changes.
    const code = Invite.makeCode();
    const row = await storedFor(auditEvent({ inviteCode: code }));

    expect(row.metadata).not.toContain(code);
  });

  // Techlead-2 measured five ways a code still reaches the row after `inviteCode`
  // leaves the allowlist, because the allowlist filters TOP-LEVEL KEYS ONLY.
  // Every allowlisted key that accepts free text is a carrier, and so is any
  // nested object or array under one. Each case here failed before the value
  // pattern was added.
  //
  // Enumerated from ALLOWED_KEYS rather than hand-picked: a key added later is
  // covered the day it is added, which a fixed list of favourites would not be.
  describe.each(
    [...ALLOWED_KEYS].filter(
      // `changes` gets its own case below — it is the one key with special
      // handling, so asserting it here would test the wrong code path.
      (key) => key !== "changes"
    )
  )("carried under an allowlisted key: %s", (key) => {
    test("a bare invite code is redacted", async () => {
      const code = Invite.makeCode();
      const row = await storedFor(auditEvent({ [key]: code }));
      expect(row.metadata).not.toContain(code);
    });

    test("a code embedded in a sentence is redacted", async () => {
      // A whole-value match would pass the case above and miss this one.
      const code = Invite.makeCode();
      const row = await storedFor(
        auditEvent({ [key]: `invite ${code} was sent` })
      );
      expect(row.metadata).not.toContain(code);
    });

    test("a code CONCATENATED onto a word is redacted", async () => {
      // Techlead FINDING-1, and the case a `\b` anchor fails: `\b` requires a
      // non-word character before the match, so `token<code>` — no separator at
      // all — slipped through entirely. Measured: four of five probe shapes
      // leaked, `_<code>` among them, because `_` is a word character.
      const code = Invite.makeCode();
      const row = await storedFor(auditEvent({ [key]: `token${code}` }));
      expect(row.metadata).not.toContain(code);
    });
  });

  test("a code inside `changes` is redacted", async () => {
    // `changes` is scrubbed by scrubChanges, a different function from the one
    // every other key goes through — so it needs its own case or half the
    // redaction code is unproven.
    const code = Invite.makeCode();
    const row = await storedFor(auditEvent({ changes: { code } }));
    expect(row.metadata).not.toContain(code);
  });

  test("a code nested in an object is redacted", async () => {
    const code = Invite.makeCode();
    const row = await storedFor(
      auditEvent({ embeddedFiles: { invite: { url: `/accept/${code}` } } })
    );
    expect(row.metadata).not.toContain(code);
  });

  test("a code inside an array is redacted", async () => {
    const code = Invite.makeCode();
    const row = await storedFor(auditEvent({ changes: { invites: [code] } }));
    expect(row.metadata).not.toContain(code);
  });

  test("QA-3: the accept-invite URL the frontend builds is redacted", async () => {
    // Not a hypothetical shape. `NewInviteModal/index.jsx:41,86` composes exactly
    // this URL to put on the clipboard, so it is the string most likely to be
    // passed to an audit call site by someone reaching for "the invite link".
    // `link` is an allowlisted key, so only the value pattern stops it.
    const code = Invite.makeCode();
    const row = await storedFor(
      auditEvent({ link: `https://workspace.example.com/accept-invite/${code}` })
    );

    expect(row.metadata).not.toContain(code);
    // The surrounding URL survives — redaction removes the credential, not the
    // fact that a link was involved.
    expect(row.metadata).toContain("[redacted:credential]");
  });

  test("every issued apw- credential is redacted, not just invites", async () => {
    // Same shape, same risk, and none of them was guarded. Each sibling is
    // generated by its REAL function rather than a lookalike string, so the
    // assertion keeps holding if a format changes.
    //
    // `apw-tat-` is here because an explicit three-prefix alternation missed it
    // and review caught it — the reason the pattern now matches the family
    // rather than a list.
    const { ApiKey } = require("../../../models/apiKeys");
    const {
      BrowserExtensionApiKey,
    } = require("../../../models/browserExtensionApiKey");
    const {
      TemporaryAuthToken,
    } = require("../../../models/temporaryAuthToken");

    for (const secret of [
      ApiKey.makeSecret(),
      BrowserExtensionApiKey.makeSecret(),
      TemporaryAuthToken.makeTempToken(),
    ]) {
      const spaced = await storedFor(auditEvent({ name: `key ${secret}` }));
      expect(spaced.metadata).not.toContain(secret);
      // And concatenated, per FINDING-1 — the anchor-free pattern has to hold
      // for the siblings too, not only for invites.
      const glued = await storedFor(auditEvent({ name: `token${secret}` }));
      expect(glued.metadata).not.toContain(secret);
    }
  });

  test("QA-3 R4: the displayed keyPrefix survives, and only just", async () => {
    // `keyPrefix` is an allowlisted audit JOIN KEY — it exists so an operator can
    // tie an event to an API key without holding the key. It is the first
    // DISPLAY_PREFIX_LENGTH (16) characters of the secret, which is `apw-key-`
    // plus 8: exactly one character short of the pattern's {16,} bound.
    //
    // The two numbers are therefore COUPLED, and nothing in the source says so.
    // Raise DISPLAY_PREFIX_LENGTH to 24 and every keyPrefix starts matching the
    // credential pattern — audit rows silently lose their join key, and the
    // suite would stay green because no other test looks at this. This is that
    // test.
    const { ApiKey } = require("../../../models/apiKeys");
    const {
      keyPrefix,
      DISPLAY_PREFIX_LENGTH,
    } = require("../../../utils/apiKeySecurity");

    const prefix = keyPrefix(ApiKey.makeSecret());
    expect(prefix).toHaveLength(DISPLAY_PREFIX_LENGTH);

    const row = await storedFor(auditEvent({ keyPrefix: prefix }));
    expect(JSON.parse(row.metadata).keyPrefix).toBe(prefix);

    // Say the relationship out loud, so a future change to either number fails
    // HERE — where the comment explains it — rather than in a puzzling audit bug.
    // `apw-key-` is 8 characters, and the pattern needs 16 after it.
    expect(DISPLAY_PREFIX_LENGTH - "apw-key-".length).toBeLessThan(16);
  });

  test("`inviteCode` is no longer an allowlisted key at all", async () => {
    // Belt and braces: the pattern would catch the value anyway, but the key
    // must not be a permitted carrier either — two independent guards, which is
    // the design this module already states in its header.
    expect(ALLOWED_KEYS.has("inviteCode")).toBe(false);
    expect(ALLOWED_KEYS.has("inviteId")).toBe(true);
  });

  test("the event still identifies WHICH invite, by id", async () => {
    // Redaction that removes the event's meaning is not a fix. The id ties the
    // row to the invite without carrying anything redeemable — the same trade
    // `keyPrefix` already makes for API keys.
    const row = await storedFor(
      auditEvent({ inviteId: 4242, createdBy: "admin-user" })
    );

    const stored = JSON.parse(row.metadata);
    expect(stored.inviteId).toBe(4242);
    expect(stored.createdBy).toBe("admin-user");
  });
});

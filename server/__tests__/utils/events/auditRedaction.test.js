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

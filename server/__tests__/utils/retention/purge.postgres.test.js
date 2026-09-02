// T-6 Phase B (#28): retention.purge@1 against real Postgres.
//
// Real database per code-standards section 7.1: the retention boundary is a
// timestamptz comparison, and a fake db proves nothing about it. The rows are
// seeded one second either side of the cutoff, which is the case an in-memory
// fake gets right by construction and Postgres can get wrong.

const crypto = require("crypto");
const path = require("path");
const { execFileSync } = require("child_process");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const SERVER_DIR = path.resolve(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const PRISMA_BIN = path.join(SERVER_DIR, "node_modules/.bin/prisma");
const suffix = crypto.randomBytes(4).toString("hex");
const testSchemaName = `t6_purge_${suffix}`;

const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
  throw new Error("DATABASE_URL must point at PostgreSQL for this suite");
const testUrl = new URL(baseDatabaseUrl);
testUrl.searchParams.set("schema", testSchemaName);

const DAY = 24 * 60 * 60 * 1000;
let prisma;
let purge;

const ago = (days, offsetMs = 0) =>
  new Date(Date.now() - days * DAY + offsetMs);

async function seed(rows) {
  await prisma.event_logs.deleteMany({});
  for (const [eventId, occurredAt, event] of rows)
    await prisma.event_logs.create({
      data: { eventId, event: event ?? "sent_chat", occurredAt, metadata: null },
    });
}

const survivorIds = async () =>
  (
    await prisma.event_logs.findMany({ select: { eventId: true } })
  )
    .map((row) => row.eventId)
    .sort();

async function setRetention(value) {
  if (value === null) {
    await prisma.system_settings.deleteMany({
      where: { label: "audit_retention_days" },
    });
    return;
  }
  await prisma.system_settings.upsert({
    where: { label: "audit_retention_days" },
    update: { value: String(value) },
    create: { label: "audit_retention_days", value: String(value) },
  });
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
  ({ purge } = require("../../../utils/retention/purge"));
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

describe("retention purge deletes only what is past its window", () => {
  test("a row one second past the cutoff goes and one second inside it stays", async () => {
    await setRetention(90);
    await seed([
      ["keep-inside", ago(90, 60_000)],
      ["drop-outside", ago(90, -60_000)],
      ["keep-recent", ago(1)],
    ]);

    const result = await purge({ db: prisma });

    expect(await survivorIds()).toEqual(["keep-inside", "keep-recent"]);
    expect(result.purged).toBe(1);
  });

  test("a second run deletes nothing and does not throw", async () => {
    await setRetention(90);
    await seed([
      ["old-a", ago(200)],
      ["old-b", ago(300)],
      ["fresh", ago(2)],
    ]);

    const first = await purge({ db: prisma });
    const second = await purge({ db: prisma });

    expect(first.purged).toBe(2);
    expect(second.purged).toBe(0);
    expect(await survivorIds()).toEqual(["fresh"]);
  });

  test("every eligible row goes in one invocation, not just the first batch", async () => {
    await setRetention(30);
    const rows = [];
    for (let index = 0; index < 250; index += 1)
      rows.push([`bulk-${String(index).padStart(3, "0")}`, ago(60)]);
    rows.push(["survivor", ago(1)]);
    await seed(rows);

    const result = await purge({ db: prisma, batchSize: 100 });

    expect(result.purged).toBe(250);
    expect(await survivorIds()).toEqual(["survivor"]);
  });

  test("an unset, empty, zero or unparseable window deletes nothing and does not throw", async () => {
    // Fail closed. A misread setting must never be the thing that empties the
    // audit log, so "keep forever" is the answer to every unusable value.
    for (const value of [null, "", "0", "abc"]) {
      await setRetention(value);
      await seed([
        ["ancient", ago(5000)],
        ["recent", ago(1)],
      ]);

      const result = await purge({ db: prisma });

      expect(result.purged).toBe(0);
      expect(result.skipped).toBe(true);
      expect(await survivorIds()).toEqual(["ancient", "recent"]);
    }
  });

  test("a negative window is refused rather than treated as a future cutoff", async () => {
    await setRetention(-30);
    await seed([["ancient", ago(5000)]]);

    const result = await purge({ db: prisma });

    expect(result.purged).toBe(0);
    expect(await survivorIds()).toEqual(["ancient"]);
  });
});

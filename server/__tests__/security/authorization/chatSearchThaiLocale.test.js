/**
 * V9 (#61) F5: a database that cannot make trigrams for Thai must say so.
 *
 * pg_trgm tokenises using LC_CTYPE. On LC_CTYPE=C -- initdb's default when the
 * environment carries no locale, and the usual state of a slim container image
 * -- every non-ASCII byte is non-alphanumeric, so Thai yields zero trigrams.
 * Nothing errors: the index builds, ILIKE returns the right rows, and it does
 * so by scanning the table. Thai search loses its index in silence.
 *
 * This suite creates BOTH kinds of database and pins the difference, because a
 * detector that has only ever run against one of them is a detector nobody has
 * tested.
 */
process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "v9-locale-")
  );
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");
const {
  thaiTrigramSupport,
  reportChatSearchLocaleSupport,
} = require("../../../utils/chatSearch/localeSupport");

const baseDatabaseUrl = process.env.DATABASE_URL;
const dbSuffix = crypto.randomBytes(4).toString("hex");
const cDb = `v9_ctype_c_${dbSuffix}`;
const utf8Db = `v9_ctype_utf8_${dbSuffix}`;
const urlFor = (name) =>
  baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);

let admin;
let cClient;
let utf8Client;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
    throw new Error("V9 locale tests require DATABASE_URL on PostgreSQL");
  admin = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  // TEMPLATE template0 is required to choose a locale that differs from the
  // template database's.
  await admin.$executeRawUnsafe(
    `CREATE DATABASE "${cDb}" LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`
  );
  await admin.$executeRawUnsafe(
    `CREATE DATABASE "${utf8Db}" LC_COLLATE 'en_US.UTF-8' LC_CTYPE 'en_US.UTF-8' TEMPLATE template0`
  );

  cClient = new PrismaClient({ datasources: { db: { url: urlFor(cDb) } } });
  utf8Client = new PrismaClient({
    datasources: { db: { url: urlFor(utf8Db) } },
  });
  for (const client of [cClient, utf8Client]) {
    await client.$executeRawUnsafe(
      `CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public`
    );
  }
}, 300_000);

afterAll(async () => {
  for (const client of [cClient, utf8Client]) {
    if (client) await client.$disconnect();
  }
  if (admin) {
    for (const name of [cDb, utf8Db]) {
      await admin.$executeRawUnsafe(
        `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`
      );
    }
    await admin.$disconnect();
  }
}, 60_000);

describe("V9 chat search: Thai trigram support is detected, not assumed", () => {
  test("a C-locale database produces no trigrams for Thai", async () => {
    const result = await thaiTrigramSupport({ db: cClient });
    expect(result.supported).toBe(false);
    expect(result.trigrams).toBe(0);
    expect(result.ctype).toBe("C");
  });

  test("a UTF-8 database produces trigrams for Thai", async () => {
    const result = await thaiTrigramSupport({ db: utf8Client });
    expect(result.supported).toBe(true);
    expect(result.trigrams).toBeGreaterThan(0);
  });

  test("boot reports an error on a C-locale database, naming the ctype and the repair", async () => {
    const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
    await reportChatSearchLocaleSupport({ db: cClient, logger });

    expect(logger.error).toHaveBeenCalledTimes(1);
    const message = logger.error.mock.calls[0][0];
    // The operator needs three things from this line: what is wrong, what it
    // costs them, and what to do. Assert all three rather than "it logged".
    expect(message).toContain('LC_CTYPE="C"');
    expect(message).toMatch(/scans the whole table|full[- ]scan/i);
    expect(message).toContain("TEMPLATE template0");
  });

  test("boot says nothing on a UTF-8 database", async () => {
    const logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn() };
    await reportChatSearchLocaleSupport({ db: utf8Client, logger });
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("the planner reaches Thai rows through the index on UTF-8 and by scanning on C", async () => {
    // The detector's whole claim, proven at the plan level: same schema, same
    // index, same query, two databases.
    //
    // Compared WITHOUT enable_seqscan=off, unlike the English index test in
    // chatSearchSelfOnly. Forcing the planner away from a scan makes it pick
    // the trigram index even on the C database, where that index contains no
    // Thai trigrams and therefore cannot help -- so a forced plan would show
    // the two databases agreeing and hide the finding. What matters here is
    // which plan the planner CHOOSES when left alone, and it needs enough rows
    // for that choice to be meaningful.
    for (const client of [cClient, utf8Client]) {
      await client.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS probe (id serial primary key, body text)`
      );
      await client.$executeRawUnsafe(
        `INSERT INTO probe (body)
         SELECT 'ข้อความไทยแถวที่ ' || g FROM generate_series(1, 20000) g`
      );
      await client.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS probe_trgm ON probe USING gin (body public.gin_trgm_ops)`
      );
      await client.$executeRawUnsafe(`ANALYZE probe`);
    }

    const planFor = async (client) =>
      JSON.stringify(
        await client.$queryRawUnsafe(
          `EXPLAIN (FORMAT JSON) SELECT id FROM probe WHERE body ILIKE $1`,
          "%ประวัติ%"
        )
      );

    const utf8Plan = await planFor(utf8Client);
    expect(utf8Plan).toContain("probe_trgm");
    expect(utf8Plan).toContain("Bitmap Index Scan");

    // Not a preference of the planner's -- there is genuinely nothing in the
    // index to look up, because show_trgm returned {} for every row inserted.
    const cPlan = await planFor(cClient);
    expect(cPlan).toContain("Seq Scan");
    expect(cPlan).not.toContain("probe_trgm");
  }, 180_000);
});

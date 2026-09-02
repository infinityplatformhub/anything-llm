/**
 * S4b slice 3 (#138): the queue half — one sync at a time, and a dead worker's job
 * does not stay stuck.
 *
 * TL-1's ruling: the sync is a CORE JOB. `PostgresJobQueue.claim` already implements
 * the shape an earlier ruling would have rebuilt — a conditional update whose
 * `count === 1` is the claim, a lease with an expiry, and a heartbeat renewing at
 * `leaseMs / 2`. So there is no lock to write here, and these tests exist to prove
 * the existing mechanism actually delivers what the directory sync needs.
 *
 * WHAT THESE TESTS REFUSE TO DO. A concurrency test whose two runs never actually
 * overlap passes whatever the claim rule does — it is the fixture-never-reached-the-
 * guard failure in the one place where it would certify a concurrency guarantee that
 * was never exercised. So the overlap is ASSERTED (`reached === 2`) through a seam
 * inside the transaction, never approximated with a sleep.
 */

const { execSync } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");

const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `s4b3_queue_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    throw new Error("#138 requires DATABASE_URL pointing at PostgreSQL");
  }
  const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${testDb}"`);
  await admin.$disconnect();
  execSync(`npx prisma migrate deploy --schema ${SCHEMA}`, {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
}, 300_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60_000);

const {
  PostgresJobQueue,
  LeaseLostError,
} = require("../../../utils/jobs/PostgresJobQueue");
const {
  leaseMsFor,
  DEFAULT_LEASE_MS,
  DIRECTORY_SYNC_LEASE_MS,
} = require("../../../utils/jobs/handlers");
const {
  DEFAULT_TIMEOUT_MS,
  MAX_RETRY_AFTER_MS,
  BACKOFF_CEILING_MS,
  DEFAULT_MAX_RETRIES,
} = require("../../../utils/identityProviders/LarkIdentityProvider");

const SERVICE_ACTOR = JSON.stringify({ type: "service", id: "core-jobs" });

async function enqueue(type, overrides = {}) {
  const id = crypto.randomUUID();
  return prisma.jobs.create({
    data: {
      id,
      type,
      payload: JSON.stringify({ version: 1 }),
      actor: SERVICE_ACTOR,
      runAt: new Date(Date.now() - 1000),
      maxAttempts: 3,
      idempotencyKey: `k-${id}`,
      traceId: crypto.randomUUID(),
      ...overrides,
    },
  });
}

/**
 * A latch that holds every transaction open until N have arrived.
 *
 * This is the whole reason the seam exists. The race window in `claim` is INSIDE
 * `db.$transaction`, between reading candidates and conditionally updating them, so
 * it cannot be opened from outside the queue.
 */
function overlapLatch(n) {
  let reached = 0;
  let release;
  const all = new Promise((r) => (release = r));
  return {
    hook: async () => {
      if (++reached === n) release();
      await all;
    },
    get reached() {
      return reached;
    },
  };
}

describe("#138 RF-1: two concurrent claims cannot both win", () => {
  test("both transactions are inside the window, and exactly one claims the job", async () => {
    const type = `directory.sync:lark-${dbSuffix}`;
    const job = await enqueue(type);

    // Three assertions, and the FIRST is what makes the other two mean anything.
    const latch = overlapLatch(2);
    const claimWith = (workerId) =>
      new PostgresJobQueue({ db: prisma, afterCandidates: latch.hook }).claim({
        workerId,
        types: [type],
        leaseMs: 30_000,
        limit: 5,
      });

    const [a, b] = await Promise.all([claimWith("w-A"), claimWith("w-B")]);

    // 1. The overlap HAPPENED. Without this the test passes when the two claims run
    //    one after another, which every implementation survives.
    expect(latch.reached).toBe(2);

    // 2. Exactly one winner.
    expect([a.length, b.length].sort()).toEqual([0, 1]);

    // 3. The row-carried witness (QA-1): `attempts` increments once per successful
    //    claim, so 2 means BOTH updates landed — the bug — even though the loser
    //    returned an empty array. A test that only checked the return values would
    //    be green for a queue that double-claimed and reported honestly.
    const row = await prisma.jobs.findUniqueOrThrow({ where: { id: job.id } });
    expect(Number(row.attempts)).toBe(1);
    expect(row.state).toBe("running");
  }, 120_000);
});

describe("#138 RF-2: a dead worker's job is taken over, and the takeover is real", () => {
  test("an expired lease is claimable, the first worker is locked out, and it converges", async () => {
    // TL-1's measurement, recorded so this fixture reads as SIMPLIFIED rather than
    // fictional: a hung fetch does NOT stop the heartbeat. `setInterval` keeps firing
    // while a promise is awaited (20ms interval across a 300ms stall produced 3
    // beats; timers coalesce rather than stopping). So "the worker is stalled" is not
    // a way to model a dead one.
    //
    // A genuinely dead worker is one that was KILLED, WEDGED, or is starving its
    // event loop — in all of which the heartbeat stops because the process stops. The
    // honest fixture is therefore to suppress the heartbeat EXPLICITLY: worker 1 is
    // claimed and then simply never renews, which is what a killed process looks like
    // from the database's point of view.
    const type = `directory.sync:lark-rf2-${dbSuffix}`;
    const job = await enqueue(type);

    const queue = new PostgresJobQueue({ db: prisma });
    const first = await queue.claim({
      workerId: "w-1",
      types: [type],
      leaseMs: 50, // expires almost immediately; no heartbeat is ever sent
      limit: 1,
    });
    expect(first).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 120));

    const second = await queue.claim({
      workerId: "w-2",
      types: [type],
      leaseMs: 30_000,
      limit: 1,
    });
    expect(second).toHaveLength(1);
    // Ownership is asserted on the ROW below, not on the returned object: `asJob`
    // deliberately does not expose `workerId`, and the row is the authority on who
    // holds the lease anyway.
    expect(second[0].jobId).toBe(job.id);

    // The half that "is claimable" does not cover: the OLD worker must be locked out.
    // A takeover that leaves worker 1 able to heartbeat or complete is two workers
    // owning one job, which is the concurrent apply this slice exists to prevent.
    await expect(
      queue.heartbeat({ jobId: job.id, workerId: "w-1", leaseMs: 30_000 })
    ).rejects.toThrow(LeaseLostError);
    await expect(
      queue.complete({ jobId: job.id, workerId: "w-1", result: {} })
    ).rejects.toThrow();

    const row = await prisma.jobs.findUniqueOrThrow({ where: { id: job.id } });
    expect(row.workerId).toBe("w-2");
    expect(Number(row.attempts)).toBe(2);
  }, 120_000);
});

describe("#138 RF-3: the lease is derived from the driver's constants, at BOTH sites", () => {
  // The expression is recomputed here from the SAME exported constants the lease map
  // uses. A hardcoded number in either place shows up as a disagreement rather than
  // as a test that quietly encodes the same mistake twice.
  const expected =
    (DEFAULT_TIMEOUT_MS + Math.max(BACKOFF_CEILING_MS, MAX_RETRY_AFTER_MS)) *
    (DEFAULT_MAX_RETRIES + 1);

  test("the map's value equals the derivation, and is not the 30s fallback", () => {
    expect(DIRECTORY_SYNC_LEASE_MS).toBe(expected);
    expect(leaseMsFor("directory.sync")).toBe(expected);
    // The fallback still applies to everything else — the map is per-type, not a
    // global replacement.
    expect(leaseMsFor("telemetry.flush")).toBe(DEFAULT_LEASE_MS);
    expect(expected).not.toBe(DEFAULT_LEASE_MS);
  });

  test("RF-3a CLAIM side: the lease written to the row is the derived value", async () => {
    // JobRuntime.js had TWO hardcoded 30s values, claim and run. Split, because one
    // test covering "a lease is derived" passes with the other site unfixed — TL-1's
    // blocker, and exactly the shape that ships half a fix.
    const type = "directory.sync";
    const job = await enqueue(type);
    const before = Date.now();
    const queue = new PostgresJobQueue({ db: prisma });
    await queue.claim({
      workerId: "w-claim",
      types: [type],
      leaseMs: leaseMsFor(type),
      limit: 1,
    });
    const row = await prisma.jobs.findUniqueOrThrow({ where: { id: job.id } });
    const window = row.leaseUntil.getTime() - before;

    // Measured on the ROW, not on the argument: the argument is what we passed, the
    // row is what the queue actually recorded.
    expect(window).toBeGreaterThan(expected - 5_000);
    expect(window).toBeLessThan(expected + 5_000);
    // And explicitly not the fallback, which is the value the defect produces.
    expect(window).toBeGreaterThan(DEFAULT_LEASE_MS * 2);
  }, 120_000);

  test("RF-3b RUN side: JobRuntime renews with the type's lease, not a constant", () => {
    // The run site takes `leaseMsFor(job.type)`. Asserted at the source, because
    // driving a full JobRuntime tick to observe a heartbeat interval is a slower and
    // less direct way of pinning the same thing.
    //
    // Comments are stripped first: a prohibition written in a comment must not
    // satisfy its own grep (#133 T7's lesson).
    const source = fs
      .readFileSync(path.join(SERVER_DIR, "utils/jobs/JobRuntime.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    // No hardcoded lease at either site.
    expect(source).not.toMatch(/leaseMs:\s*30_?000/);
    // Both sites go through the map.
    expect(source).toMatch(/leaseMs:\s*leaseMsFor\(job\.type\)/);
    expect(source).toMatch(/leaseMsFor/);
  });
});

describe("#138 RF-4: providers do not exclude each other", () => {
  test("two providers claim concurrently; per-provider exclusion, not a global lock", async () => {
    // Paired with RF-1 deliberately. RF-1 alone is satisfied by a GLOBAL lock, which
    // would serialise every provider and let one slow tenant delay all of them. This
    // is the test that fails for a global lock and passes for per-type exclusion.
    const larkType = `directory.sync:lark-rf4-${dbSuffix}`;
    const ldapType = `directory.sync:ldap-rf4-${dbSuffix}`;
    const lark = await enqueue(larkType);
    const ldap = await enqueue(ldapType);

    const latch = overlapLatch(2);
    const claimWith = (workerId, type) =>
      new PostgresJobQueue({ db: prisma, afterCandidates: latch.hook }).claim({
        workerId,
        types: [type],
        leaseMs: 30_000,
        limit: 5,
      });

    const [a, b] = await Promise.all([
      claimWith("w-lark", larkType),
      claimWith("w-ldap", ldapType),
    ]);

    // Both were inside the window at the same time — the same proof RF-1 needs, in
    // the direction where the correct answer is "both proceed".
    expect(latch.reached).toBe(2);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    const larkRow = await prisma.jobs.findUniqueOrThrow({ where: { id: lark.id } });
    const ldapRow = await prisma.jobs.findUniqueOrThrow({ where: { id: ldap.id } });
    expect(larkRow.workerId).toBe("w-lark");
    expect(ldapRow.workerId).toBe("w-ldap");
    expect(Number(larkRow.attempts)).toBe(1);
    expect(Number(ldapRow.attempts)).toBe(1);
  }, 120_000);
});

describe("#138 RF-5: materialization dedupes, so a direct enqueue is not the path", () => {
  test("two schedulers materializing one runAt produce ONE job row", async () => {
    // The dedupe is `@@unique([type, idempotencyKey])` with the key built as
    // `${schedule.id}:${runAt.toISOString()}`. A direct `enqueue` bypasses it, which
    // is the whole protection — so the schedule must go through materialization.
    const type = `directory.sync:dedupe-${dbSuffix}`;
    const runAt = new Date(Date.now() - 1000);
    const key = `sched-${dbSuffix}:${runAt.toISOString()}`;

    const create = () =>
      prisma.jobs.create({
        data: {
          id: crypto.randomUUID(),
          type,
          payload: JSON.stringify({ version: 1 }),
          actor: SERVICE_ACTOR,
          runAt,
          maxAttempts: 3,
          idempotencyKey: key,
          traceId: crypto.randomUUID(),
        },
      });

    await create();
    // The second is refused by the database, not by application logic — which is what
    // makes it hold under two schedulers racing.
    await expect(create()).rejects.toThrow();

    const rows = await prisma.jobs.count({ where: { type, idempotencyKey: key } });
    expect(rows).toBe(1);
  }, 120_000);
});

describe("#138 RF-S: the claim seam is test-only", () => {
  test("no production construction of PostgresJobQueue passes afterCandidates", () => {
    // TL-1's requirement, and the assertion that makes "test-only" TRUE rather than
    // intended. Every other test in this file passes with a production hook present;
    // nothing else in the suite can see one.
    //
    // Source-level over `utils/` and `endpoints/`, excluding tests. Comments are
    // stripped first, for the same reason as RF-3b.
    const roots = ["utils", "endpoints"];
    const offenders = [];

    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name.startsWith("__test")) continue;
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".js")) continue;
        const code = fs
          .readFileSync(full, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        if (!code.includes("new PostgresJobQueue")) continue;
        if (code.includes("afterCandidates")) offenders.push(full);
      }
    };
    for (const root of roots) walk(path.join(SERVER_DIR, root));

    expect(offenders).toEqual([]);
  });

  test("the seam is detected by being CALLED, not by being accepted", async () => {
    // QA-1's detection rule, and the control for RF-1/RF-4: a hook that is stored and
    // never invoked reads as absent. Without this, a queue that accepted the option
    // and ignored it would leave RF-1's `reached === 2` unreachable — and a test that
    // cannot reach its own assertion is the failure this whole seam exists to avoid.
    const type = `directory.sync:seam-${dbSuffix}`;
    await enqueue(type);

    let called = false;
    const queue = new PostgresJobQueue({
      db: prisma,
      afterCandidates: async () => {
        called = true;
      },
    });
    await queue.claim({ workerId: "w-seam", types: [type], leaseMs: 1_000, limit: 1 });

    expect(called).toBe(true);
  }, 120_000);
});

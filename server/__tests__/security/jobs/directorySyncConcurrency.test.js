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
  PostgresJobScheduler,
} = require("../../../utils/jobs/PostgresJobScheduler");
const {
  handlers,
  leaseMsFor,
  baseTypeOf,
  directorySyncTypeFor,
  DEFAULT_LEASE_MS,
  DIRECTORY_SYNC_LEASE_MS,
} = require("../../../utils/jobs/handlers");
const {
  DEFAULT_TIMEOUT_MS,
  MAX_RETRY_AFTER_MS,
  BACKOFF_CEILING_MS,
  DEFAULT_MAX_RETRIES,
} = require("../../../utils/identityProviders/LarkIdentityProvider");

const {
  runDirectorySync,
} = require("../../../utils/identity/runDirectorySync");
const {
  applyDirectoryPlan,
} = require("../../../utils/identity/applyDirectoryPlan");
const {
  enumerateDirectory,
  diffDirectory,
} = require("../../../utils/identity/directoryDiff");
const { SERVICE_PRINCIPALS } = require("../../../utils/authorization/principals");

const SERVICE_ACTOR = JSON.stringify({ type: "service", id: "core-jobs" });
const CORE_JOBS = SERVICE_PRINCIPALS.coreJobs;

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
  // WHAT THE FIRST VERSION OF THIS TEST DID NOT PIN (QA-1). It hand-built two rows
  // carrying the same `(type, idempotencyKey)` and asserted the second was refused.
  // That tests the UNIQUE INDEX — which is real, but the index is not the thing at
  // risk. `registerDirectorySyncSchedule` could enqueue directly, with a fresh key
  // per call, and every assertion in that version would still pass while two
  // schedulers produced two runs of one tick. So this drives the SCHEDULER and
  // asserts the key it derives.
  const scheduleId = `directory-sync-rf5-${dbSuffix}`;
  const type = `directory.sync:rf5-${dbSuffix}`;

  // Deliberately NOT on a cron boundary. `materialize` uses `nextRunAt || now` as the
  // run instant, so a frozen clock that happens to sit exactly on the boundary makes
  // "the key came from the schedule" and "the key came from the clock" produce the
  // same string, and the test cannot tell them apart.
  const frozen = new Date("2026-09-02T12:02:17.000Z");

  test("two schedulers materializing one tick produce ONE job, keyed on the schedule", async () => {
    const queue = new PostgresJobQueue({ db: prisma });
    await queue.schedule({
      scheduleId,
      type,
      cron: "0 * * * *",
      timezone: "UTC",
      payload: { version: 1, provider: `rf5-${dbSuffix}` },
      actor: JSON.parse(SERVICE_ACTOR),
      enabled: true,
    });

    // Both schedulers share one frozen clock: two processes ticking within the same
    // minute, which is the race. Sequential rather than concurrent on purpose — the
    // advisory lock in `materialize` serialises them anyway, so running them in
    // parallel would prove the lock, not the key.
    const scheduler = () =>
      new PostgresJobScheduler({ db: prisma, now: () => frozen });
    await scheduler().materialize();

    const afterFirst = await prisma.jobs.findMany({ where: { type } });
    expect(afterFirst).toHaveLength(1);

    // The key is `${scheduleId}:${runAt.toISOString()}` — derived from the SCHEDULE
    // and the tick instant, so any scheduler computing the same tick computes the
    // same key. A per-request timestamp or a UUID here would be unique per call, and
    // the unique index would never see a duplicate to refuse.
    expect(afterFirst[0].idempotencyKey).toBe(
      `${scheduleId}:${frozen.toISOString()}`
    );

    // The schedule advanced TO THE NEXT CRON BOUNDARY, not merely to some later
    // instant. QA-1 caught this and it is measured (mutant M5A): replacing the
    // `nextRun(cron, ...)` call with `now + 1ms` SURVIVES a "greater than frozen"
    // assertion — the schedule still moves forward, so the test stays green while the
    // cron expression has stopped being consulted at all. The consequence is not
    // theoretical: an hourly sync would materialize once per scheduler tick.
    //
    // The expected instant comes from the same clock the fixture froze, so this pins
    // the boundary rather than a hardcoded string that would need editing whenever
    // the fixture time moves.
    const advanced = await prisma.job_schedules.findUniqueOrThrow({
      where: { id: scheduleId },
    });
    //
    // Pinned on the WALL-CLOCK FIELDS rather than on an exact instant: `later` carries
    // the millisecond of the instant it searches from, so the boundary comes back as
    // 13:00:00.001 rather than .000 (the `+ 1` in `materialize`'s call). That is a
    // quirk of the library, not of the cron expression, and encoding it as a literal
    // string would make this test fail the day the library rounds differently while
    // the behaviour under test is unchanged.
    expect(advanced.nextRunAt).not.toBeNull();
    expect(advanced.nextRunAt.getUTCHours()).toBe(13);
    expect(advanced.nextRunAt.getUTCMinutes()).toBe(0);
    expect(advanced.nextRunAt.getUTCSeconds()).toBe(0);
    // And it is genuinely later — the property the boundary assertion assumes but
    // does not state, kept so a boundary computed in the past would still be red.
    expect(advanced.nextRunAt.getTime()).toBeGreaterThan(frozen.getTime());

    // The second scheduler, same clock, same tick: refused by the key, silently and
    // without an error, which is what lets two schedulers run at once.
    await scheduler().materialize();
    expect(await prisma.jobs.count({ where: { type } })).toBe(1);
  }, 120_000);

  test("RF-5b: the schedule registers through materialization, never a direct enqueue", () => {
    // The complement, and the half a runtime test cannot reach: a direct
    // `queue.enqueue` in the registration path would produce ONE job on the first
    // call too, so the test above passes with the protection removed. Asserted at the
    // source, with comments stripped first (#133 T7: a prohibition written in a
    // comment must not satisfy its own grep).
    const source = fs
      .readFileSync(path.join(SERVER_DIR, "utils/jobs/handlers.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    const registration = source.slice(
      source.indexOf("async function registerDirectorySyncSchedule")
    );
    expect(registration).toMatch(/queue\.schedule\(/);
    expect(registration).not.toMatch(/queue\.enqueue\(/);
  });
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

describe("#138 RF-6: one tick's claim writes one lease to every type it claims", () => {
  test("a short-lease job claimed alongside directory.sync carries the LONGER lease", async () => {
    // QA-1's latent finding, pinned as behaviour rather than left to be discovered.
    //
    // `JobRuntime.tick` makes ONE `claim` call for every registered type, and a claim
    // takes a single `leaseMs`. So once `directory.sync` is registered, a
    // `telemetry.flush` claimed in the same tick is leased for the directory sync's
    // 160s rather than 30s, until its own first heartbeat renews it at its own rate.
    //
    // Pinned in the SAFE direction deliberately (TL-1 to rule if the other is wanted):
    // a lease that is too LONG delays takeover of a job whose worker died — bounded,
    // visible, and recoverable. A lease too SHORT lets a second worker claim a job
    // whose first worker is alive and mid-run, which for the directory sync is the
    // concurrent apply this entire slice exists to prevent. Given one number for a
    // mixed claim, the maximum is the only choice that cannot cause that.
    //
    // The cost is real and is why this test exists rather than a comment: a crashed
    // telemetry flush now waits the longer lease before another worker retries it.
    const flushType = `telemetry.flush-rf6-${dbSuffix}`;
    const syncType = `directory.sync:lark-rf6-${dbSuffix}`;
    const flush = await enqueue(flushType);
    await enqueue(syncType);

    // Exactly what tick computes, over a mixed set of types.
    const types = [flushType, syncType];
    const claimLeaseMs = Math.max(...types.map(leaseMsFor));
    expect(claimLeaseMs).toBe(DIRECTORY_SYNC_LEASE_MS);
    // The premise: these two types really do disagree, or the assertion below is
    // green for a queue that ignores the lease entirely.
    expect(leaseMsFor(flushType)).toBe(DEFAULT_LEASE_MS);
    expect(leaseMsFor(flushType)).not.toBe(claimLeaseMs);

    const before = Date.now();
    const queue = new PostgresJobQueue({ db: prisma });
    await queue.claim({ workerId: "w-mixed", types, leaseMs: claimLeaseMs, limit: 10 });

    const flushRow = await prisma.jobs.findUniqueOrThrow({ where: { id: flush.id } });
    const window = flushRow.leaseUntil.getTime() - before;

    // The flush job carries the DIRECTORY SYNC's lease, not its own.
    expect(window).toBeGreaterThan(DIRECTORY_SYNC_LEASE_MS - 5_000);
    expect(window).toBeGreaterThan(DEFAULT_LEASE_MS * 2);
  }, 120_000);

  test("run-side renewal is per type, so the bleed does not persist", async () => {
    // The half that bounds the cost above: the claim writes one lease, but `run`
    // renews with `leaseMsFor(job.type)`, so a flush job's lease returns to its own
    // 30s at the first heartbeat. Without this the bleed would be permanent for the
    // life of the job rather than a single claim window.
    const source = fs
      .readFileSync(path.join(SERVER_DIR, "utils/jobs/JobRuntime.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source).toMatch(/leaseMs:\s*leaseMsFor\(job\.type\)/);

    // And the two really are different lookups: the claim takes a max over types, the
    // run takes one type's value.
    expect(source).toMatch(/Math\.max\(\.\.\.types\.map\(leaseMsFor\)\)/);
  });
});

describe("#138: a provider-suffixed type still finds its handler and its lease", () => {
  test("directory.sync:lark resolves the directory.sync handler and lease", () => {
    // The provider is in the TYPE (that is what gives per-provider exclusion), but the
    // handler and lease maps are keyed by the KIND of job. Without the base-type
    // normalisation a new provider silently has no handler and a 30s lease — it would
    // be claimed, leased wrongly, and then fail "No handler for directory.sync:lark@1"
    // at run time, which reads as a missing feature rather than a key mismatch.
    expect(baseTypeOf("directory.sync:lark")).toBe("directory.sync");
    expect(baseTypeOf("telemetry.flush")).toBe("telemetry.flush");

    expect(leaseMsFor("directory.sync:lark")).toBe(DIRECTORY_SYNC_LEASE_MS);
    expect(leaseMsFor("directory.sync:ldap")).toBe(DIRECTORY_SYNC_LEASE_MS);

    // The handler exists under the base key, and the worker looks it up that way.
    expect(typeof handlers["directory.sync@1"]).toBe("function");
    expect(directorySyncTypeFor("lark")).toBe("directory.sync:lark");
  });
});

describe("#138 RF-3c/RF-3d (TL-1 F1): the lease resolves for PROVIDER-QUALIFIED types", () => {
  test("RF-3c: a provider-suffixed type gets the derived lease, not the fallback", () => {
    // TL-1's F1. Every runtime type carries its provider (`directory.sync:lark`) —
    // that is what gives per-provider exclusion — but the lease map is keyed by the
    // KIND of job. An exact-match lookup returns the 30s FALLBACK for every real job
    // and the derived value only for the bare key that nothing enqueues, so a test
    // using the bare key is green while production is unfixed.
    //
    // Asserted on the qualified forms, including the suffixed shape the other tests
    // build, so this cannot pass on a lookup that only handles the tidy case.
    const expected =
      (DEFAULT_TIMEOUT_MS + Math.max(BACKOFF_CEILING_MS, MAX_RETRY_AFTER_MS)) *
      (DEFAULT_MAX_RETRIES + 1);

    expect(leaseMsFor("directory.sync:lark")).toBe(expected);
    expect(leaseMsFor("directory.sync:ldap")).toBe(expected);
    expect(leaseMsFor(directorySyncTypeFor("lark"))).toBe(expected);
    // The shape this suite's own fixtures use.
    expect(leaseMsFor(`directory.sync:lark-${dbSuffix}`)).toBe(expected);

    // And the fallback is NOT what any of them got — the failure mode being pinned.
    expect(expected).not.toBe(DEFAULT_LEASE_MS);
    // A different kind of job is unaffected: this resolves by prefix, not by
    // "anything containing a colon".
    expect(leaseMsFor("telemetry.flush")).toBe(DEFAULT_LEASE_MS);
    expect(leaseMsFor("telemetry.flush:whatever")).toBe(DEFAULT_LEASE_MS);
  });

  test("RF-3d: a provider-qualified job's ROW carries the derived lease", async () => {
    // RF-3c pins the lookup; this pins what the database actually records for the
    // type a real sync enqueues. The two differ if the runtime resolves the lease
    // correctly and then passes something else.
    const type = directorySyncTypeFor(`lark-rf3d-${dbSuffix}`);
    const job = await enqueue(type);
    const before = Date.now();

    await new PostgresJobQueue({ db: prisma }).claim({
      workerId: "w-rf3d",
      types: [type],
      leaseMs: leaseMsFor(type),
      limit: 1,
    });

    const row = await prisma.jobs.findUniqueOrThrow({ where: { id: job.id } });
    const window = row.leaseUntil.getTime() - before;
    expect(window).toBeGreaterThan(DIRECTORY_SYNC_LEASE_MS - 5_000);
    // Explicitly not the fallback, which is what the F1 defect produces.
    expect(window).toBeGreaterThan(DEFAULT_LEASE_MS * 2);
  }, 120_000);
});

describe("#138 RF-2b (TL-1 F2): the takeover CONVERGES, it does not merely claim", () => {
  // RF-2 proves ownership: worker 2 wins the row, worker 1 gets LeaseLostError, the
  // attempt count reaches 2. Every one of those assertions is green against a worker
  // that takes the job and then applies NOTHING — the row changes hands and no work
  // happens. That is the failure this slice exists to prevent, so it needs a test
  // that runs the handler and measures what it wrote.
  //
  // The measurement is `policy_versions`, for the reason #134 RF-2 uses it: a
  // membership change is only real if the version bumped, because that bump is what
  // invalidates the caches that decide access. And the delta is asserted EXACTLY.
  // "More than before" is green for a takeover that re-applies everything (which
  // `addGroupMember`'s upsert makes silently possible — #134's residual 2: the counts
  // are calls, not net changes) and green for one that applies one row of five. Only
  // the exact number separates converged from busy.

  const PROVIDER = `lark-rf2b-${dbSuffix}`;
  const TOTAL = 5;
  const APPLIED_BEFORE_DEATH = 2;

  const principal = (i) => ({
    provider: PROVIDER,
    subject: `rf2b-u${i}-${dbSuffix}`,
    email: `rf2b-u${i}-${dbSuffix}@corp.example.com`,
    emailVerified: false,
    active: true,
    displayName: `rf2b-u${i}`,
    groupExternalIds: [`rf2b-dept-${dbSuffix}`],
    revision: null,
  });

  const department = {
    provider: PROVIDER,
    externalId: `rf2b-dept-${dbSuffix}`,
    name: `rf2b-dept-${dbSuffix}`,
    memberExternalIds: [],
  };

  // A driver, not a hand-built enumeration: `enumerateDirectory` is the only producer
  // of the branded complete value (#134 R2), so driving the real path is also what
  // keeps this test honest about what worker 2 actually runs.
  const driver = {
    listPrincipals: async () => ({
      principals: Array.from({ length: TOTAL }, (_, i) => principal(i)),
      hasMore: false,
      nextCursor: null,
    }),
    listGroups: async () => ({
      groups: [department],
      hasMore: false,
      nextCursor: null,
    }),
  };

  test("worker 2 applies EXACTLY the work worker 1 did not, and no more", async () => {
    const type = directorySyncTypeFor(PROVIDER);
    const job = await enqueue(type, {
      payload: JSON.stringify({ version: 1, provider: PROVIDER }),
    });

    // ---- worker 1 claims, does part of the work, and dies -------------------
    // A short lease with no heartbeat is what a KILLED process looks like from the
    // database's side (RF-2's measured reason for not modelling a stalled one).
    const queue = new PostgresJobQueue({ db: prisma });
    const first = await queue.claim({
      workerId: "w-1",
      types: [type],
      leaseMs: 50,
      limit: 1,
    });
    expect(first).toHaveLength(1);

    // The partial state is produced by APPLYING a trimmed plan, which is what a crash
    // inside the membership loop leaves behind: per-entity transactions mean the
    // earlier entries are committed and no checkpoint was ever written (#134 R5).
    const enumeration = await enumerateDirectory(driver);
    const fullPlan = diffDirectory({
      enumeration,
      current: { users: [], groups: [], memberships: [] },
    });
    expect(fullPlan.refused).toBe(false);
    expect(fullPlan.addMembership).toHaveLength(TOTAL);

    await applyDirectoryPlan({
      plan: {
        ...fullPlan,
        addMembership: fullPlan.addMembership.slice(0, APPLIED_BEFORE_DEATH),
      },
      actor: CORE_JOBS,
      provider: PROVIDER,
      db: prisma,
    });

    // ---- the baseline, captured AFTER the partial work ----------------------
    // Before it, the delta would include worker 1's own bumps and this test would
    // pass for a takeover that did nothing at all.
    const versionsBefore = await prisma.policy_versions.count();
    const outboxBefore = await prisma.event_outbox.count();
    const membersBefore = await prisma.group_members.count({
      where: { groups: { source: PROVIDER } },
    });
    expect(membersBefore).toBe(APPLIED_BEFORE_DEATH);

    // ---- worker 2 takes over and runs the handler ---------------------------
    await new Promise((r) => setTimeout(r, 120));
    const second = await queue.claim({
      workerId: "w-2",
      types: [type],
      leaseMs: leaseMsFor(type),
      limit: 1,
    });
    expect(second).toHaveLength(1);
    expect(second[0].jobId).toBe(job.id);

    const checkpoint = await runDirectorySync({
      provider: PROVIDER,
      actor: CORE_JOBS,
      driver,
      db: prisma,
    });

    // ---- what "converged" means, as an exact number -------------------------
    const remaining = TOTAL - APPLIED_BEFORE_DEATH;
    expect(await prisma.policy_versions.count()).toBe(versionsBefore + remaining);
    // The outbox moves with it: the bump publishes inside the same transaction, so a
    // version without its event would be a cache nothing ever corrects.
    expect(await prisma.event_outbox.count()).toBe(outboxBefore + remaining);
    expect(checkpoint.membershipsAdded).toBe(remaining);
    expect(checkpoint.status).toBe("completed");

    // And the org ended in the state the directory describes — the point of the run,
    // which a delta alone does not establish. Both limits, because they fail in
    // opposite directions: TOTAL rows means the takeover finished the work, and the
    // PK on (group_id, user_id) means it did not double-write what worker 1 did.
    const rows = await prisma.group_members.findMany({
      where: { groups: { source: PROVIDER } },
      select: { group_id: true, user_id: true },
    });
    expect(rows).toHaveLength(TOTAL);
    expect(new Set(rows.map((r) => `${r.group_id}:${r.user_id}`)).size).toBe(TOTAL);

    // QA-1 read this end state as the ONLY convergence witness, holding that
    // `policy_versions` cannot discriminate because `addGroupMember` bumps
    // unconditionally on an upsert. The mechanism is right and the conclusion is not,
    // measured with mutant MB (worker 2 re-derives from an EMPTY current state, so it
    // re-applies all five): the version delta came back 18 against an expected 16 and
    // the assertion above went red. An unconditional bump is exactly what makes the
    // count sensitive to redundant work — what would hide it is asserting "more than
    // before" instead of an exact delta. Kept as a pair rather than a replacement:
    // the delta sees redundant WRITES, these rows see a broken end STATE, and neither
    // implies the other.

    // The old worker stayed locked out while all of that happened. RF-2 pins this on
    // an idle job; here it is pinned ACROSS a real apply, which is the case that
    // matters — two workers writing memberships at once is what the lease prevents.
    await expect(
      queue.heartbeat({ jobId: job.id, workerId: "w-1", leaseMs: 30_000 })
    ).rejects.toThrow(LeaseLostError);

    // The checkpoint's `id` is a BIGINT and the queue serialises `result` as JSON, so
    // the job completes with the run's summary rather than with the row object.
    await queue.complete({
      jobId: job.id,
      workerId: "w-2",
      result: {
        status: checkpoint.status,
        membershipsAdded: checkpoint.membershipsAdded,
      },
    });
    const done = await prisma.jobs.findUniqueOrThrow({ where: { id: job.id } });
    expect(done.state).toBe("completed");
  }, 180_000);

  test("RF-2b control: a THIRD run applies nothing, so the delta above WAS the work", async () => {
    // Without this, `remaining` could be the number of bumps a converged re-apply
    // produces rather than the number of outstanding changes, and the assertion above
    // would be measuring the upsert instead of the takeover. Note the control is on
    // the PLAN's emptiness, not on the counts alone: #134's residual 2 says
    // `membershipsAdded` counts calls, so zero here means the diff found nothing to
    // do — which is the property "converged" actually names.
    const versionsBefore = await prisma.policy_versions.count();
    const checkpoint = await runDirectorySync({
      provider: PROVIDER,
      actor: CORE_JOBS,
      driver,
      db: prisma,
    });

    expect(checkpoint.membershipsAdded).toBe(0);
    expect(checkpoint.usersCreated).toBe(0);
    expect(checkpoint.groupsCreated).toBe(0);
    expect(await prisma.policy_versions.count()).toBe(versionsBefore);
  }, 180_000);
});

describe("#138 RF-7 (TL-2): a worker that lost its lease cannot still WRITE", () => {
  // TL-2's finding, and the one that goes to this slice's stated purpose. Losing the
  // lease is discovered at `complete()` — by which time the handler has run to the end
  // and its rows are committed. So "worker 2 took over" and "only worker 2 wrote" are
  // different claims, and RF-2/RF-2b only established the first: they let worker 1 die
  // BEFORE doing anything else, which is the easy case.
  //
  // The hard case is a worker that is slow rather than dead — a long GC pause, a
  // stalled socket, a container throttled to a fraction of a CPU. Its lease expires,
  // another worker takes the job and finishes it, and then the first one wakes up and
  // carries on writing into a directory that has already been reconciled.

  const PROVIDER = `lark-rf7-${dbSuffix}`;
  const TOTAL = 4;

  const principal = (i) => ({
    provider: PROVIDER,
    subject: `rf7-u${i}-${dbSuffix}`,
    email: `rf7-u${i}-${dbSuffix}@corp.example.com`,
    emailVerified: false,
    active: true,
    displayName: `rf7-u${i}`,
    groupExternalIds: [`rf7-dept-${dbSuffix}`],
    revision: null,
  });

  const department = {
    provider: PROVIDER,
    externalId: `rf7-dept-${dbSuffix}`,
    name: `rf7-dept-${dbSuffix}`,
    memberExternalIds: [],
  };

  const driver = {
    listPrincipals: async () => ({
      principals: Array.from({ length: TOTAL }, (_, i) => principal(i)),
      hasMore: false,
      nextCursor: null,
    }),
    listGroups: async () => ({
      groups: [department],
      hasMore: false,
      nextCursor: null,
    }),
  };

  test("worker 1, resuming after its lease expired, is REFUSED its remaining writes", async () => {
    const type = directorySyncTypeFor(PROVIDER);
    const job = await enqueue(type, {
      payload: JSON.stringify({ version: 1, provider: PROVIDER }),
    });

    const queue = new PostgresJobQueue({ db: prisma });
    const first = await queue.claim({
      workerId: "w-slow",
      types: [type],
      leaseMs: 60, // expires while it is still working, with no heartbeat to renew
      limit: 1,
    });
    expect(first).toHaveLength(1);

    // Worker 1's plan, derived while it still held the lease — which is exactly what a
    // slow worker has in hand when it stalls.
    const enumeration = await enumerateDirectory(driver);
    const plan = diffDirectory({
      enumeration,
      current: { users: [], groups: [], memberships: [] },
    });
    expect(plan.addMembership).toHaveLength(TOTAL);

    // The pause is INSIDE the apply, between entities, and it outlives the lease. The
    // latch releases only after worker 2 has finished, so the interleaving is asserted
    // rather than raced: worker 1 genuinely resumes into a completed job.
    let released;
    const worker2Done = new Promise((r) => (released = r));
    let entitiesSeen = 0;
    let pausedAfter = 0;

    const slowApply = applyDirectoryPlan({
      plan,
      actor: CORE_JOBS,
      provider: PROVIDER,
      db: prisma,
      lease: {
        workerId: "w-slow",
        jobId: job.id,
        // The seam the guard is called through. Pausing here — the point between two
        // entity writes — is what a stalled worker looks like from the outside.
        beforeEntity: async () => {
          entitiesSeen += 1;
          if (entitiesSeen === 2) {
            pausedAfter = entitiesSeen;
            await worker2Done;
          }
        },
      },
    }).catch((error) => error);

    // Let worker 1 reach the pause and its lease expire.
    await new Promise((r) => setTimeout(r, 200));
    expect(pausedAfter).toBe(2);

    // ---- worker 2 takes over and finishes the whole job --------------------
    const second = await queue.claim({
      workerId: "w-fast",
      types: [type],
      leaseMs: leaseMsFor(type),
      limit: 1,
    });
    expect(second).toHaveLength(1);

    await runDirectorySync({
      provider: PROVIDER,
      actor: CORE_JOBS,
      driver,
      db: prisma,
    });
    const afterWorker2 = await prisma.group_members.count({
      where: { groups: { source: PROVIDER } },
    });
    expect(afterWorker2).toBe(TOTAL);

    const versionsAfterWorker2 = await prisma.policy_versions.count();

    // ---- worker 1 wakes up -------------------------------------------------
    released();
    const outcome = await slowApply;

    // It must be REFUSED, and it must find out at the WRITE, not at completion. A
    // LeaseLostError here is the whole finding: the alternative is that its remaining
    // writes land in a directory another worker already reconciled.
    expect(outcome).toBeInstanceOf(LeaseLostError);

    // And nothing of worker 1's moved after it lost the lease — asserted on the
    // version count, because an idempotent re-write is invisible in the row count
    // while still being a write (and a cache invalidation, and an outbox event).
    expect(await prisma.policy_versions.count()).toBe(versionsAfterWorker2);
    expect(
      await prisma.group_members.count({ where: { groups: { source: PROVIDER } } })
    ).toBe(TOTAL);
  }, 180_000);

  test("RF-7b: the guard permits a worker that still HOLDS its lease", async () => {
    // The control, and the reason the test above is not green for a guard that refuses
    // everyone. Same code path, same seam, an unexpired lease — and it applies.
    const PROVIDER_OK = `lark-rf7b-${dbSuffix}`;
    const okDriver = {
      listPrincipals: async () => ({
        principals: [
          {
            provider: PROVIDER_OK,
            subject: `rf7b-u0-${dbSuffix}`,
            email: `rf7b-u0-${dbSuffix}@corp.example.com`,
            emailVerified: false,
            active: true,
            displayName: "rf7b-u0",
            groupExternalIds: [`rf7b-dept-${dbSuffix}`],
            revision: null,
          },
        ],
        hasMore: false,
        nextCursor: null,
      }),
      listGroups: async () => ({
        groups: [
          {
            provider: PROVIDER_OK,
            externalId: `rf7b-dept-${dbSuffix}`,
            name: `rf7b-dept-${dbSuffix}`,
            memberExternalIds: [],
          },
        ],
        hasMore: false,
        nextCursor: null,
      }),
    };

    const type = directorySyncTypeFor(PROVIDER_OK);
    const job = await enqueue(type, {
      payload: JSON.stringify({ version: 1, provider: PROVIDER_OK }),
    });
    const queue = new PostgresJobQueue({ db: prisma });
    await queue.claim({
      workerId: "w-live",
      types: [type],
      leaseMs: leaseMsFor(type),
      limit: 1,
    });

    const enumeration = await enumerateDirectory(okDriver);
    const plan = diffDirectory({
      enumeration,
      current: { users: [], groups: [], memberships: [] },
    });

    const checkpoint = await applyDirectoryPlan({
      plan,
      actor: CORE_JOBS,
      provider: PROVIDER_OK,
      db: prisma,
      lease: { workerId: "w-live", jobId: job.id },
    });

    expect(checkpoint.status).toBe("completed");
    expect(checkpoint.membershipsAdded).toBe(1);
    expect(
      await prisma.group_members.count({ where: { groups: { source: PROVIDER_OK } } })
    ).toBe(1);
  }, 180_000);
});

describe("#138 RF-8 (TL-2 NIT): an EXPIRED lease cannot be renewed, takeover or not", () => {
  test("the original worker's heartbeat is refused once its lease has expired", async () => {
    // RF-2 asserts a heartbeat is refused AFTER another worker took the job — which is
    // green on `workerId` alone, since the row now names someone else. So dropping
    // `leaseUntil: { gt: now }` from the heartbeat predicate survives RF-2 entirely.
    //
    // This is the case that separates them: NOBODY has taken over, the row still names
    // w-1, and only the expiry makes the renewal wrong. It must be, or a worker that
    // stalled past its lease could quietly reclaim it and go on writing — which is
    // RF-7's failure reached by a different door.
    const type = `directory.sync:lark-rf8-${dbSuffix}`;
    const job = await enqueue(type);

    const queue = new PostgresJobQueue({ db: prisma });
    const claimed = await queue.claim({
      workerId: "w-1",
      types: [type],
      leaseMs: 50,
      limit: 1,
    });
    expect(claimed).toHaveLength(1);

    // The premise: the row still belongs to w-1. Without this the test could pass for
    // the wrong reason on some future claim that clears the worker.
    const before = await prisma.jobs.findUniqueOrThrow({ where: { id: job.id } });
    expect(before.workerId).toBe("w-1");

    await new Promise((r) => setTimeout(r, 120));

    await expect(
      queue.heartbeat({ jobId: job.id, workerId: "w-1", leaseMs: 30_000 })
    ).rejects.toThrow(LeaseLostError);

    // The control, on the same job before expiry, so this is not green for a heartbeat
    // that refuses everything.
    const fresh = await enqueue(`directory.sync:lark-rf8b-${dbSuffix}`);
    await queue.claim({
      workerId: "w-1",
      types: [fresh.type],
      leaseMs: 30_000,
      limit: 1,
    });
    await expect(
      queue.heartbeat({ jobId: fresh.id, workerId: "w-1", leaseMs: 30_000 })
    ).resolves.not.toThrow();
  }, 120_000);
});

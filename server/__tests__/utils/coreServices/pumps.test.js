const { PostgresJobScheduler } = require("../../../utils/jobs/PostgresJobScheduler");
const { OutboxPump } = require("../../../utils/events/OutboxPump");

test("scheduler takes transaction advisory lock and materializes idempotent occurrence", async () => {
  const now = new Date("2026-09-02T00:00:00Z");
  const tx = {
    $queryRawUnsafe: jest.fn(),
    job_schedules: {
      findMany: jest.fn().mockResolvedValue([{ id: "daily", type: "purge", cron: "0 1 * * *", nextRunAt: now, payload: "{}", actor: "{}" }]),
      update: jest.fn(),
    },
    jobs: { upsert: jest.fn() },
  };
  const scheduler = new PostgresJobScheduler({ db: { $transaction: (fn) => fn(tx) }, now: () => now });
  expect(await scheduler.materialize()).toEqual({ queued: 1 });
  expect(tx.$queryRawUnsafe).toHaveBeenCalledWith("SELECT pg_advisory_xact_lock($1)", 1_347_579);
  expect(tx.jobs.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { type_idempotencyKey: { type: "purge", idempotencyKey: `daily:${now.toISOString()}` } } }));
});

test("outbox pump recovers existing durable events immediately on start and stops", async () => {
  jest.useFakeTimers(); const bus = { deliver: jest.fn().mockResolvedValue() };
  const pump = new OutboxPump({ bus, intervalMs: 1000 });
  pump.start(); await Promise.resolve(); expect(bus.deliver).toHaveBeenCalledTimes(1);
  await pump.stop(); expect(jest.getTimerCount()).toBe(0); jest.useRealTimers();
});


test("scheduler honors schedule timezone when calculating next occurrence", () => {
  const scheduler = new PostgresJobScheduler({ db: {} });
  expect(scheduler.nextRun("0 9 * * *", new Date("2026-09-02T00:00:00Z"), "Asia/Bangkok").toISOString()).toBe("2026-09-02T02:00:00.000Z");
});

const prisma = require("../../../utils/prisma");
const { PostgresJobScheduler } = require("../../../utils/jobs/PostgresJobScheduler");

const run = process.env.DATABASE_URL?.startsWith("postgresql://") ? describe : describe.skip;

run("PostgresJobScheduler PostgreSQL integration", () => {
  beforeEach(async () => {
    await prisma.job_schedules.updateMany({ data: { enabled: false } });
  });
  afterAll(() => prisma.$disconnect());

  test("takes advisory lock, materializes once, advances timezone schedule, and ticks cleanly", async () => {
    const now = new Date("2026-09-02T00:00:00.000Z");
    await prisma.jobs.deleteMany({ where: { type: "integration.scheduler" } });
    await prisma.job_schedules.upsert({
      where: { id: "integration-bangkok" },
      create: {
        id: "integration-bangkok", type: "integration.scheduler", cron: "0 9 * * *", timezone: "Asia/Bangkok",
        payload: JSON.stringify({ version: 1 }), actor: JSON.stringify({ type: "service", id: "test", orgId: "test" }), enabled: true,
      },
      update: { nextRunAt: null, enabled: true },
    });
    const scheduler = new PostgresJobScheduler({ db: prisma, now: () => now });
    await expect(scheduler.materialize()).resolves.toEqual({ queued: 1 });
    const schedule = await prisma.job_schedules.findUnique({ where: { id: "integration-bangkok" } });
    expect(schedule.nextRunAt.toISOString()).toBe("2026-09-02T02:00:00.000Z");
    await expect(scheduler.materialize()).resolves.toEqual({ queued: 0 });
    expect(await prisma.jobs.count({ where: { type: "integration.scheduler" } })).toBe(1);
  });

  test("two scheduler instances advance one occurrence exactly once", async () => {
    const now = new Date("2026-09-02T00:00:00.000Z");
    await prisma.jobs.deleteMany({ where: { type: "integration.concurrent" } });
    await prisma.job_schedules.upsert({
      where: { id: "integration-concurrent" },
      create: {
        id: "integration-concurrent", type: "integration.concurrent", cron: "0 9 * * *", timezone: "Asia/Bangkok",
        payload: JSON.stringify({ version: 1 }), actor: JSON.stringify({ type: "service", id: "test", orgId: "test" }), enabled: true,
        nextRunAt: now,
      },
      update: { nextRunAt: now, enabled: true },
    });
    const first = new PostgresJobScheduler({ db: prisma, now: () => now });
    const second = new PostgresJobScheduler({ db: prisma, now: () => now });
    await expect(Promise.all([first.materialize(), second.materialize()])).resolves.toEqual(
      expect.arrayContaining([{ queued: 1 }, { queued: 0 }])
    );
    const schedule = await prisma.job_schedules.findUnique({ where: { id: "integration-concurrent" } });
    expect(schedule.nextRunAt.toISOString()).toBe("2026-09-02T02:00:00.000Z");
    expect(await prisma.jobs.count({ where: { type: "integration.concurrent" } })).toBe(1);
  });

  test("overdue schedule catches up once then advances from current time", async () => {
    const now = new Date("2026-09-05T00:00:00.000Z");
    await prisma.jobs.deleteMany({ where: { type: "integration.catchup" } });
    await prisma.job_schedules.upsert({
      where: { id: "integration-catchup" },
      create: {
        id: "integration-catchup", type: "integration.catchup", cron: "0 9 * * *", timezone: "Asia/Bangkok",
        payload: JSON.stringify({ version: 1 }), actor: JSON.stringify({ type: "service", id: "test", orgId: "test" }), enabled: true,
        nextRunAt: new Date("2026-09-02T02:00:00.000Z"),
      },
      update: { nextRunAt: new Date("2026-09-02T02:00:00.000Z"), enabled: true },
    });
    const scheduler = new PostgresJobScheduler({ db: prisma, now: () => now });
    await expect(scheduler.materialize()).resolves.toEqual({ queued: 1 });
    const schedule = await prisma.job_schedules.findUnique({ where: { id: "integration-catchup" } });
    expect(schedule.nextRunAt.toISOString()).toBe("2026-09-05T02:00:00.000Z");
    await expect(scheduler.materialize()).resolves.toEqual({ queued: 0 });
    expect(await prisma.jobs.count({ where: { type: "integration.catchup" } })).toBe(1);
  });

});

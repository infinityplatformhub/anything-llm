const crypto = require("crypto");
const later = require("@breejs/later");
const prisma = require("../prisma");

later.date.UTC();

class PostgresJobScheduler {
  constructor({ db = prisma, now = () => new Date() } = {}) {
    this.db = db;
    this.now = now;
    this.timer = null;
    this.running = false;
  }

  nextRun(cron, after) {
    const schedule = later.parse.cron(cron);
    return later.schedule(schedule).next(1, after);
  }

  start(intervalMs = 60_000, onError = console.error) {
    if (this.timer) return;
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try { await this.materialize(); } catch (error) { onError(error); } finally { this.running = false; }
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async materialize(limit = 100) {
    const now = this.now();
    return this.db.$transaction(async (tx) => {
      if (typeof tx.$queryRawUnsafe === "function") {
        await tx.$queryRawUnsafe("SELECT pg_advisory_xact_lock($1)", 1_347_579);
      }
      const schedules = await tx.job_schedules.findMany({
        where: { enabled: true, OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] },
        orderBy: { nextRunAt: "asc" },
        take: limit,
      });
      let queued = 0;
      for (const schedule of schedules) {
        const runAt = schedule.nextRunAt || now;
        const idempotencyKey = `${schedule.id}:${runAt.toISOString()}`;
        await tx.jobs.upsert({
          where: { type_idempotencyKey: { type: schedule.type, idempotencyKey } },
          create: {
            id: crypto.randomUUID(), type: schedule.type, payload: schedule.payload, actor: schedule.actor,
            runAt, maxAttempts: 3, idempotencyKey, traceId: crypto.randomUUID(),
          },
          update: {},
        });
        await tx.job_schedules.update({
          where: { id: schedule.id },
          data: { nextRunAt: this.nextRun(schedule.cron, new Date(runAt.getTime() + 1)) },
        });
        queued += 1;
      }
      return { queued };
    });
  }
}

module.exports = { PostgresJobScheduler };

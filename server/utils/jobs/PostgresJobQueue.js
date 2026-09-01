const crypto = require("crypto");
const prisma = require("../prisma");

const serialize = (value) => JSON.stringify(value ?? {});
const parse = (value) => JSON.parse(value || "{}");
const asJob = (row) => ({
  jobId: row.id,
  type: row.type,
  payload: parse(row.payload),
  actor: parse(row.actor),
  runAt: row.runAt,
  attempts: row.attempts,
  maxAttempts: row.maxAttempts,
  idempotencyKey: row.idempotencyKey,
  traceId: row.traceId,
});

class PostgresJobQueue {
  constructor({ db = prisma, now = () => new Date(), random = Math.random } = {}) {
    this.db = db;
    this.now = now;
    this.random = random;
  }

  async enqueue(input) {
    const existing = await this.db.jobs.findUnique({
      where: { type_idempotencyKey: { type: input.type, idempotencyKey: input.idempotencyKey } },
    });
    if (existing) return asJob(existing);
    const row = await this.db.jobs.create({
      data: {
        id: crypto.randomUUID(),
        type: input.type,
        payload: serialize(input.payload),
        actor: serialize(input.actor),
        runAt: input.runAt || this.now(),
        maxAttempts: input.maxAttempts || 3,
        idempotencyKey: input.idempotencyKey,
        traceId: input.traceId,
      },
    });
    return asJob(row);
  }

  async schedule(input) {
    await this.db.job_schedules.upsert({
      where: { id: input.scheduleId },
      create: {
        id: input.scheduleId,
        type: input.type,
        cron: input.cron,
        timezone: input.timezone,
        payload: serialize(input.payload),
        actor: serialize(input.actor),
        enabled: input.enabled,
      },
      update: {
        type: input.type,
        cron: input.cron,
        timezone: input.timezone,
        payload: serialize(input.payload),
        actor: serialize(input.actor),
        enabled: input.enabled,
      },
    });
  }

  async claim({ workerId, types, leaseMs, limit }) {
    return this.db.$transaction(async (tx) => {
      const now = this.now();
      const candidates = await tx.jobs.findMany({
        where: {
          type: { in: types },
          runAt: { lte: now },
          OR: [{ state: "pending" }, { state: "running", leaseUntil: { lt: now } }],
        },
        orderBy: { runAt: "asc" },
        take: limit,
      });
      const claimed = [];
      for (const job of candidates) {
        const leaseUntil = new Date(now.getTime() + leaseMs);
        const result = await tx.jobs.updateMany({
          where: {
            id: job.id,
            OR: [{ state: "pending" }, { state: "running", leaseUntil: { lt: now } }],
          },
          data: { state: "running", workerId, leaseUntil, attempts: { increment: 1 } },
        });
        if (result.count === 1) {
          claimed.push(asJob({ ...job, state: "running", workerId, leaseUntil, attempts: Number(job.attempts) }));
        }
      }
      return claimed;
    });
  }

  async complete({ jobId, workerId, result }) {
    const updated = await this.db.jobs.updateMany({
      where: { id: jobId, workerId, state: "running", leaseUntil: { gt: this.now() } },
      data: { state: "completed", result: serialize(result), workerId: null, leaseUntil: null },
    });
    if (!updated.count) throw new Error("Job lease lost");
  }

  async fail({ jobId, workerId, error, retryAt }) {
    return this.db.$transaction(async (tx) => {
      const job = await tx.jobs.findFirst({
        where: { id: jobId, workerId, state: "running", leaseUntil: { gt: this.now() } },
      });
      if (!job) throw new Error("Job lease lost");
      const retryable = error?.retryable !== false;
      if (retryable && job.attempts < job.maxAttempts) {
        const delay = Math.min(60_000 * 2 ** (job.attempts - 1), 3_600_000);
        const jitter = Math.floor(delay * 0.2 * this.random());
        await tx.jobs.update({
          where: { id: jobId },
          data: {
            state: "pending",
            runAt: retryAt || new Date(this.now().getTime() + delay + jitter),
            lastError: serialize({ name: error?.name, message: error?.message, retryable }),
            workerId: null,
            leaseUntil: null,
          },
        });
        return { state: "retrying" };
      }
      await tx.job_dead_letters.create({
        data: {
          jobId: job.id,
          type: job.type,
          payload: job.payload,
          actor: job.actor,
          attempts: job.attempts,
          error: serialize({ name: error?.name, message: error?.message, retryable }),
          traceId: job.traceId,
        },
      });
      await tx.jobs.update({ where: { id: jobId }, data: { state: "dead-lettered", workerId: null, leaseUntil: null } });
      return { state: "dead-lettered" };
    });
  }

  async cancel({ jobId, reason, actor }) {
    const job = await this.db.jobs.findUnique({ where: { id: jobId } });
    if (!job) return;
    await this.db.jobs.update({
      where: { id: jobId },
      data: {
        state: job.state === "running" ? "cancelling" : "cancelled",
        cancelReason: reason,
        cancelledBy: serialize(actor),
      },
    });
  }

  async heartbeat({ jobId, workerId, leaseMs }) {
    const updated = await this.db.jobs.updateMany({
      where: { id: jobId, workerId, state: "running", leaseUntil: { gt: this.now() } },
      data: { leaseUntil: new Date(this.now().getTime() + leaseMs) },
    });
    if (!updated.count) throw new Error("Job lease lost");
  }
}

module.exports = { PostgresJobQueue };

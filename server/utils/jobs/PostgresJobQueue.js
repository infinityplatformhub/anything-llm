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

class LeaseLostError extends Error {}

class PostgresJobQueue {
  constructor({ db = prisma, now = () => new Date(), random = Math.random, publishOperationalEvent } = {}) {
    this.db = db;
    this.now = now;
    this.random = random;
    this.publishOperationalEvent = publishOperationalEvent;
  }

  async enqueue(input) {
    const existing = await this.db.jobs.findUnique({
      where: { type_idempotencyKey: { type: input.type, idempotencyKey: input.idempotencyKey } },
    });
    if (existing) return asJob(existing);
    try {
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
    } catch (error) {
      if (error?.code !== "P2002") throw error;
      const raced = await this.db.jobs.findUnique({
        where: { type_idempotencyKey: { type: input.type, idempotencyKey: input.idempotencyKey } },
      });
      if (!raced) throw error;
      return asJob(raced);
    }
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
        nextRunAt: null,
      },
      update: {
        type: input.type,
        cron: input.cron,
        timezone: input.timezone,
        payload: serialize(input.payload),
        actor: serialize(input.actor),
        enabled: input.enabled,
        nextRunAt: null,
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
          claimed.push(asJob({ ...job, state: "running", workerId, leaseUntil, attempts: Number(job.attempts) + 1 }));
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
    if (!updated.count) throw new LeaseLostError("Job lease lost");
  }

  async fail({ jobId, workerId, error, retryAt }) {
    const now = this.now();
    return this.db.$transaction(async (tx) => {
      const job = await tx.jobs.findFirst({
        where: { id: jobId, workerId, state: "running", leaseUntil: { gt: now } },
      });
      if (!job) throw new LeaseLostError("Job lease lost");
      const leaseWhere = { id: jobId, workerId, state: "running", leaseUntil: job.leaseUntil };
      const retryable = error?.retryable !== false;
      const serializedError = serialize({ name: error?.name, message: error?.message, retryable });
      if (retryable && job.attempts < job.maxAttempts) {
        const delay = Math.min(60_000 * 2 ** (job.attempts - 1), 3_600_000);
        const jitter = Math.floor(delay * 0.2 * this.random());
        const updated = await tx.jobs.updateMany({
          where: leaseWhere,
          data: { state: "pending", runAt: retryAt || new Date(now.getTime() + delay + jitter), lastError: serializedError, workerId: null, leaseUntil: null },
        });
        if (!updated.count) throw new LeaseLostError("Job lease lost");
        return { state: "retrying" };
      }
      const updated = await tx.jobs.updateMany({
        where: leaseWhere,
        data: { state: "dead-lettered", lastError: serializedError, workerId: null, leaseUntil: null },
      });
      if (!updated.count) throw new LeaseLostError("Job lease lost");
      await tx.job_dead_letters.create({
        data: { jobId: job.id, type: job.type, payload: job.payload, actor: job.actor, attempts: job.attempts, error: serializedError, traceId: job.traceId },
      });
      if (this.publishOperationalEvent) {
        await this.publishOperationalEvent({
          type: "job.dead_lettered", actor: parse(job.actor), resource: { type: "job", id: job.id }, traceId: job.traceId,
          data: { jobType: job.type, attempts: job.attempts, errorName: error?.name || "Error" },
        }, tx);
      }
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
    if (!updated.count) throw new LeaseLostError("Job lease lost");
  }
}

module.exports = { PostgresJobQueue, LeaseLostError };

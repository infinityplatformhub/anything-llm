const crypto = require("crypto");
const prisma = require("../prisma");
const { LeaseLostError, ImpersonatedMutationError } = require("./errors");

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

const isMutatingJob = (input) => input.mutating !== false;
const denyImpersonatedMutation = (actor, mutating) => {
  if (actor?.impersonatedBy && mutating) throw new ImpersonatedMutationError("Impersonated actor cannot enqueue or run mutating job");
};

class PostgresJobQueue {
  constructor({
    db = prisma,
    now = () => new Date(),
    random = Math.random,
    publishOperationalEvent,
    // #138: a test seam, in the same spirit as `now`, and needed for the same reason.
    //
    // `claim` decides which worker wins a job, and the window where two claims can
    // race is INSIDE `this.db.$transaction` — between reading the candidate rows and
    // conditionally updating them. A concurrency test cannot open that window from
    // outside: with no seam, the only lever is a sleep, and two runs that never
    // actually overlap pass whatever the claim rule does. That is the fixture-never-
    // reached-the-guard failure, in the one place where it would certify a
    // concurrency guarantee that was never exercised.
    //
    // Awaited between the read and the update, so a test can latch both transactions
    // open at once and assert they were BOTH there (`reached === 2`) rather than
    // hoping. Production passes nothing and the await is on `undefined`.
    afterCandidates,
  } = {}) {
    this.db = db;
    this.now = now;
    this.random = random;
    this.afterCandidates = afterCandidates;
    this.publishOperationalEvent = publishOperationalEvent || ((event, transaction) => require("../events").publishOperationalEvent(event, transaction));
  }

  async enqueue(input) {
    denyImpersonatedMutation(input.actor, isMutatingJob(input));
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
      // #138: the race window opens here — candidates are read, not yet claimed.
      // Called rather than merely accepted: a hook that is stored and never invoked
      // is indistinguishable from no seam at all to every test that depends on it,
      // and would let RF-1 report a concurrency guarantee it never exercised.
      if (this.afterCandidates) await this.afterCandidates(candidates);

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
    const current = await this.db.jobs.findUnique({ where: { id: jobId } });
    const state = current?.state === "cancelling" ? "cancelled" : "completed";
    const updated = await this.db.jobs.updateMany({
      where: { id: jobId, workerId, state: { in: ["running", "cancelling"] }, leaseUntil: { gt: this.now() } },
      data: { state, result: serialize(result), workerId: null, leaseUntil: null },
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
      if (this.publishOperationalEvent && tx.event_outbox) {
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
      where: { id: jobId, workerId, state: { in: ["running", "cancelling"] }, leaseUntil: { gt: this.now() } },
      data: { leaseUntil: new Date(this.now().getTime() + leaseMs) },
    });
    if (!updated.count) throw new LeaseLostError("Job lease lost");
  }
}

module.exports = { PostgresJobQueue, LeaseLostError, ImpersonatedMutationError, denyImpersonatedMutation };

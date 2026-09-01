const { PostgresJobQueue } = require("../../../utils/jobs/PostgresJobQueue");
const { CoreJobWorker } = require("../../../utils/jobs/CoreJobWorker");
const { PostgresEventBus, EventConflictError } = require("../../../utils/events/PostgresEventBus");
const { AuditEventSubscriber } = require("../../../utils/events/AuditEventSubscriber");

function jobDb() {
  const jobs = new Map();
  const dead = [];
  const model = {
    findUnique: async ({ where }) => where.id ? jobs.get(where.id) : [...jobs.values()].find((j) => j.type === where.type_idempotencyKey.type && j.idempotencyKey === where.type_idempotencyKey.idempotencyKey),
    create: async ({ data }) => (jobs.set(data.id, { state: "pending", attempts: 0, ...data }), jobs.get(data.id)),
    findMany: async ({ where, take }) => [...jobs.values()].filter((j) => where.type.in.includes(j.type) && j.runAt <= where.runAt.lte && (j.state === "pending" || (j.state === "running" && j.leaseUntil < where.OR[1].state.leaseUntil.lt))).slice(0, take),
    findFirst: async ({ where }) => [...jobs.values()].find((j) => j.id === where.id && j.workerId === where.workerId && j.state === where.state && j.leaseUntil > where.leaseUntil.gt),
    updateMany: async ({ where, data }) => {
      const j = jobs.get(where.id); if (!j || (where.workerId && j.workerId !== where.workerId) || (where.state && j.state !== where.state) || (where.leaseUntil?.gt && !(j.leaseUntil > where.leaseUntil.gt))) return { count: 0 };
      const increment = data.attempts?.increment; const previousAttempts = j.attempts; Object.assign(j, data); if (increment) j.attempts = previousAttempts + increment; return { count: 1 };
    },
    update: async ({ where, data }) => (Object.assign(jobs.get(where.id), data), jobs.get(where.id)),
  };
  const db = { jobs: model, job_dead_letters: { create: async ({ data }) => (dead.push(data), data) }, job_schedules: { upsert: jest.fn() } };
  db.$transaction = async (fn) => fn(db);
  return { db, jobs, dead };
}

function eventDb() {
  const outbox = new Map(); const deliveries = new Map(); const logs = [];
  const key = (w) => `${w.subscriberId_eventId.subscriberId}:${w.subscriberId_eventId.eventId}`;
  return {
    outbox, deliveries, logs,
    db: {
      event_outbox: {
        findUnique: async ({ where }) => outbox.get(where.id), create: async ({ data }) => (outbox.set(data.id, data), data),
        findMany: async () => [...outbox.values()],
      },
      event_deliveries: {
        findUnique: async ({ where }) => deliveries.get(key(where)),
        upsert: async ({ where, create, update }) => { const k = key(where); const row = { ...(deliveries.get(k) || create), ...(deliveries.has(k) ? update : {}) }; deliveries.set(k, row); return row; },
        deleteMany: async ({ where }) => { deliveries.delete(`${where.subscriberId}:${where.eventId}`); },
      },
      event_logs: { create: async ({ data }) => (logs.push(data), data) },
    },
  };
}

const actor = { type: "service", id: "svc", orgId: "org" };

test("job lifecycle enqueues, claims, retries, then dead-letters", async () => {
  const { db, jobs, dead } = jobDb(); let now = new Date("2026-09-02T00:00:00Z");
  const queue = new PostgresJobQueue({ db, now: () => now, random: () => 0 });
  const job = await queue.enqueue({ type: "test", payload: { version: 1 }, actor, maxAttempts: 2, idempotencyKey: "one", traceId: "trace" });
  expect(jobs.get(job.jobId).state).toBe("pending");
  expect((await queue.claim({ workerId: "w", types: ["test"], leaseMs: 1000, limit: 1 }))[0].attempts).toBe(1);
  expect(await queue.fail({ jobId: job.jobId, workerId: "w", error: new Error("retry"), retryAt: now })).toEqual({ state: "retrying" });
  await queue.claim({ workerId: "w", types: ["test"], leaseMs: 1000, limit: 1 });
  expect(await queue.fail({ jobId: job.jobId, workerId: "w", error: new Error("stop") })).toEqual({ state: "dead-lettered" });
  expect(dead).toHaveLength(1); expect(jobs.get(job.jobId).state).toBe("dead-lettered");
});

test("worker rehydrates active actor and fails closed for deactivated actor", async () => {
  const queue = { claim: jest.fn().mockResolvedValue([{ jobId: "1", actor, payload: { version: 1 } }]), fail: jest.fn() };
  const worker = new CoreJobWorker({ queue, identityStore: { resolveActor: async () => ({ id: "svc", active: false }) }, handlers: {} });
  expect(await worker.claim({ workerId: "w" })).toEqual([]);
  expect(queue.fail).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ retryable: false }) }));
});

test("outbox retries but subscriber effect remains exactly once after acknowledgement", async () => {
  const state = eventDb(); const bus = new PostgresEventBus({ db: state.db }); let effects = 0;
  await bus.subscribe({ subscriberId: "s", eventTypes: ["created"], handler: async () => { effects += 1; } });
  const event = { eventId: "e", type: "created", version: 1, occurredAt: new Date(), actor, resource: { type: "x", id: "1" }, traceId: "t", data: {}, sensitivity: "metadata" };
  await bus.publish({ event }); await bus.publish({ event }); await bus.deliver(); await bus.deliver();
  expect(effects).toBe(1);
  await expect(bus.publish({ event: { ...event, data: { changed: true } } })).rejects.toBeInstanceOf(EventConflictError);
});

test("audit subscriber preserves legacy event row fields", async () => {
  const state = eventDb(); const subscriber = new AuditEventSubscriber({ db: state.db }); const occurredAt = new Date();
  await subscriber.handle({ type: "login_event", data: { ip: "127.0.0.1" }, actor: { type: "user", id: "7" }, occurredAt });
  expect(state.logs[0]).toEqual({ event: "login_event", metadata: JSON.stringify({ ip: "127.0.0.1" }), userId: 7, occurredAt });
});

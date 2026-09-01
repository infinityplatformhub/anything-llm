const { PostgresJobQueue } = require("./PostgresJobQueue");
const { PostgresJobScheduler } = require("./PostgresJobScheduler");
const { CoreJobWorker } = require("./CoreJobWorker");
const { ActorIdentityStore } = require("./ActorIdentityStore");
const { handlers, registerCoreSchedules } = require("./handlers");

const systemActor = { type: "service", id: "core-jobs", orgId: "default" };

class JobRuntime {
  constructor({ queue = new PostgresJobQueue(), scheduler = new PostgresJobScheduler(), identityStore = new ActorIdentityStore(), intervalMs = 1000 } = {}) {
    this.queue = queue;
    this.scheduler = scheduler;
    this.worker = new CoreJobWorker({ queue, identityStore, handlers });
    this.intervalMs = intervalMs;
    this.timer = null;
    this.running = false;
  }

  async start() {
    if (this.timer) return;
    await registerCoreSchedules(this.queue, systemActor);
    await this.queue.enqueue({ type: "telemetry.flush", payload: { version: 1 }, actor: systemActor, idempotencyKey: `telemetry-flush:${new Date().toISOString().slice(0, 10)}`, traceId: "boot" });
    this.scheduler.start();
    await this.tick();
    this.timer = setInterval(() => this.tick().catch(console.error), this.intervalMs);
    this.timer.unref?.();
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const jobs = await this.worker.claim({ workerId: `core-${process.pid}`, types: Object.keys(handlers).map((key) => key.split("@")[0]), leaseMs: 30_000, limit: 10 });
      await Promise.allSettled(jobs.map((job) => this.worker.run(job, `core-${process.pid}`, { leaseMs: 30_000 })));
    } finally {
      this.running = false;
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.scheduler.stop();
  }
}

const jobRuntime = new JobRuntime();
module.exports = { JobRuntime, jobRuntime, systemActor };

const { PostgresJobQueue } = require("./PostgresJobQueue");
const { PostgresJobScheduler } = require("./PostgresJobScheduler");
const { CoreJobWorker } = require("./CoreJobWorker");
const { handlers, registerCoreSchedules, leaseMsFor } = require("./handlers");
// T-2 (#20): service Actor literals live only in utils/authorization/actorResolver.js
// T-4b (#29) W-5: and so does Actor construction — resolveActorRef replaced the local
// ActorIdentityStore, so a job and an HTTP request resolve the same user identically.
// Hotfix #39: but the CONSTANTS come from the leaf module. actorResolver sits inside a
// require cycle, so importing SERVICE_PRINCIPALS through it yields undefined depending
// on load order — see utils/authorization/principals.js. Two imports on purpose:
// taking either side alone loses a working feature.
const { SERVICE_PRINCIPALS } = require("../authorization/principals");
const { resolveActorRef } = require("../authorization/actorResolver");

const systemActor = SERVICE_PRINCIPALS.coreJobs;

class JobRuntime {
  constructor({ queue = new PostgresJobQueue(), scheduler = new PostgresJobScheduler(), identityStore = { resolveActor: resolveActorRef }, intervalMs = 1000 } = {}) {
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
      // #138: the lease comes from the job TYPE, not from this line.
      //
      // One `claim` call covers every registered type, so it takes the LONGEST lease
      // of the types it is asking for. That is the safe direction: a lease too long
      // delays takeover of a genuinely dead worker, while a lease too short lets a
      // second worker claim a job whose first worker is alive and mid-run — a
      // concurrent apply, which for the directory sync is the failure the whole
      // slice exists to prevent. Each job's own lease is then applied on `run`,
      // where the type is known exactly.
      //
      // THE CONSEQUENCE, stated because it is surprising and RF-6 pins it: every job
      // claimed in a tick wears the MAXIMUM lease until its own first heartbeat, not
      // just the directory sync. Registering `directory.sync` therefore lengthened
      // `telemetry.flush`'s initial lease from 30s to 160s. It self-corrects — the
      // heartbeat on `run` renews at that job's own `leaseMs / 2`, so the row carries
      // the right value within seconds — but between claim and first beat, a
      // telemetry job whose worker is killed stays unclaimable for the sync's lease.
      //
      // Accepted rather than fixed by claiming per type. Splitting the claim into one
      // call per lease class would trade one over-long lease on a cheap, idempotent
      // job for several transactions per tick and a second place where the type-to-
      // lease mapping has to be right. If a job type ever appears whose delayed
      // takeover genuinely costs something, that is the point to split it — not now,
      // on a flush that can be re-run for free.
      const types = Object.keys(handlers).map((key) => key.split("@")[0]);
      const claimLeaseMs = Math.max(...types.map(leaseMsFor));
      const jobs = await this.worker.claim({ workerId: `core-${process.pid}`, types, leaseMs: claimLeaseMs, limit: 10 });
      await Promise.allSettled(
        jobs.map((job) =>
          this.worker.run(job, `core-${process.pid}`, { leaseMs: leaseMsFor(job.type) })
        )
      );
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

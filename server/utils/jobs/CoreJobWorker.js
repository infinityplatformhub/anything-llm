class CoreJobWorker {
  constructor({ queue, identityStore, handlers }) {
    this.queue = queue;
    this.identityStore = identityStore;
    this.handlers = handlers;
  }

  async claim(input) {
    const jobs = await this.queue.claim(input);
    const runnable = [];
    for (const job of jobs) {
      const actor = await this.identityStore.resolveActor(job.actor);
      if (!actor || actor.active === false) {
        await this.queue.fail({
          jobId: job.jobId,
          workerId: input.workerId,
          error: { name: "ActorUnavailableError", message: "Job actor missing or deactivated", retryable: false },
        });
        continue;
      }
      runnable.push({ ...job, actor: { ...actor, ...job.actor } });
    }
    return runnable;
  }

  async run(job, workerId, { leaseMs = 30_000 } = {}) {
    const handler = this.handlers[`${job.type}@${job.payload.version}`];
    if (!handler) throw new Error(`No handler for ${job.type}@${job.payload.version}`);
    const heartbeat = setInterval(() => {
      this.queue.heartbeat({ jobId: job.jobId, workerId, leaseMs }).catch(() => {});
    }, Math.max(1, Math.floor(leaseMs / 2)));
    heartbeat.unref?.();
    try {
      const result = await handler(job);
      await this.queue.complete({ jobId: job.jobId, workerId, result });
      return result;
    } catch (error) {
      await this.queue.fail({ jobId: job.jobId, workerId, error });
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }
}

module.exports = { CoreJobWorker };

const { denyImpersonatedMutation } = require("./PostgresJobQueue");

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
      // The stored row names WHO the job runs as; what that principal may do is resolved
      // fresh on every claim. Spreading job.actor over the resolution let a row choose its
      // own workspaceIds/orgId/impersonatedBy — a row written before a revoke, or by any
      // compromised enqueue path, would keep the scope it was written with (T-4b W-5).
      runnable.push({ ...job, actor });
    }
    return runnable;
  }

  async run(job, workerId, { leaseMs = 30_000 } = {}) {
    const handler = this.handlers[`${job.type}@${job.payload.version}`];
    if (!handler) throw new Error(`No handler for ${job.type}@${job.payload.version}`);
    const heartbeat = setInterval(() => {
      this.queue.heartbeat({ jobId: job.jobId, workerId, leaseMs }).catch((error) => {
        console.error(`[Job heartbeat failed] jobId=${job.jobId} workerId=${workerId}: ${error.message}`);
      });
    }, Math.max(1, Math.floor(leaseMs / 2)));
    heartbeat.unref?.();
    try {
      denyImpersonatedMutation(job.actor, job.payload.mutating !== false);
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

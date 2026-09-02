const { denyImpersonatedMutation } = require("./PostgresJobQueue");
const { baseTypeOf } = require("./handlers");

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
    // #138: `${type}@${version}`, where the type is the BASE type. A directory sync's
    // type carries its provider (`directory.sync:lark`) so the queue gives
    // per-provider exclusion for free, but the handler is per KIND of job — otherwise
    // every new provider needs a handler entry of its own and silently has none.
    const handler = this.handlers[`${baseTypeOf(job.type)}@${job.payload.version}`];
    if (!handler) throw new Error(`No handler for ${job.type}@${job.payload.version}`);
    const heartbeat = setInterval(() => {
      this.queue.heartbeat({ jobId: job.jobId, workerId, leaseMs }).catch((error) => {
        console.error(`[Job heartbeat failed] jobId=${job.jobId} workerId=${workerId}: ${error.message}`);
      });
    }, Math.max(1, Math.floor(leaseMs / 2)));
    heartbeat.unref?.();
    try {
      denyImpersonatedMutation(job.actor, job.payload.mutating !== false);
      // #138 (TL-2): `workerId` reaches the handler so a long-running one can re-check
      // its own lease while it works. The job object carries `jobId` already; the
      // worker identity lives only here, and a handler that guessed it would guard
      // against the wrong worker.
      const result = await handler({ ...job, workerId });
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

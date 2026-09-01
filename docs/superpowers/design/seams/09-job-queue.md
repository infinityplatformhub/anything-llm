# Job queue and scheduler seam

## Responsibility

Durably enqueue, schedule, lease, retry, cancel, and dead-letter background work. Centralize connector sync, retention purge, re-embedding, backup, notifications, and license checks with explicit actors and idempotency.

## Driver contract

```js
/** @typedef {{jobId:string, type:string, payload:Object, actor:{type:"user"|"service", id:string, orgId:string}, runAt:Date, attempts:number, maxAttempts:number, idempotencyKey:string, traceId:string}} Job */
/** @interface JobQueueDriver */
class JobQueueDriver {
  /** @param {{type:string, payload:Object, actor:Object, runAt?:Date, maxAttempts?:number, idempotencyKey:string, traceId:string}} input @returns {Promise<Job>} */
  async enqueue(input) {}
  /** Upsert durable recurring schedule. @param {{scheduleId:string, type:string, cron:string, timezone:string, payload:Object, actor:Object, enabled:boolean}} input @returns {Promise<void>} */
  async schedule(input) {}
  /** Atomically lease due work. @param {{workerId:string, types:string[], leaseMs:number, limit:number}} input @returns {Promise<Job[]>} */
  async claim(input) {}
  /** @param {{jobId:string, workerId:string, result?:Object}} input @returns {Promise<void>} */
  async complete(input) {}
  /** @param {{jobId:string, workerId:string, error:Object, retryAt?:Date}} input @returns {Promise<{state:"retrying"|"dead-lettered"}>} */
  async fail(input) {}
  /** @param {{jobId:string, reason:string, actor:Object}} input @returns {Promise<void>} */
  async cancel(input) {}
  /** @param {{jobId:string, workerId:string, leaseMs:number}} input @returns {Promise<void>} */
  async heartbeat(input) {}
}
module.exports = { JobQueueDriver };
```

Payloads are versioned, JSON-serializable identifiers/options, never secrets or large document bodies. Handler registration maps `type + payload.version` to core services.

## First driver

`PostgresJobQueue` with database-backed leases and scheduler; no Redis dependency. Retention purge is first governance job, connector sync follows.

## Boundaries

- Queue driver MUST NOT contain business handlers, authorize jobs, inspect payload meaning, or impersonate original user.
- Workers MUST reauthorize destructive/sensitive work at execution using job actor; enqueue-time approval alone is insufficient.
- Driver MUST NOT store credentials/content in logs or error records.
- Jobs MUST invoke storage/vector/connector/event/license seams, never provider internals.
- Scheduler singleton behavior comes from DB locking, not process-local timers alone.

## Failure semantics

Enqueue and schedule are durable before success. Same type/idempotency key returns existing logical job. Expired lease makes job claimable; stale worker cannot complete/fail after lease loss. Retry uses bounded exponential backoff with jitter and typed retryability. Exhausted/non-retryable jobs enter durable dead letter and emit event. Completion is idempotent. Cancellation is cooperative for running job via heartbeat/signal and immediate for pending job. Crash after side effect but before completion may rerun, so handlers must be idempotent.

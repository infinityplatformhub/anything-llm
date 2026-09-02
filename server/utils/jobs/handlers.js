const { Telemetry } = require("../../models/telemetry");
const { purge } = require("../retention/purge");
const {
  DEFAULT_TIMEOUT_MS,
  MAX_RETRY_AFTER_MS,
  BACKOFF_CEILING_MS,
  DEFAULT_MAX_RETRIES,
} = require("../identityProviders/LarkIdentityProvider");

// #138: the lease is a property of the JOB TYPE, not of the runtime.
//
// `JobRuntime.tick` passed one hardcoded 30s to every handler. That is the defect;
// the directory sync only made it visible. A 30s lease is not a deadline on the job —
// the heartbeat renews it every `leaseMs / 2` while the process lives — it is how long
// a DEAD worker's job stays unclaimable. Too short, and a job whose worker was killed
// mid-run is picked up by a second worker while the first one's writes are still
// settling.
//
// DERIVED, never a literal. The floor is the longest one enumeration attempt can
// legitimately take before it gives up:
//
//   (timeoutMs + max(our backoff ceiling, a clamped Retry-After)) x (maxRetries + 1)
//
// `Math.max` because the two backoff paths have very different ceilings and taking
// the smaller understates the worst case: a 429 on every page waits the clamped
// `Retry-After` (10s + 30s per attempt = 160s), while a silent socket waits our own
// capped backoff (~41.5s). The lease must survive the worse of them.
//
// Written as an EXPRESSION on the driver's own exported constants (TL-1 + QA-1): a
// number copied here stops being true the moment any constant moves, and nothing
// would say so — the sync would just start losing its lease mid-run. A test
// recomputes this from the same constants and compares it to the value below.
const LARK_ENUMERATION_CEILING_MS =
  (DEFAULT_TIMEOUT_MS + Math.max(BACKOFF_CEILING_MS, MAX_RETRY_AFTER_MS)) *
  (DEFAULT_MAX_RETRIES + 1);

// Exactly the ceiling, with no multiplier. A directory sync does run two enumerations
// and then an unbounded apply, which is why doubling this looks prudent — but the
// heartbeat renews the lease every `leaseMs / 2` for as long as the PROCESS lives,
// including while it waits on a socket (TL-1 measured 9 beats during a hung fetch).
// So the lease never has to span a whole run; it only has to exceed the longest gap
// in which a live worker might fail to renew. Padding it past that buys nothing and
// costs real time before a genuinely dead worker's job becomes claimable.
const DIRECTORY_SYNC_LEASE_MS = LARK_ENUMERATION_CEILING_MS;

const DEFAULT_LEASE_MS = 30_000;

const LEASE_MS_BY_TYPE = {
  "directory.sync": DIRECTORY_SYNC_LEASE_MS,
};

/** Lease per job type. Anything absent keeps the previous behaviour. */
const leaseMsFor = (type) => LEASE_MS_BY_TYPE[type] ?? DEFAULT_LEASE_MS;

const handlers = {
  "telemetry.flush@1": async () => {
    await Telemetry.flush();
    return { flushed: true };
  },
  // T-6 Phase B (#28): the schedule already exists (retention-purge-daily,
  // 0 2 * * * UTC) — this fills the body it calls. The purge fails closed: an
  // unusable retention window returns skipped:true and deletes nothing.
  "retention.purge@1": async ({ traceId, db }) => {
    const result = await purge(db ? { db } : {});
    console.log(
      `[Retention purge] traceId=${traceId} purged=${result.purged} skipped=${result.skipped} retentionDays=${result.retentionDays} loginStates=${result.loginStatesPurged}`
    );
    return result;
  },
};

async function registerCoreSchedules(queue, actor) {
  await queue.schedule({
    scheduleId: "retention-purge-daily",
    type: "retention.purge",
    cron: "0 2 * * *",
    timezone: "UTC",
    payload: { version: 1 },
    actor,
    enabled: true,
  });
}

module.exports = {
  handlers,
  registerCoreSchedules,
  leaseMsFor,
  LEASE_MS_BY_TYPE,
  DEFAULT_LEASE_MS,
  DIRECTORY_SYNC_LEASE_MS,
  LARK_ENUMERATION_CEILING_MS,
};

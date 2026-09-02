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

/**
 * The type without its instance suffix: `directory.sync:lark` -> `directory.sync`.
 *
 * #138: the provider is part of the job TYPE, because that is what gives per-provider
 * exclusion for free — the queue serialises rows of one type and lets different types
 * proceed together. But the handler map and the lease map are keyed by the KIND of
 * job, not by each instance of it, and enumerating every provider in both maps would
 * mean a new provider silently has no handler and a 30s lease.
 *
 * One helper rather than two, so the two lookups cannot drift: a job whose lease came
 * from the map but whose handler did not (or the reverse) is the kind of mismatch that
 * shows up as a job leased for 160s and then failing "No handler for ...".
 */
const baseTypeOf = (type) => String(type).split(":")[0];

/** Lease per job type. Anything absent keeps the previous behaviour. */
const leaseMsFor = (type) => LEASE_MS_BY_TYPE[baseTypeOf(type)] ?? DEFAULT_LEASE_MS;

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
  // S4b slice 3 (#138): the directory sync, as a core job.
  //
  // TL-1's ruling: `PostgresJobQueue.claim` already provides exclusion (a conditional
  // update whose `count === 1` is the claim) and recovery (a lease that expires), so
  // this slice adds NO lock, no `running` checkpoint status and no migration. One
  // sync at a time per provider falls out of the job `type` — see the schedule below.
  //
  // The actor is resolved by `CoreJobWorker.claim` through `identityStore.resolveActor`
  // before the handler runs, and arrives on `job.actor`. It is NOT reconstructed here:
  // a handler that built its own actor would be a second answer to "who may change
  // group membership", which is what #128's NIT-1 pinned.
  //
  // THE LEASE IS PASSED DOWN (TL-2, #138). Losing it was previously discovered at
  // `complete()`, after every row had been written — so a worker that stalled past its
  // lease had its job taken over and then went on writing beside the worker that took
  // it. The applier re-checks the claim's own predicate between entities and refuses
  // the rest of the run, which is why `jobId` and `workerId` have to reach it.
  //
  // `workerId` comes from the RUNTIME, not from the row: the row records who holds the
  // lease, and reading it from there would make the guard compare a value against
  // itself and pass for whoever wrote last.
  "directory.sync@1": async ({ traceId, actor, payload, db, jobId, workerId }) => {
    const { runDirectorySync } = require("../identity/runDirectorySync");
    const result = await runDirectorySync({
      provider: payload.provider,
      actor,
      ...(jobId && workerId ? { lease: { jobId, workerId } } : {}),
      ...(db ? { db } : {}),
    });
    console.log(
      `[Directory sync] traceId=${traceId} provider=${payload.provider} ` +
        `status=${result.status} usersCreated=${result.usersCreated} ` +
        `usersDeactivated=${result.usersDeactivated} ` +
        `membershipsAdded=${result.membershipsAdded} ` +
        `membershipsRemoved=${result.membershipsRemoved}` +
        (result.refusedReason ? ` refusedReason=${result.refusedReason}` : "")
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

/**
 * Register a directory sync schedule for one provider (#138 R4, R5).
 *
 * PER PROVIDER, and that is the whole exclusion mechanism: the provider is part of
 * the job `type`, so the queue's per-row claim serialises two runs of the SAME
 * provider while letting lark and ldap proceed together. A global lock would make a
 * slow tenant delay everyone, and would HIDE the cross-provider identity collision
 * (the Q4 case) rather than leaving it visible for slice 4 to solve.
 *
 * Through `queue.schedule` — the MATERIALIZATION path — never a direct `enqueue`.
 * Materialization builds its idempotency key as `${scheduleId}:${runAt}` and the
 * `@@unique([type, idempotencyKey])` index refuses the duplicate, so two schedulers
 * racing cannot produce two runs of the same tick. A direct enqueue bypasses exactly
 * that, which is the protection.
 */
async function registerDirectorySyncSchedule(queue, actor, { provider, cron = "17 * * * *", timezone = "UTC", enabled = true }) {
  if (!provider) throw new Error("registerDirectorySyncSchedule requires a provider");
  await queue.schedule({
    scheduleId: `directory-sync-${provider}`,
    type: directorySyncTypeFor(provider),
    cron,
    timezone,
    payload: { version: 1, provider },
    actor,
    enabled,
  });
}

/**
 * The job type for one provider's sync.
 *
 * The provider is IN the type rather than only in the payload, because the queue
 * claims per row within a set of types — two rows of the same type are serialised by
 * the conditional update, and rows of different types are not. Putting the provider
 * only in the payload would make every provider share one type and serialise them
 * all, which is the global-lock behaviour R4 rejects.
 */
const directorySyncTypeFor = (provider) => `directory.sync:${provider}`;

module.exports = {
  handlers,
  registerCoreSchedules,
  registerDirectorySyncSchedule,
  directorySyncTypeFor,
  baseTypeOf,
  leaseMsFor,
  LEASE_MS_BY_TYPE,
  DEFAULT_LEASE_MS,
  DIRECTORY_SYNC_LEASE_MS,
  LARK_ENUMERATION_CEILING_MS,
};

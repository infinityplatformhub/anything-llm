// S4b slice 3 (#138): the sync-now route.
//
// The directory sync runs on a schedule. This route exists for the case the schedule
// cannot serve: an operator has just fixed a directory misconfiguration, or a scale
// guard refused a run, and waiting for the next tick means an hour of stale access.
//
// IT DOES NOT RUN THE SYNC. It enqueues one, and answers 202 with the job id. A sync
// enumerates a whole directory behind a 160s lease; running it inside a request would
// hold an HTTP connection open for that long, put the work outside the queue's
// exclusion (so a scheduled run and a manual one could apply concurrently — the exact
// failure this slice exists to prevent), and lose it entirely if the client
// disconnected. The queue already owns "one sync at a time per provider"; this route's
// only job is to ask it for one.
//
// AUTHORIZATION is `directory.sync`, resolved by the engine like every other action —
// this route names the action and never a role (T-4a). The action's seed row and its
// grant to super_admin are Dev1's slice; this route gates on the string, so the two
// halves are independent and neither one's tests prove the other's.

const {
  requirePermission,
} = require("../../utils/middleware/requirePermission");
const { orgResource } = require("../../utils/middleware/resourceResolvers");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");
const crypto = require("crypto");
const { PostgresJobQueue } = require("../../utils/jobs/PostgresJobQueue");
const { directorySyncTypeFor } = require("../../utils/jobs/handlers");
const {
  isKnownProvider,
  providerCapabilities,
} = require("../../utils/identityProviders");

/**
 * The idempotency key for a manual run.
 *
 * STABLE FOR THE MINUTE, never per-request. `jobs` carries
 * `@@unique([type, idempotencyKey])`, so a key derived from the clock at second or
 * millisecond resolution — or a UUID — makes every click a new row: an operator
 * double-clicking "sync now" would enqueue two runs, and the queue would serialise
 * them into two full enumerations back to back rather than recognising the second as
 * the same request.
 *
 * A minute is the window a human's repeated clicks fall inside; the scheduled runs use
 * their own `${scheduleId}:${runAt}` keys and cannot collide with these.
 */
const manualSyncKey = (provider, now) =>
  `directory-sync-manual:${provider}:${now.toISOString().slice(0, 16)}`;

function directorySyncEndpoints(app) {
  if (!app) return;

  app.post(
    "/identity/directory/:provider/sync",
    [validatedRequest, requirePermission("directory.sync", orgResource)],
    async (request, response) => {
      try {
        const provider = String(request.params.provider ?? "");

        // Refused before enqueueing, and on the CAPABILITY rather than on mere
        // existence. Either way the alternative is a job row that can never run: it
        // fails at handler time, retries to its maximum, and the operator sees a 202
        // and then silence.
        //
        // GAP, and the reason this reads oddly today (#138): `lark` is not in the
        // registry — `identityProviders/index.js` lists oidc, saml and ldap — so this
        // route answers 404 for the very provider the sync was built for. Registering
        // Lark and giving `identity_providers` its `appId`/`appSecret` (the secret
        // belonging in CredentialStore, like LDAP's bind password) is the S4a
        // follow-up. Special-casing it here would put provider configuration in a
        // route, where nobody would look for it.
        if (!isKnownProvider(provider) || !providerCapabilities(provider).directorySync) {
          return response
            .status(404)
            .json({ error: "No such directory-syncing identity provider." });
        }

        const now = new Date();
        const queue = new PostgresJobQueue();
        const job = await queue.enqueue({
          type: directorySyncTypeFor(provider),
          payload: { version: 1, provider },
          // The service principal, not the caller: the sync applies directory-wide
          // membership changes that the operator who asked for it may not hold
          // individually. Their authority to REQUEST the run is what the gate above
          // decided; what the run may DO is the job actor's question, and answering
          // it with the caller would make a sync's reach depend on who clicked.
          actor: { type: "service", id: "core-jobs", orgId: 1 },
          idempotencyKey: manualSyncKey(provider, now),
          // `jobs.traceId` is NOT NULL. Express has no `request.id` of its own, so a
          // fresh id is generated here rather than read off the request — the first
          // version passed `request.id ?? undefined` and every enqueue failed the
          // constraint, which the route reported as a 500 with an empty message.
          traceId: crypto.randomUUID(),
        });

        // 202, not 200: the work has been accepted, not done. `enqueue` returns the
        // EXISTING row when the key matches, so a second click inside the same minute
        // answers 202 with the same job id rather than a conflict — idempotent from
        // the caller's side, which is what makes a retry safe.
        return response.status(202).json({
          jobId: job.jobId,
          type: job.type,
          provider,
        });
      } catch (error) {
        // The name as well as the message: a Prisma constraint error carries its
        // detail in `code`/`meta` and an empty `message`, so logging the message alone
        // produced a blank line for the one failure mode this route actually hit.
        console.error(
          `[directory sync] enqueue failed for ${request.params?.provider}:`,
          error?.name,
          error?.code ?? "",
          error?.message || String(error)
        );
        return response.status(500).json({ error: "Could not queue the sync." });
      }
    }
  );
}

module.exports = { directorySyncEndpoints, manualSyncKey };

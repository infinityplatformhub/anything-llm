// T-2 (#20): actorResolver — the ONLY place a seam-02 Actor object is constructed
// (grep DoD: no `{type:"user"|"service"|"embed"}` literals outside this file).
// Normalization only, never authentication: each ingress middleware authenticates first
// and leaves its result on response.locals; resolver maps it to an Actor.
// Ingress inventory: p0-5-t2-actor-resolver.md (11 rows).
//
// Single-user mode (R5): NO code path skips checks — the resolver yields an explicit
// service principal carrying the seeded super_admin grant (principal 'single-user').

const prisma = require("../prisma");
const { SystemSettings } = require("../../models/systemSettings");

const SINGLE_USER_ACTOR = Object.freeze({
  type: "service",
  id: "single-user",
  orgId: 1,
});

// Built-in service principals (seeded by T-1's migration / used by P0-6 job runtime).
// The ONLY Actor literals in the codebase live in this file (grep DoD, issue #20).
const SERVICE_PRINCIPALS = Object.freeze({
  singleUser: SINGLE_USER_ACTOR,
  coreJobs: Object.freeze({ type: "service", id: "core-jobs", orgId: 1 }),
});

/**
 * @param {import("express").Request} request
 * @param {import("express").Response} response
 * @returns {Promise<Object|null>} Actor or null when NO ingress authenticated anything.
 */
async function resolveActor(request, response, { db = prisma } = {}) {
  const locals = response?.locals ?? {};

  // Row 3 (P0-4 PR-3): scoped API key — RAW context only; this is where it becomes an Actor.
  if (locals.apiKeyContext) {
    const ctx = locals.apiKeyContext;
    // Key lifecycle is checked in full here, not half of it: an expired key must yield
    // no actor even if the ingress middleware ever stops checking (F-20d, QA-2 round 2).
    const expired = ctx.expiresAt && new Date(ctx.expiresAt) <= new Date();
    if (ctx.revokedAt || expired) return null;
    return {
      type: "service",
      id: `api-key:${ctx.keyId}`,
      orgId: 1,
      workspaceIds: ctx.workspaceId ? [ctx.workspaceId] : [],
      scopedKeyId: String(ctx.keyId),
      attributes: { scopes: ctx.scopes ?? [] },
    };
  }

  // Rows 1/4/5/7: ingresses that resolve a real user row (session JWT, browser-extension
  // key, mobile device token, SSO-exchanged JWT) all land on locals.user.
  if (locals.user) {
    if (locals.user.suspended) return null; // suspended = no actor, engine denies
    // Membership is read here rather than trusted from locals: nothing in the request
    // pipeline populates it today, so trusting it would hand every user an empty scope
    // and make documentFilter match nothing on real routes (B-2, architect review).
    // locals.userWorkspaceIds stays supported as an override for callers that already
    // loaded membership (T-4a route wiring).
    const workspaceIds =
      locals.userWorkspaceIds !== undefined
        ? locals.userWorkspaceIds.map(String)
        : await workspaceIdsForUser(locals.user.id, db);
    return {
      type: "user",
      id: String(locals.user.id),
      orgId: 1,
      workspaceIds,
      impersonatedBy: locals.impersonatedBy ? { type: "user", id: String(locals.impersonatedBy) } : undefined,
    };
  }

  // Row 6: embed config — a REAL actor (anonymous, key-scoped), never null. Absent scope
  // surfaces later as a match-none documentFilter (T-3), not as a deny at ingress.
  if (locals.embedConfig) {
    return {
      type: "embed",
      id: String(locals.embedConfig.uuid),
      orgId: 1,
      workspaceIds: locals.embedConfig.workspace ? [String(locals.embedConfig.workspace.id)] : [],
    };
  }

  // Row 2 (R5): single-user deployments have no user rows — explicit service principal
  // evaluated by the engine like any principal. No branch anywhere may mean "allow".
  if (!(await isMultiUserModeSafe())) {
    return { ...SINGLE_USER_ACTOR };
  }

  // Rows 8-11: agent runtime with null user_id, background jobs, telegram channel state,
  // and unauthenticated routes yield NULL — the engine denies (missing_actor / S-4).
  return null;
}

/**
 * T-4b (#29) W-5: the job-runtime half of the same resolver. `utils/jobs/ActorIdentityStore`
 * used to build Actors independently — it spread the whole `users` row into the object the
 * engine reads, hardcoded `workspaceIds: []` (wrong since T-3 taught the HTTP path to derive
 * membership, so one user read documents over HTTP and nothing in a job), and never stamped
 * `impersonatedBy`, leaving CoreJobWorker's denyImpersonatedMutation with nothing to check.
 *
 * @param {{type: string, id: string|number, orgId?: number, impersonatedBy?: string|number}|null} actorRef
 *   the persisted actor reference on the job row
 * @returns {Promise<Object|null>} Actor, or null when the referenced principal cannot act.
 */
async function resolveActorRef(actorRef, { db = prisma } = {}) {
  if (!actorRef || !actorRef.type || actorRef.id === undefined || actorRef.id === null) {
    return null;
  }

  // Non-user principals (service/embed) carry their whole identity in the ref; there is
  // no row to look up and no membership to derive.
  if (actorRef.type !== "user") {
    return {
      type: actorRef.type,
      id: String(actorRef.id),
      orgId: actorRef.orgId ?? 1,
      ...(actorRef.workspaceIds ? { workspaceIds: actorRef.workspaceIds.map(String) } : {}),
    };
  }

  // The row is read to prove the user still exists and may act — never to copy columns
  // into the Actor. Only the seam-02 shape crosses the boundary.
  const user = await db.users.findUnique({
    where: { id: Number(actorRef.id) },
    select: { id: true, suspended: true },
  });
  if (!user || user.suspended) return null;

  return {
    type: "user",
    id: String(user.id),
    orgId: actorRef.orgId ?? 1,
    workspaceIds: await workspaceIdsForUser(user.id, db),
    impersonatedBy: actorRef.impersonatedBy
      ? { type: "user", id: String(actorRef.impersonatedBy) }
      : undefined,
  };
}

/** Workspace ids the user belongs to — the scope every document filter is built on. */
async function workspaceIdsForUser(userId, db = prisma) {
  try {
    const rows = await db.workspace_users.findMany({
      where: { user_id: Number(userId) },
      select: { workspace_id: true },
    });
    return rows.map((row) => String(row.workspace_id));
  } catch {
    // Fail restrictive: an unreadable membership table yields no scope, which the
    // filter turns into match-none rather than an unbounded read.
    return [];
  }
}

async function isMultiUserModeSafe() {
  try {
    return await SystemSettings.isMultiUserMode();
  } catch {
    // Fall back to true (multi-user = deny anonymous) — fail toward the more
    // restrictive mode, never toward allow.
    return true;
  }
}

module.exports = {
  resolveActor,
  resolveActorRef,
  SINGLE_USER_ACTOR,
  SERVICE_PRINCIPALS,
};

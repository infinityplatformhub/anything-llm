// T-2 (#20): actorResolver — the ONLY place a seam-02 Actor object is constructed
// (grep DoD: no `{type:"user"|"service"|"embed"}` literals outside this file).
// Normalization only, never authentication: each ingress middleware authenticates first
// and leaves its result on response.locals; resolver maps it to an Actor.
// Ingress inventory: p0-5-t2-actor-resolver.md (11 rows).
//
// Single-user mode (R5): NO code path skips checks — the resolver yields an explicit
// service principal carrying the seeded super_admin grant (principal 'single-user').

const { SystemSettings } = require("../../models/systemSettings");

const SINGLE_USER_ACTOR = Object.freeze({
  type: "service",
  id: "single-user",
  orgId: 1,
});

/**
 * @param {import("express").Request} request
 * @param {import("express").Response} response
 * @returns {Promise<Object|null>} Actor or null when NO ingress authenticated anything.
 */
async function resolveActor(request, response) {
  const locals = response?.locals ?? {};

  // Row 3 (P0-4 PR-3): scoped API key — RAW context only; this is where it becomes an Actor.
  if (locals.apiKeyContext) {
    const ctx = locals.apiKeyContext;
    if (ctx.revokedAt) return null;
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
    return {
      type: "user",
      id: String(locals.user.id),
      orgId: 1,
      workspaceIds: (locals.userWorkspaceIds ?? []).map(String),
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

async function isMultiUserModeSafe() {
  try {
    return await SystemSettings.isMultiUserMode();
  } catch {
    // Fall back to true (multi-user = deny anonymous) — fail toward the more
    // restrictive mode, never toward allow.
    return true;
  }
}

module.exports = { resolveActor, SINGLE_USER_ACTOR };

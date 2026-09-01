// T-4a (#25): the single ingress authorization gate. Replaces flexUserRoleValid /
// strictMultiUserRoleValid, which compared `user.role` against a string list and
// skipped every check outside multi-user mode (multiUserProtected.js:69-73).
//
// Routes name an ACTION and how to find the RESOURCE. They never name a role, and
// they never decide anything themselves — the engine does, for every deployment
// shape, because the single-user principal is a real principal (R5).

const { DatabaseAuthorizationEngine } = require("../authorization/engine");
const { resolveActor } = require("../authorization/actorResolver");
const {
  AuthorizationDeniedError,
  AuthorizationContractError,
  AuthorizationUnavailableError,
} = require("../authorization/errors");

const engine = new DatabaseAuthorizationEngine();

// Reasons that must not confirm a resource exists. A caller who may not read a
// workspace must not learn the difference between "no such workspace" and
// "not yours" — seam 02 failure semantics, and what S-1 asserts.
const NON_DISCLOSING = new Set([
  "no_grants",
  "missing_actor",
  "no_permission_in_roles",
]);

/**
 * @param {string} action seam-02 action string, e.g. "workspace.update"
 * @param {(request: import("express").Request, response: import("express").Response) => Promise<Object|null>} resolveResource
 *   Returns {type, id, orgId, workspaceId} or null when the resource does not exist.
 *   MUST derive workspaceId from the stored row, never from the request body (B-3).
 */
function requirePermission(action, resolveResource) {
  return async function permissionRequired(request, response, next) {
    try {
      const actor = await resolveActor(request, response);
      const resource = await resolveResource(request, response);

      // An unresolvable resource is a 404 before any decision — there is nothing
      // to authorize against, and answering 403 would confirm it exists.
      if (!resource) return response.sendStatus(404);

      const decision = await engine.authorize({ actor, action, resource });
      if (decision.allowed) {
        response.locals.actor = actor;
        response.locals.authorizedResource = resource;
        return next();
      }

      return response
        .status(NON_DISCLOSING.has(decision.reason) ? 404 : 403)
        .json({ error: "Not found." });
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) return response.sendStatus(403);
      // A policy-store outage must read as an outage, never as "no permissions" —
      // callers fail closed, but operators see a 503 they can act on.
      if (error instanceof AuthorizationUnavailableError) {
        console.error("[authorization] policy store unavailable:", error.message);
        return response.sendStatus(503);
      }
      if (error instanceof AuthorizationContractError) {
        console.error("[authorization] contract error:", error.message);
        return response.sendStatus(500);
      }
      throw error;
    }
  };
}

module.exports = { requirePermission, NON_DISCLOSING };

// T-2 (#20): DatabaseAuthorizationEngine — the single authorization decision point
// (seam 02). authorize/assertAuthorized/authorizeMany land here; documentFilter + cache
// are T-3; explainAccess is T-7. Design: p0-5-t2-actor-resolver.md, p0-5-authorization-recon.md.
//
// Deny-wins evaluation over the seeded policy store. Default deny on: missing actor,
// unknown action, store failure (AuthorizationUnavailableError — callers fail closed),
// expired grants, impersonated non-read actions (blanket, BEFORE policy lookup).

const prisma = require("../prisma");
const {
  AuthorizationDeniedError,
  AuthorizationContractError,
  AuthorizationUnavailableError,
} = require("./errors");

// Impersonated sessions (view-as-user) keep the viewed user's READ scope; every mutation
// is denied regardless of that scope. The only read-shaped actions an impersonated admin
// may need are diagnostics — access.diagnose included until T-7 rules otherwise.
// document.export is deliberately NOT here: exporting is data exfiltration, not reading
// (QA-1 finding, seam 02 contract).
const READ_ACTIONS = new Set([
  "document.read",
  "document.search",
  "workspace.read",
  "user.read",
  "system.read",
  "chat.read",
  "chat.read_others",
  "invite.read",
  "embed.read",
  "agent-flow.read",
  "mcp-server.read",
  "memory.read",
  "telegram.read",
  "scheduled-job.read",
  "browser-extension.read",
  "model-router.read",
  "access.diagnose",
]);

// T-4a (W-6): batch ceiling for authorizeMany.
const MAX_BATCH_RESOURCES = 500;

const asDenied = (reason, matchedPolicyIds = []) => ({
  allowed: false,
  reason,
  matchedPolicyIds,
});

class DatabaseAuthorizationEngine {
  constructor({ db = prisma } = {}) {
    this.db = db;
  }

  /**
   * @param {{actor: Object|null, action: string, resource: {type: string, id: string|null, orgId: number, workspaceId: number|null, ownerId?: number}}} input
   * @returns {Promise<{allowed: boolean, reason: string, matchedPolicyIds: string[]}>}
   */
  async authorize({ actor, action, resource }) {
    if (!actor || !actor.type || !actor.id) return asDenied("missing_actor");
    if (typeof action !== "string" || !action.includes(".")) {
      throw new AuthorizationContractError(`invalid action: ${action}`);
    }
    if (!resource || !resource.type) {
      throw new AuthorizationContractError("resource.type is required");
    }

    // R5 blanket: impersonated actors never mutate, before any policy lookup.
    if (actor.impersonatedBy && !READ_ACTIONS.has(action)) {
      return asDenied("impersonated_mutation_denied");
    }

    try {
      return await this.evaluate(actor, action, resource);
    } catch (error) {
      // A store failure must read as unavailable, never as "no permissions"
      if (error instanceof AuthorizationContractError) throw error;
      throw new AuthorizationUnavailableError(`policy store failure: ${error.message}`);
    }
  }

  async assertAuthorized(input) {
    const decision = await this.authorize(input);
    if (!decision.allowed) throw new AuthorizationDeniedError(decision.reason);
  }

  /**
   * Batch decisions — ONE result per requested resource, in request order, or the whole
   * call fails closed (seam 02). Keyed by index: two resources can share type+id (or
   * carry no id at all) and a content-derived key would silently drop a decision.
   * @param {{actor: Object|null, action: string, resources: Array<Object>}} input
   * @returns {Promise<Map<number, {allowed: boolean, reason: string, matchedPolicyIds: string[]}>>}
   */
  async authorizeMany({ actor, action, resources }) {
    if (!Array.isArray(resources) || resources.length === 0) {
      throw new AuthorizationContractError("resources must be a non-empty array");
    }
    // T-4a (W-6): each resource costs 3 queries, so an unbounded batch is a
    // self-inflicted denial of service. Refuse rather than truncate — a short
    // answer would read as "denied" for the resources that fell off the end.
    if (resources.length > MAX_BATCH_RESOURCES) {
      throw new AuthorizationContractError(
        `authorizeMany accepts at most ${MAX_BATCH_RESOURCES} resources, got ${resources.length}`
      );
    }
    const decisions = await Promise.all(
      resources.map((resource) => this.authorize({ actor, action, resource }))
    );
    return new Map(decisions.map((decision, i) => [i, decision]));
  }

  async evaluate(actor, action, resource) {
    // Unknown action = deny (vocabulary is the seeded permissions table; T-1 diff test
    // keeps P0-4 scopes in the same namespace).
    const permission = await this.db.permissions.findUnique({ where: { action } });
    if (!permission) return asDenied("unknown_action");

    // Grants for this principal: org-wide (workspace_id NULL) + workspace-scoped to the
    // resource's workspace. Expired grants grant nothing.
    const grantWhere = {
      orgId: actor.orgId ?? 1,
      principal_type: actor.type,
      principal_id: String(actor.id),
      OR: [
        { expires_at: null },
        { expires_at: { gt: new Date() } },
      ],
    };
    const workspaceScope =
      resource.workspaceId != null
        ? { OR: [{ workspace_id: null }, { workspace_id: resource.workspaceId }] }
        : { workspace_id: null };
    const grants = await this.db.principal_role_grants.findMany({
      where: { AND: [grantWhere, workspaceScope] },
      select: { role_id: true },
    });
    if (grants.length === 0) return asDenied("no_grants");

    const roleIds = grants.map((g) => g.role_id);
    const rows = await this.db.role_permissions.findMany({
      where: { role_id: { in: roleIds }, permission_id: permission.id },
      select: { effect: true, role_id: true },
    });
    if (rows.length === 0) return asDenied("no_permission_in_roles");

    // deny wins over allow, regardless of which role carries it
    const denied = rows.some((r) => r.effect === "deny");
    const matchedPolicyIds = rows.map((r) => `role:${r.role_id}:${permission.id}`);
    return denied
      ? asDenied("denied_by_role", matchedPolicyIds)
      : { allowed: true, reason: "allowed_by_role", matchedPolicyIds };
  }
}

module.exports = { DatabaseAuthorizationEngine, READ_ACTIONS, MAX_BATCH_RESOURCES };

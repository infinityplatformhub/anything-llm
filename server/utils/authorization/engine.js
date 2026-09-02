// T-2 (#20): DatabaseAuthorizationEngine — the single authorization decision point
// (seam 02). authorize/assertAuthorized/authorizeMany land here; documentFilter + cache
// are T-3; explainAccess is T-7. Design: p0-5-t2-actor-resolver.md, p0-5-authorization-recon.md.
//
// Deny-wins evaluation over the seeded policy store. Default deny on: missing actor,
// unknown action, store failure (AuthorizationUnavailableError — callers fail closed),
// expired grants, impersonated non-read actions (blanket, BEFORE policy lookup).

const prisma = require("../prisma");
const { grantPrincipalPairs } = require("./groupMembership");
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
  // #53: authority-free — it answers "is the caller a principal of this org",
  // and every route asking it still filters by membership in the handler. It is
  // read-shaped for the same reason, which is what restores view-as-user's
  // ability to list workspaces, search, and fetch its own generated files.
  "org.member",
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
  async authorize({ actor, action, resource, memo = null }) {
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

    // T-4b (#29) B-1: a workspace-bound API key reaches only the workspace it was issued
    // for, whatever its creator's grants say. The binding is a property of the credential,
    // not of the policy store, so it gates like impersonation — blanket, before any lookup.
    // A resource with no workspaceId cannot be attributed to the binding, and
    // unattributable is not the same as in-scope, so it is denied too.
    if (Array.isArray(actor.keyWorkspaceBinding) && actor.keyWorkspaceBinding.length > 0) {
      const bound = new Set(actor.keyWorkspaceBinding.map(String));
      if (resource.workspaceId == null || !bound.has(String(resource.workspaceId))) {
        return asDenied("outside_key_binding");
      }
    }

    try {
      return await this.evaluate(actor, action, resource, memo);
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
    // #96: group membership is a property of the ACTOR, not of the resource, so it
    // is read once for the whole batch and handed to each decision. Without this a
    // 500-resource batch adds 500 identical `group_members` queries — the ceiling
    // above exists because each resource already costs three, and this would make
    // it four. The memo lives for this call only: a longer-lived cache would let a
    // removed membership keep authorizing.
    const memo = new Map();
    const decisions = await Promise.all(
      resources.map((resource) => this.authorize({ actor, action, resource, memo }))
    );
    return new Map(decisions.map((decision, i) => [i, decision]));
  }

  /**
   * The principal grants are read for. T-4b (#29) B-1: a scoped API key holds no grants
   * under `api-key:<id>` — it is a bearer credential for its creator, so grants resolve
   * against `grantPrincipal` while the `api-key:` id stays as audit provenance. The key's
   * own scope list is the other half of the intersection and is enforced at ingress.
   * A key whose creator is unknown (createdBy null, deleted row, unreadable table) carries
   * `grantPrincipal: null` and can only deny.
   */
  static grantPrincipalOf(actor) {
    return "grantPrincipal" in actor ? actor.grantPrincipal : actor;
  }

  async evaluate(actor, action, resource, memo = null) {
    // Unknown action = deny (vocabulary is the seeded permissions table; T-1 diff test
    // keeps P0-4 scopes in the same namespace).
    const permission = await this.db.permissions.findUnique({ where: { action } });
    if (!permission) return asDenied("unknown_action");

    // #53: an action may declare the resource shape it is answerable about, and
    // a mismatch is a CONTRACT error — the caller asked a question this action
    // cannot answer, which is a bug in the route, not a decision about the actor.
    // Denying instead would let a miswired gate look like an ordinary refusal.
    //
    // Checked HERE rather than in authorize(): scope lives in the permissions
    // row, and authorize()'s guards (R5 impersonation, key binding) are
    // deliberately blanket and touch no database, so an already-denied actor
    // cannot make the policy store do work. This runs the moment the row is in
    // hand and before any grant is read, so no allow/deny is ever decided on a
    // wrongly-shaped question.
    const scope = permission.scope ?? "any";
    if (scope === "org" && resource.workspaceId != null) {
      throw new AuthorizationContractError(
        `org_scoped_action_on_workspace_resource: ${action} may only be asked at org scope`
      );
    }
    if (scope === "workspace" && resource.workspaceId == null) {
      throw new AuthorizationContractError(
        `workspace_scoped_action_on_org_resource: ${action} requires a workspace resource`
      );
    }

    const grantPrincipal = DatabaseAuthorizationEngine.grantPrincipalOf(actor);
    if (!grantPrincipal) return asDenied("no_grant_principal");

    // Grants for this principal: org-wide (workspace_id NULL) + workspace-scoped to the
    // resource's workspace. Expired grants grant nothing.
    // #96: grants may be written against the principal ITSELF or against a group it
    // belongs to. Before this, only the first was read — so a role granted to a
    // group authorized nobody, while the admin UI offered it, explainAccess
    // confirmed it was held, and documentFilter honoured it for documents. Every
    // layer agreed except the one that decides.
    //
    // Expansion is skipped for an actor evaluating through a grantPrincipal (an
    // api-key). Its authority is what its creator holds DIRECTLY; inheriting the
    // creator's departments would widen the key whenever someone edits a group,
    // to grants its scope list was never reviewed against. `grantPrincipalOf`
    // returns the creator, who IS a user, so this has to be refused explicitly —
    // it is not something the type check catches.
    const principalPairs =
      "grantPrincipal" in actor
        ? [
            {
              principal_type: grantPrincipal.type,
              principal_id: String(grantPrincipal.id),
            },
          ]
        : await grantPrincipalPairs(grantPrincipal, actor.orgId ?? 1, this.db, memo);

    const grantWhere = {
      orgId: actor.orgId ?? 1,
      OR: [
        { expires_at: null },
        { expires_at: { gt: new Date() } },
      ],
    };
    const workspaceScope =
      resource.workspaceId != null
        ? { OR: [{ workspace_id: null }, { workspace_id: resource.workspaceId }] }
        : { workspace_id: null };
    // Three separate OR clauses (principal, expiry, workspace scope) must all hold,
    // so each is its own AND member — merging them into one object would overwrite
    // the earlier `OR` keys and silently widen the query.
    const grants = await this.db.principal_role_grants.findMany({
      where: { AND: [grantWhere, workspaceScope, { OR: principalPairs }] },
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

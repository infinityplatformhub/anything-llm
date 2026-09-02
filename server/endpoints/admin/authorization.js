// T-7 (#31): authorization diagnostics and grant management.
//
// Gated on `access.diagnose`, which is deliberately NOT held by the org
// `member` role: the answer names every principal with access to a document,
// which is a map of who is interesting to attack.
//
// The grant routes are the reason the duty split is real rather than seeded.
// T-1 created `setup_admin` and `content_moderator` with their permissions on
// day one, but nothing could ever hand them to a person: `grantRole` had no
// HTTP surface at all, so the only roles anybody could actually receive were
// the ones the legacy `users.role` column mapped to. Three seeded roles and two
// reachable ones is a duty split on paper.

const {
  explainDocumentAccess,
} = require("../../utils/authorization/explainAccess");
const {
  AuthorizationContractError,
  AuthorizationUnavailableError,
} = require("../../utils/authorization/errors");
const {
  grantRole,
  revokeGrant,
} = require("../../utils/authorization/policyRepository");
const prisma = require("../../utils/prisma");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");
const {
  requirePermission,
} = require("../../utils/middleware/requirePermission");
const {
  orgResource,
  grantScopeFromBody,
} = require("../../utils/middleware/resourceResolvers");

// A grant may only name a principal that exists. Without this, a typo in an id
// writes a row that grants nothing today and silently starts granting the day
// some unrelated user is created with that id — the grant outlives the mistake.
const PRINCIPAL_EXISTS = {
  user: async (id) =>
    Number.isInteger(Number(id)) &&
    !!(await prisma.users.findUnique({ where: { id: Number(id) } })),
  group: async (id) =>
    Number.isInteger(Number(id)) &&
    !!(await prisma.groups.findUnique({ where: { id: Number(id) } })),
};

/**
 * Resolve `{principalType, principalId, role, workspaceId}` from a request body
 * into what the policy gateway takes, or an {error, status} to answer with.
 *
 * `service` and `system` principals are deliberately NOT assignable over HTTP.
 * They are the exemptions the escalation guard skips (`isExemptPrincipal`), so
 * granting to one over the network would be a way to route around the guard
 * that protects every other grant.
 */
async function resolveGrantTarget(body) {
  const principalType = String(body?.principalType ?? "");
  const principalId = String(body?.principalId ?? "");
  const roleName = String(body?.role ?? "");

  if (!PRINCIPAL_EXISTS[principalType])
    return { error: "principalType must be 'user' or 'group'", status: 400 };
  if (!roleName) return { error: "role is required", status: 400 };

  const scope = body?.workspaceId ? "workspace" : "org";
  const role = await prisma.roles.findFirst({
    where: { orgId: 1, name: roleName, scope },
    select: { id: true, name: true },
  });
  // A workspace role named in an org-wide grant is a scope error, not a missing
  // role: reporting it as "no such role" sends the caller looking for a typo.
  if (!role)
    return { error: `no ${scope}-scoped role named '${roleName}'`, status: 400 };

  if (!(await PRINCIPAL_EXISTS[principalType](principalId)))
    return { error: `no such ${principalType}`, status: 404 };

  return {
    principalType,
    principalId,
    roleId: role.id,
    roleName: role.name,
    workspaceId: body?.workspaceId ? Number(body.workspaceId) : null,
  };
}

function adminAuthorizationEndpoints(app) {
  if (!app) return;

  app.get(
    "/admin/authorization/document/:documentId",
    [validatedRequest, requirePermission("access.diagnose", orgResource)],
    async (request, response) => {
      try {
        const documentId = Number(request.params.documentId);
        const action =
          typeof request.query?.action === "string"
            ? request.query.action
            : "document.read";

        const explanation = await explainDocumentAccess({
          documentId,
          action,
        });

        // Denial and absence read the same to the caller: a diagnostics route
        // that confirms which document ids exist is an enumeration oracle
        // (S-18). The gate above already decided they may ask at all.
        if (!explanation) return response.sendStatus(404);

        response.status(200).json(explanation);
      } catch (error) {
        if (error instanceof AuthorizationContractError)
          return response.status(400).json({ error: error.message });
        if (error instanceof AuthorizationUnavailableError)
          // 409, not 500: the answer was refused because it would have been
          // wrong, and retrying is the correct response.
          return response.status(409).json({ error: error.message });
        console.error(error.message, error);
        response.sendStatus(500).end();
      }
    }
  );

  // What a principal currently holds. Gated on access.diagnose rather than
  // role.grant: reading who holds what is the diagnostic question, and an
  // auditor who may not change grants still needs to see them.
  app.get(
    "/admin/authorization/grants",
    [validatedRequest, requirePermission("access.diagnose", orgResource)],
    async (request, response) => {
      try {
        const principalType = String(request.query?.principalType ?? "");
        const principalId = String(request.query?.principalId ?? "");
        if (!PRINCIPAL_EXISTS[principalType] || !principalId)
          return response
            .status(400)
            .json({ error: "principalType and principalId are required" });

        const grants = await prisma.principal_role_grants.findMany({
          where: { orgId: 1, principal_type: principalType, principal_id: principalId },
          select: {
            id: true,
            workspace_id: true,
            granted_by: true,
            granted_at: true,
            expires_at: true,
            roles: { select: { name: true, scope: true } },
          },
          orderBy: { id: "asc" },
        });

        response.status(200).json({
          principalType,
          principalId,
          grants: grants.map((grant) => ({
            id: grant.id,
            role: grant.roles.name,
            scope: grant.roles.scope,
            // null means org-wide, which the engine reads as every workspace —
            // the single most consequential field in the row.
            workspaceId: grant.workspace_id,
            grantedBy: grant.granted_by,
            grantedAt: grant.granted_at,
            expiresAt: grant.expires_at,
          })),
        });
      } catch (error) {
        console.error(error.message, error);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/admin/authorization/grants",
    [
      validatedRequest,
      // The scope resolver decides WHICH scope the gate asks about, so an admin
      // who holds role.grant only inside one workspace is refused at the org.
      requirePermission("role.grant", grantScopeFromBody),
    ],
    async (request, response) => {
      try {
        const target = await resolveGrantTarget(request.body);
        if (target.error)
          return response.status(target.status).json({ error: target.error });

        // The route gate asked "may this actor grant here at all". The gateway
        // now asks the narrower question it has asked since T-2: does the actor
        // hold every permission the role carries. Both must pass — the first
        // cannot see which role, the second cannot see the HTTP scope.
        const result = await grantRole({
          actor: response.locals.actor,
          principalType: target.principalType,
          principalId: target.principalId,
          roleId: target.roleId,
          workspaceId: target.workspaceId,
          expiresAt: request.body?.expiresAt
            ? new Date(request.body.expiresAt)
            : null,
        });

        response.status(200).json({
          id: result.id,
          role: target.roleName,
          workspaceId: target.workspaceId,
          policyVersion: String(result.policyVersion),
        });
      } catch (error) {
        if (error instanceof AuthorizationContractError)
          // 403: the escalation guard refused. This is a permission answer, not
          // a malformed request — the body was fine, the actor was not.
          return response.status(403).json({ error: error.message });
        console.error(error.message, error);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/admin/authorization/grants",
    [validatedRequest, requirePermission("role.revoke", grantScopeFromBody)],
    async (request, response) => {
      try {
        const target = await resolveGrantTarget(request.body);
        if (target.error)
          return response.status(target.status).json({ error: target.error });

        const result = await revokeGrant({
          actor: response.locals.actor,
          principalType: target.principalType,
          principalId: target.principalId,
          roleId: target.roleId,
          workspaceId: target.workspaceId,
          reason:
            typeof request.body?.reason === "string"
              ? request.body.reason
              : null,
        });

        // A revoke that matched nothing still answers 200: the caller asked for
        // the grant to be gone and it is. Reporting 404 would tell them whether
        // it existed, which is the enumeration answer the gate withheld.
        response.status(200).json({
          deleted: result.deleted,
          policyVersion: String(result.policyVersion),
        });
      } catch (error) {
        if (error instanceof AuthorizationContractError)
          return response.status(403).json({ error: error.message });
        console.error(error.message, error);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = { adminAuthorizationEndpoints };

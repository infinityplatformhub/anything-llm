// T-2 (#20): policyRepository — the SINGLE gateway for grant/ACL/visibility mutations
// (T-1 ledger commitment → T-2/T-3). Every write inserts a policy_versions row in the
// same transaction, so the T-3 cache can treat "a newer version exists" as staleness.
// No DB trigger: business logic in the DB is invisible to review/tests (ledger ruling).
//
// Also enforces grant-escalation rules the engine cannot see (S-5/S-6/S-9):
// a granter cannot hand out a role carrying permissions they do not themselves hold.

const prisma = require("../prisma");
const { AuthorizationContractError } = require("./errors");

const SCOPE_KEY = (orgId) => `org:${orgId}`;

// Only these two named built-in principals skip the escalation guard: the single-user
// deployment principal and the P0-6 job runtime, both seeded by migrations. Exempting
// every `type:"service"` actor would let a scoped API key (also a service actor) grant
// itself super_admin — the S-9 hole (security review, issue #20).
const EXEMPT_PRINCIPAL_IDS = new Set(["single-user", "core-jobs"]);
const isExemptPrincipal = (actor) =>
  actor.type === "service" && EXEMPT_PRINCIPAL_IDS.has(String(actor.id));

async function bumpVersion(tx, changeType, scopeKey, actorId) {
  const row = await tx.policy_versions.create({
    data: { change_type: changeType, scope_key: scopeKey, actor_id: actorId ?? null },
    select: { version: true },
  });
  return row.version;
}

async function permissionIdsForRole(tx, roleId) {
  const rows = await tx.role_permissions.findMany({
    where: { role_id: roleId, effect: "allow" },
    select: { permission_id: true },
  });
  return new Set(rows.map((r) => r.permission_id));
}

/**
 * Permissions the actor holds *within the scope a grant is being written to*.
 * Scope rule (security review, issue #20): an org-wide grant (workspace_id null) may
 * only be written by someone holding the permission org-wide; a workspace-scoped grant
 * may be written by someone holding it org-wide OR in that same workspace. Counting
 * every grant regardless of scope would let a workspace-A admin mint org-wide roles.
 */
async function heldPermissionIds(tx, actor, targetWorkspaceId) {
  const scope =
    targetWorkspaceId == null
      ? { workspace_id: null } // org-wide target: only org-wide grants count
      : { OR: [{ workspace_id: null }, { workspace_id: targetWorkspaceId }] };
  const grants = await tx.principal_role_grants.findMany({
    where: {
      AND: [
        {
          orgId: actor.orgId ?? 1,
          principal_type: actor.type,
          principal_id: String(actor.id),
          OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
        },
        scope,
      ],
    },
    select: { role_id: true },
  });
  if (grants.length === 0) return new Set();
  const rows = await tx.role_permissions.findMany({
    where: { role_id: { in: grants.map((g) => g.role_id) }, effect: "allow" },
    select: { permission_id: true },
  });
  return new Set(rows.map((r) => r.permission_id));
}

/**
 * Grant a role to a principal. Escalation guard: every permission the granted role
 * carries must be held by the granting actor (S-5) — except the single-user service
 * principal, whose grant comes from migrations and out ranks everything (S-9 enforces
 * the same rule for scoped API keys, which resolve to service actors).
 */
async function grantRole({ actor, principalType, principalId, roleId, workspaceId = null, expiresAt = null, db = prisma }) {
  // A missing actor must never be a free pass: seeds and migrations pass an explicit
  // built-in principal (security review, issue #20).
  if (!actor) {
    throw new AuthorizationContractError(
      "grantRole requires an explicit actor — pass SERVICE_PRINCIPALS.singleUser/coreJobs for seed and migration writes"
    );
  }
  return db.$transaction(async (tx) => {
    if (!isExemptPrincipal(actor)) {
      const rolePerms = await permissionIdsForRole(tx, roleId);
      const held = await heldPermissionIds(tx, actor, workspaceId);
      const missing = [...rolePerms].filter((p) => !held.has(p));
      if (missing.length > 0) {
        throw new AuthorizationContractError(
          "grant refused: role carries permissions the granter does not hold in this scope"
        );
      }
    }
    const version = await bumpVersion(tx, "grant", SCOPE_KEY(1), actor ? Number(actor.id) || null : null);
    const existing = await tx.principal_role_grants.findFirst({
      where: {
        orgId: 1, principal_type: principalType, principal_id: String(principalId),
        role_id: roleId, workspace_id: workspaceId,
      },
    });
    if (existing) {
      await tx.principal_role_grants.update({
        where: { id: existing.id },
        data: { expires_at: expiresAt, policy_version: version },
      });
      return { id: existing.id, policyVersion: version };
    }
    const row = await tx.principal_role_grants.create({
      data: {
        orgId: 1,
        principal_type: principalType,
        principal_id: String(principalId),
        role_id: roleId,
        workspace_id: workspaceId,
        granted_by: actor && actor.type === "user" ? Number(actor.id) : null,
        expires_at: expiresAt,
        policy_version: version,
      },
    });
    return { id: row.id, policyVersion: version };
  });
}

/** Revoke a grant — same gateway, same transactional version bump. */
async function revokeGrant({ actor, principalType, principalId, roleId, workspaceId = null, db = prisma }) {
  return db.$transaction(async (tx) => {
    const version = await bumpVersion(tx, "grant", SCOPE_KEY(1), actor ? Number(actor.id) || null : null);
    const res = await tx.principal_role_grants.deleteMany({
      where: {
        orgId: 1, principal_type: principalType, principal_id: String(principalId),
        role_id: roleId, workspace_id: workspaceId,
      },
    });
    return { deleted: res.count, policyVersion: version };
  });
}

/** Set document visibility — T-3's documentFilter reads this as a hard override. */
async function setDocumentVisibility({ actor, documentId, hidden, reason = null, db = prisma }) {
  return db.$transaction(async (tx) => {
    const version = await bumpVersion(tx, "visibility", `document:${documentId}`, actor ? Number(actor.id) || null : null);
    const row = await tx.document_visibility.upsert({
      where: { document_id: documentId },
      create: {
        document_id: documentId, hidden,
        hidden_by: actor && actor.type === "user" ? Number(actor.id) : null,
        hidden_at: hidden ? new Date() : null,
        reason,
      },
      update: {
        hidden, hidden_at: hidden ? new Date() : null, reason,
      },
    });
    return { hidden: row.hidden, policyVersion: version };
  });
}

/** Monotonic clock head — T-3 caches stamp and compare against this. */
async function currentPolicyVersion(db = prisma) {
  const row = await db.policy_versions.findFirst({
    orderBy: { version: "desc" },
    select: { version: true },
  });
  return row?.version ?? 0n;
}

module.exports = {
  grantRole,
  revokeGrant,
  setDocumentVisibility,
  currentPolicyVersion,
};

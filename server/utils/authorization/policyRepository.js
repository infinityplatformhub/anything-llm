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

async function heldPermissionIds(tx, actor) {
  const grants = await tx.principal_role_grants.findMany({
    where: {
      orgId: actor.orgId ?? 1,
      principal_type: actor.type,
      principal_id: String(actor.id),
      OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
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
async function grantRole({ actor, principalType, principalId, roleId, workspaceId = null, expiresAt = null }) {
  return prisma.$transaction(async (tx) => {
    if (actor && actor.type !== "service") {
      const rolePerms = await permissionIdsForRole(tx, roleId);
      const held = await heldPermissionIds(tx, actor);
      const missing = [...rolePerms].filter((p) => !held.has(p));
      if (missing.length > 0) {
        throw new AuthorizationContractError(
          "grant refused: role carries permissions the granter does not hold"
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
async function revokeGrant({ actor, principalType, principalId, roleId, workspaceId = null }) {
  return prisma.$transaction(async (tx) => {
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
async function setDocumentVisibility({ actor, documentId, hidden, reason = null }) {
  return prisma.$transaction(async (tx) => {
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

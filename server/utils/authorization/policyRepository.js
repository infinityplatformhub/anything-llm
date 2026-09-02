// T-2 (#20): policyRepository — the SINGLE gateway for grant/ACL/visibility mutations
// (T-1 ledger commitment → T-2/T-3). Every write inserts a policy_versions row in the
// same transaction, so the T-3 cache can treat "a newer version exists" as staleness.
// No DB trigger: business logic in the DB is invisible to review/tests (ledger ruling).
//
// Also enforces grant-escalation rules the engine cannot see (S-5/S-6/S-9):
// a granter cannot hand out a role carrying permissions they do not themselves hold.

const crypto = require("crypto");
const prisma = require("../prisma");
const { publishOperationalEvent } = require("../events");
const { AuthorizationContractError } = require("./errors");
// Safe at module scope: `groupMembership` requires NOTHING (that is why #96 gave it
// its own file rather than putting it in `principals.js` — hotfix #39's cycle).
const { grantPrincipalPairs } = require("./groupMembership");

const SCOPE_KEY = (orgId) => `org:${orgId}`;

// Hotfix #39 (QA-2): callers that already hold a transaction pass it as `db` —
// a Prisma transaction client has no `$transaction`, so calling one on it would
// throw. Run inside theirs when there is one, open our own when there is not,
// so a grant and the membership it belongs to can commit or fail together.
const inTransaction = (db, fn) =>
  typeof db?.$transaction === "function" ? db.$transaction(fn) : fn(db);


// Only these two named built-in principals skip the escalation guard: the single-user
// deployment principal and the P0-6 job runtime, both seeded by migrations. Exempting
// every `type:"service"` actor would let a scoped API key (also a service actor) grant
// itself super_admin — the S-9 hole (security review, issue #20).
const EXEMPT_PRINCIPAL_IDS = new Set(["single-user", "core-jobs"]);
const isExemptPrincipal = (actor) =>
  actor.type === "service" && EXEMPT_PRINCIPAL_IDS.has(String(actor.id));

// Every gateway entry point demands an explicit actor — no default free pass.
const requireActor = (actor, fn) => {
  if (!actor) {
    throw new AuthorizationContractError(
      `${fn} requires an explicit actor — pass SERVICE_PRINCIPALS.singleUser/coreJobs for seed and migration writes`
    );
  }
};
const actorIdOf = (actor) => (actor && actor.type === "user" ? Number(actor.id) : null);

async function bumpVersion(tx, changeType, scopeKey, actorId, extraScopeKeys = []) {
  const row = await tx.policy_versions.create({
    data: { change_type: changeType, scope_key: scopeKey, actor_id: actorId ?? null },
    select: { version: true },
  });
  // Published INSIDE the transaction (outbox): a crash between commit and publish would
  // leave every cache stale forever with no event to correct it (T-3 recon §8).
  await publishOperationalEvent(
    {
      type: "policy.changed",
      actor: { type: "system", id: actorId ? String(actorId) : null, orgId: 1 },
      resource: { type: "policy", id: scopeKey },
      traceId: crypto.randomUUID(),
      data: {
        changeType,
        version: String(row.version),
        scopeKeys: [scopeKey, ...extraScopeKeys],
      },
    },
    tx
  );
  return row.version;
}

/** Permission ids for BASELINE_GRANTABLE, resolved against the seeded table. */
async function baselinePermissionIds(tx) {
  const rows = await tx.permissions.findMany({
    where: { action: { in: [...BASELINE_GRANTABLE] } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/**
 * Permissions carried by every role a GROUP holds, org-wide or workspace-scoped.
 *
 * TL-1 FINDING-3 (#113). Since #96 the engine expands `group_members` when it
 * evaluates grants, which made membership a GRANT PATH: adding a user to a group
 * hands them everything the group's roles carry, without `grantRole` ever running
 * and therefore without its set-containment check. An actor holding nothing but
 * `member` could add anyone — themselves included — to a group holding `super_admin`.
 *
 * Workspace-scoped grants are counted here WITHOUT filtering by workspace, and that
 * asymmetry is deliberate: membership is not written into a scope. One row in
 * `group_members` activates every grant the group holds in every workspace at once,
 * so the thing being delegated is the union, and the union is what must be contained.
 */
async function permissionIdsForGroup(tx, groupId) {
  const grants = await tx.principal_role_grants.findMany({
    where: {
      principal_type: "group",
      principal_id: String(groupId),
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
 * The escalation guard for membership writes — deliberately the SAME SHAPE as
 * `grantRole`'s, not a second rule worded differently. Two checks guarding one
 * capability drift, and the weaker one becomes the way in.
 *
 * Held permissions are read ORG-WIDE (`targetWorkspaceId: null`) for the reason
 * above: membership is unscoped, so a workspace-A admin must not be able to activate
 * a grant that reaches workspace B.
 *
 * Applied to REMOVAL as well as addition. Removal is not the harmless direction:
 * deciding who a group reaches IS the delegated authority, whichever way it moves —
 * pulling someone out of a group that denies them widens what they may do, exactly as
 * adding them to one that allows does. Guarding only `add` leaves the same hole with
 * the sign flipped.
 *
 * #128 closed the limit this used to carry: `heldPermissionIds` now expands the
 * actor's group memberships through the same helper the engine uses, so a delegated
 * admin who holds their role only through a group is no longer refused here. The two
 * had to land in this order — expanding groups there while membership writes were
 * unguarded completes a chain (add yourself to a group, inherit, satisfy this guard,
 * grant yourself directly), which is why #113 merged first.
 */
async function refuseGroupEscalation(tx, actor, groupId, fn) {
  if (isExemptPrincipal(actor)) return;
  const groupPerms = await permissionIdsForGroup(tx, groupId);

  // RF-9 (TL-1, QA-1): a group can carry authority WITHOUT holding a single role
  // grant. `document_acl` rows are keyed `{principal_type:"group", principal_id}` and
  // `documentFilter` reads them directly — they never pass through
  // `principal_role_grants`. So a group whose whole purpose is a document ACL has an
  // EMPTY permission set here, and the early return let any actor rewrite its
  // membership.
  //
  // ANY row keyed on this group counts, either effect. The reason is the same one
  // `permissionIdsForGroup` does not filter by workspace: a single `group_members`
  // row activates the group's ENTIRE ACL set at once, so what is being delegated is
  // that whole set. QA-1 measured the allow direction on `98b2627a1` — a group
  // holding an ALLOW row for `document.read`, and a `member` actor adding THEMSELVES
  // to it, which succeeded. Counting one effect would guard freeing a victim and miss
  // helping yourself.
  //
  // Containment on an empty set is not a safe default: the empty set is contained by
  // everyone, so "carries nothing" and "carries an ACL" reached the same answer while
  // meaning opposite things. The count is what separates them.
  const groupRow = await tx.groups.findUnique({
    where: { id: Number(groupId) },
    select: { orgId: true },
  });
  const aclCount = await tx.document_acl.count({
    where: {
      orgId: groupRow?.orgId ?? 1,
      principal_type: "group",
      principal_id: String(groupId),
    },
  });
  if (groupPerms.size === 0 && aclCount === 0) return; // Genuinely carries nothing.

  const held = await heldPermissionIds(tx, actor, null);
  const baselineIds = await baselinePermissionIds(tx);
  const missing = [...groupPerms].filter((p) => !held.has(p) && !baselineIds.has(p));
  if (missing.length > 0) {
    throw new AuthorizationContractError(
      `${fn} refused: the group carries permissions the actor does not hold org-wide`
    );
  }

  // The ACL half needs its own bar, because set containment cannot supply one: the
  // permissions above are EMPTY for an ACL-only group, and the empty set is contained
  // by everyone, so the check just passed for an actor holding nothing.
  //
  // `role.grant` is the bar (TL-1 ruling). Rewriting the membership of a group that
  // carries an ACL hands out that ACL, so this IS a grant, and `role.grant` is the
  // axis `grantRole` and `revokeGrant` already turn on — one permission governs
  // delegation rather than two that can drift apart.
  //
  // `document.share` was the first choice here and was WRONG in a way worth
  // recording: it is the permission for sharing a document you can already reach, not
  // for deciding who a group reaches. Measured on a freshly migrated database, it is
  // held by org `super_admin` and workspace `owner` — so the bar would have admitted
  // every workspace owner to rewrite any group's membership org-wide, which is the
  // scope leak the org-wide read of `heldPermissionIds` exists to prevent.
  if (aclCount > 0) {
    const grantPerm = await tx.permissions.findUnique({
      where: { action: "role.grant" },
      select: { id: true },
    });
    // Fail closed if the permission is missing: an unseeded row must not read as
    // "nothing to check", which is the shape of the hole this whole branch closes.
    if (!grantPerm || !held.has(grantPerm.id)) {
      throw new AuthorizationContractError(
        `${fn} refused: the group carries document ACL rows, so changing its ` +
          `membership hands those out — the actor does not hold role.grant org-wide`
      );
    }
  }
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
 *
 * #128: the principal filter comes from `grantPrincipalPairs`, the SAME helper the
 * engine and `readableScope` use. Since #96 the engine expands `group_members` when
 * it evaluates grants; this did not, so a delegated admin whose role reaches them
 * through a group was authorized by the engine to act and then refused here — by
 * `grantRole`, `canAssignLegacyRole` and `refuseGroupEscalation` alike. Fail-closed,
 * so nothing alarmed; still wrong, and the shape that gets "fixed" under pressure by
 * handing someone a direct grant they should not need.
 *
 * Sharing the helper rather than adding a second group query here is the point (#96
 * built it for exactly this): three expansions free to drift apart is the defect that
 * issue existed to remove, and a fourth private copy would reopen it.
 *
 * An api-key does NOT inherit its creator's groups, and that mirrors
 * `engine.js:189-196` deliberately. A key's authority is what its creator holds
 * DIRECTLY; inheriting their departments would widen the key whenever someone edits a
 * group, against grants the key's scope list was never reviewed for. `grantPrincipalOf`
 * returns the creator, who IS a user, so this has to be refused on purpose — the type
 * check does not catch it, and the two layers would otherwise answer differently about
 * who a key is.
 *
 * The scope clause applies to the group pairs too. Group grants can be
 * workspace-scoped, so dropping it for them would let a workspace-A admin who reaches
 * their role through a group mint roles in workspace B — the leak the clause exists
 * to prevent, reintroduced through the new pairs.
 */
async function heldPermissionIds(tx, actor, targetWorkspaceId) {
  const scope =
    targetWorkspaceId == null
      ? { workspace_id: null } // org-wide target: only org-wide grants count
      : { OR: [{ workspace_id: null }, { workspace_id: targetWorkspaceId }] };

  const orgId = actor.orgId ?? 1;
  const grantPrincipal =
    "grantPrincipal" in actor ? actor.grantPrincipal : actor;
  // A key whose creator has been deleted evaluates as nobody and holds nothing.
  if (!grantPrincipal) return new Set();
  const principalPairs =
    "grantPrincipal" in actor
      ? [
          {
            principal_type: grantPrincipal.type,
            principal_id: String(grantPrincipal.id),
          },
        ]
      : await grantPrincipalPairs(grantPrincipal, orgId, tx);

  const grants = await tx.principal_role_grants.findMany({
    where: {
      AND: [
        {
          orgId,
          OR: [{ expires_at: null }, { expires_at: { gt: new Date() } }],
        },
        { OR: principalPairs },
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
/**
 * #52 MAJOR-2: permissions every member of the org already holds, which the
 * escalation guard therefore does not treat as an escalation to hand over.
 *
 * `setup_admin` is deliberately content-free (T-1/T-6): it configures the
 * instance and reads nobody's chats. That made `role.grant` — which it does
 * hold — useless, because the ONLY org role it could grant is `member`, and
 * `member` carries `chat.send`, which `setup_admin` does not. A delegated admin
 * who may create users but could not give them the one capability that makes an
 * account usable is not a duty split, it is a broken role.
 *
 * Granting `chat.send` gives away nothing the granter has: every member holds
 * it already, so it confers no authority over anyone. The guard stays strict
 * for everything else — `setup_admin` still cannot mint a `content_moderator`
 * (which carries other people's chats and documents) or a `super_admin`.
 *
 * Kept as a constant rather than seeded onto `setup_admin`, so the role stays
 * content-free: this says what may be DELEGATED, not what the granter can DO.
 *
 * It applies to WORKSPACE-scoped roles too, and that is deliberate: `viewer`,
 * `editor` and `owner` all carry `chat.send`, so a workspace owner delegating
 * membership hits the same wall for the same reason. The exemption is a
 * property of the permission — everyone already holds it — not of the scope it
 * is being granted in.
 */
// #53 adds `org.member`: granting something every principal already holds
// confers nothing, which is the entire criterion for this set.
const BASELINE_GRANTABLE = new Set(["chat.send", "org.member"]);

async function grantRole({ actor, principalType, principalId, roleId, workspaceId = null, expiresAt = null, db = prisma }) {
  // A missing actor must never be a free pass: seeds and migrations pass an explicit
  // built-in principal (security review, issue #20).
  if (!actor) {
    throw new AuthorizationContractError(
      "grantRole requires an explicit actor — pass SERVICE_PRINCIPALS.singleUser/coreJobs for seed and migration writes"
    );
  }
  return inTransaction(db, async (tx) => {
    if (!isExemptPrincipal(actor)) {
      const rolePerms = await permissionIdsForRole(tx, roleId);
      const held = await heldPermissionIds(tx, actor, workspaceId);
      const baselineIds = await baselinePermissionIds(tx);
      const missing = [...rolePerms].filter(
        (p) => !held.has(p) && !baselineIds.has(p)
      );
      if (missing.length > 0) {
        throw new AuthorizationContractError(
          "grant refused: role carries permissions the granter does not hold in this scope"
        );
      }
    }
    const version = await bumpVersion(tx, "grant", SCOPE_KEY(1), actorIdOf(actor), workspaceId ? [`workspace:${workspaceId}`] : []);
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

/**
 * Revoke a grant — same gateway, same transactional version bump.
 *
 * T-7 (#31): revoking is a privileged act in its own right. `grantRole` has
 * carried an escalation guard since T-2, but revoke had only the actor
 * requirement — anyone who could reach the function could strip anyone's
 * access. It is fail-safe in direction (it removes access, never adds), which
 * is why it was not an escalation, but it is a denial of service against any
 * principal, and it left no trace of who did it.
 *
 * The revocation record is written in the SAME transaction as the delete: an
 * audit row that can be lost while the deletion commits is worse than none,
 * because it makes the log look complete when it is not.
 */
async function revokeGrant({ actor, principalType, principalId, roleId, workspaceId = null, reason = null, db = prisma }) {
  requireActor(actor, "revokeGrant");
  return inTransaction(db, async (tx) => {
    if (!isExemptPrincipal(actor)) {
      const held = await heldPermissionIds(tx, actor, workspaceId);
      const revokePermission = await tx.permissions.findUnique({
        where: { action: "role.revoke" },
        select: { id: true },
      });
      if (!revokePermission || !held.has(revokePermission.id)) {
        throw new AuthorizationContractError(
          "revoke refused: actor does not hold role.revoke in this scope"
        );
      }
    }

    const version = await bumpVersion(tx, "grant", SCOPE_KEY(1), actorIdOf(actor), workspaceId ? [`workspace:${workspaceId}`] : []);

    // Read before deleting: afterwards there is nothing left to describe, which
    // is the whole reason this cannot be a column on the grant.
    const doomed = await tx.principal_role_grants.findMany({
      where: {
        orgId: 1, principal_type: principalType, principal_id: String(principalId),
        role_id: roleId, workspace_id: workspaceId,
      },
      select: { id: true, role_id: true, workspace_id: true },
    });

    const res = await tx.principal_role_grants.deleteMany({
      where: {
        orgId: 1, principal_type: principalType, principal_id: String(principalId),
        role_id: roleId, workspace_id: workspaceId,
      },
    });

    if (doomed.length > 0) {
      const role = await tx.roles.findUnique({
        where: { id: roleId },
        select: { name: true },
      });
      await tx.grant_revocations.createMany({
        data: doomed.map((grant) => ({
          orgId: 1,
          principal_type: principalType,
          principal_id: String(principalId),
          role_id: grant.role_id,
          // The name at revocation time: roles may be renamed or deleted later,
          // and the auditor needs what was actually taken away.
          role_name: role?.name ?? `role:${roleId}`,
          workspace_id: grant.workspace_id,
          revoked_by_type: actor.type,
          revoked_by_id: String(actor.id),
          policy_version: version,
          reason,
        })),
      });
    }

    return { deleted: res.count, policyVersion: version };
  });
}

/** Set document visibility — T-3's documentFilter reads this as a hard override. */
async function setDocumentVisibility({ actor, documentId, hidden, reason = null, db = prisma }) {
  requireActor(actor, "setDocumentVisibility");
  return inTransaction(db, async (tx) => {
    const version = await bumpVersion(tx, "visibility", `document:${documentId}`, actorIdOf(actor), [SCOPE_KEY(1)]);
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

/**
 * Runtime document_acl writes go through the gateway too — T-1's migration wrote the
 * inherited rows directly, but nothing at runtime may bypass the version bump.
 */
async function grantDocumentAcl({ actor, documentId, principalType, principalId, action, effect = "allow", source = "manual", db = prisma }) {
  requireActor(actor, "grantDocumentAcl");
  return inTransaction(db, async (tx) => {
    const version = await bumpVersion(tx, "document_acl", `document:${documentId}`, actorIdOf(actor), [SCOPE_KEY(1)]);
    const row = await tx.document_acl.upsert({
      where: {
        document_id_principal_type_principal_id_action: {
          document_id: documentId, principal_type: principalType,
          principal_id: String(principalId), action,
        },
      },
      create: {
        orgId: 1, document_id: documentId, principal_type: principalType,
        principal_id: String(principalId), action, effect, source, policy_version: version,
      },
      update: { effect, source, policy_version: version },
    });
    return { id: row.id, policyVersion: version };
  });
}

async function revokeDocumentAcl({ actor, documentId, principalType, principalId, action, db = prisma }) {
  requireActor(actor, "revokeDocumentAcl");
  return inTransaction(db, async (tx) => {
    const version = await bumpVersion(tx, "document_acl", `document:${documentId}`, actorIdOf(actor), [SCOPE_KEY(1)]);
    const res = await tx.document_acl.deleteMany({
      where: {
        document_id: documentId, principal_type: principalType,
        principal_id: String(principalId), action,
      },
    });
    return { deleted: res.count, policyVersion: version };
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


/**
 * T-7 (#31): may `actor` assign the legacy role string `targetRole` to someone?
 *
 * This is the same question `grantRole`'s escalation guard already answers —
 * you may hand over only what you already hold — expressed for the legacy
 * `users.role` column, which R4 keeps frozen rather than dropped. The old
 * helper compared role strings in a fixed hierarchy (admin > manager >
 * default), which cannot express a delegated admin who may create members but
 * not other admins.
 */
async function canAssignLegacyRole({ actor, targetRole, db = prisma }) {
  if (!actor) return false;
  // Read-only, so it needs no transaction of its own — it runs inside the
  // caller's when there is one. (#39 adds inTransaction for the write paths.)
  const tx = db;
  {
    if (isExemptPrincipal(actor)) return true;
    const {
      ORG_ROLE_FOR_LEGACY,
    } = require("./legacyRoleGrants");
    const orgRoleName =
      ORG_ROLE_FOR_LEGACY[targetRole] ?? ORG_ROLE_FOR_LEGACY.default;
    const role = await tx.roles.findFirst({
      where: { name: orgRoleName, scope: "org" },
      select: { id: true },
    });
    if (!role) return false;
    const rolePerms = await permissionIdsForRole(tx, role.id);
    const held = await heldPermissionIds(tx, actor, null);
    return [...rolePerms].every((permission) => held.has(permission));
  }
}

/**
 * The workspaces a user is a member of — the extra scope keys a membership change
 * has to invalidate.
 *
 * A cache entry is keyed on the actor's workspaceIds and scoped to `org:<id>` plus
 * one `workspace:<id>` per workspace (cache.js `scopesFor`). Bumping only the org
 * key would still invalidate those entries, but a workspace-scoped consumer that
 * listens narrowly would miss it, so both are published — the same shape `grantRole`
 * uses for a workspace-scoped grant.
 */
async function workspaceScopeKeysFor(tx, userId, groupId) {
  const keys = new Set();

  // NIT-3 (TL-1): the org comes from the GROUP ROW, not from a hardcoded 1. The
  // group is what is being changed, so it is the only thing that knows which org
  // this write belongs to — and it decides BOTH halves: which grants count, and
  // which `org:` key the bump is published under. Splitting those (filtering on the
  // group's org while publishing `org:1`) would emit a key no cache entry in that
  // org carries, which is the exact defect the RF-5 scope test exists to catch.
  const group = await tx.groups.findUnique({
    where: { id: Number(groupId) },
    select: { orgId: true },
  });
  const orgId = group?.orgId ?? 1;

  // Workspaces the user is a direct member of.
  const memberships = await tx.workspace_users.findMany({
    where: { user_id: Number(userId) },
    select: { workspace_id: true },
  });
  for (const row of memberships) keys.add(`workspace:${row.workspace_id}`);

  // And the workspaces the GROUP's own grants name. This half is the point: a user
  // whose only path to a workspace is through the group has no `workspace_users`
  // row at all, so a membership-only lookup published `org:1` and nothing else.
  // Found by the RF-5 scope test, which asserted the emitted keys rather than
  // trusting that invalidation happened for some reason.
  //
  // Org-wide grants (workspace_id NULL) need no key of their own — the `org:` key is
  // already published and every cache entry carries it.
  const grants = await tx.principal_role_grants.findMany({
    where: {
      orgId,
      principal_type: "group",
      principal_id: String(groupId),
      workspace_id: { not: null },
    },
    select: { workspace_id: true },
  });
  for (const row of grants) keys.add(`workspace:${row.workspace_id}`);

  // Returned WITH the org rather than as bare keys: the caller publishes under
  // `SCOPE_KEY(orgId)`, and reading the org here but publishing `org:1` there would
  // reintroduce the mismatch this fix exists to remove.
  return { orgId, extra: [...keys] };
}

/**
 * Add a user to a group, and bump the policy version in the SAME transaction.
 *
 * S4a (#113), the residual #96 left behind. Group membership decides authorization
 * — since #96 the engine expands it, and documentFilter reads it on both halves —
 * but nothing about writing `group_members` advanced `policy_versions`. So a
 * membership change was invisible to every cached filter until its TTL expired.
 *
 * The direction that matters is REMOVAL: a user taken out of a group kept the
 * group's access for up to the cache TTL. That is the shape T-5's own comment calls
 * "not a caching artifact but the authorization failure the seam exists to
 * prevent", and offboarding (S12) will depend on it being immediate.
 *
 * Membership writes therefore live HERE rather than in a caller, for the same reason
 * grants do: a caller that forgets the bump produces a silent staleness bug, and
 * nothing about `prisma.group_members.create()` looks wrong.
 */
async function addGroupMember({ actor, groupId, userId, db = prisma }) {
  requireActor(actor, "addGroupMember");
  return inTransaction(db, async (tx) => {
    await refuseGroupEscalation(tx, actor, groupId, "addGroupMember");
    const { orgId, extra } = await workspaceScopeKeysFor(tx, userId, groupId);
    const version = await bumpVersion(
      tx,
      "group_membership",
      SCOPE_KEY(orgId),
      actorIdOf(actor),
      extra
    );
    await tx.group_members.upsert({
      where: { group_id_user_id: { group_id: Number(groupId), user_id: Number(userId) } },
      create: { group_id: Number(groupId), user_id: Number(userId) },
      update: {},
    });
    return { version };
  });
}

/**
 * Remove a user from a group, bumping the policy version in the same transaction.
 *
 * The scope keys are collected BEFORE the delete: `workspace_users` is not what is
 * being deleted here, so ordering does not strictly matter today — but reading them
 * first keeps this symmetric with any future membership model where the removal
 * itself changes what needs invalidating.
 */
async function removeGroupMember({ actor, groupId, userId, db = prisma }) {
  requireActor(actor, "removeGroupMember");
  return inTransaction(db, async (tx) => {
    await refuseGroupEscalation(tx, actor, groupId, "removeGroupMember");
    const { orgId, extra } = await workspaceScopeKeysFor(tx, userId, groupId);
    const version = await bumpVersion(
      tx,
      "group_membership",
      SCOPE_KEY(orgId),
      actorIdOf(actor),
      extra
    );
    // deleteMany, not delete: removing someone who is not a member is a no-op, not
    // an error. The version still bumps — a caller that asked for the removal is
    // entitled to know the cache reflects reality afterwards.
    await tx.group_members.deleteMany({
      where: { group_id: Number(groupId), user_id: Number(userId) },
    });
    return { version };
  });
}

/**
 * Remove every trace of a user's ACCESS: group memberships, role grants, document ACLs.
 *
 * Slice 1 (#136) revoked the user's KEYS and stopped their session. It deliberately
 * did not claim to revoke their access — the grants and ACLs stayed, safe only
 * because `actorResolver.keyGrantPrincipal` returns null for a suspended user before
 * any of them is read. That is one guard away from a residual, and it stops being
 * true the moment anything answers an ACL question without going through the
 * resolver. This is the slice that removes the rows.
 *
 * WHY EVERY WRITE GOES THROUGH A PRIMITIVE (TL-1, 6aabd6b7d). Not layering
 * tidiness — each primitive carries something a raw statement destroys:
 *
 *   removeGroupMember    `refuseGroupEscalation`, and scope keys derived from the
 *                        GROUP ROW's orgId. A raw `group_members.deleteMany` skips
 *                        both, so the removal succeeds and publishes either no
 *                        invalidation or one under the wrong `org:` key — and the
 *                        stale filter keeps serving.
 *   revokeGrant          reads the doomed rows BEFORE deleting so it can write
 *                        `grant_revocations` with the role name as it stood. A raw
 *                        delete destroys the only record the grant ever existed.
 *   revokeDocumentAcl    the version bump under `document:<id>`, which a bulk ACL
 *                        delete cannot express per document.
 *
 * WHY N VERSION ROWS, NOT ONE. Measured by TL-1: `inTransaction` INLINES when handed
 * a `tx`, so one outer transaction around three primitives still runs three
 * `bumpVersion` calls, and collapsing them would need `bumpVersion` exported —
 * barred. N is correct rather than tolerated: the intermediate versions are written
 * inside an uncommitted transaction, so no reader ever observes one (`cache.js`
 * compares `entry.policyVersion === head`, and `head` does not move for anyone else
 * until commit). After commit the head jumps to the last version and every stale
 * entry misses. What the transaction buys is ROLLBACK SCOPE — if the ACL removal
 * fails, the memberships and grants already removed come back — which is a different
 * property from a tidy row count, and the one worth having.
 *
 * WHY IT ENUMERATES FIRST. `removeGroupMember` bumps the version even when its
 * `deleteMany` matches nothing, by design: a caller that asked for a removal is
 * entitled to know the cache reflects reality. Correct for a direct caller, wrong
 * for a second offboard — calling the primitives blindly makes a re-run write one
 * `policy_versions` row per membership the user USED TO have, and every "the user
 * has no access afterwards" assertion stays green while it happens. Reading the rows
 * inside the transaction and driving the primitives from that list makes a second
 * offboard write nothing, with no change to the primitives.
 *
 * `document_acl.principal_id` is TEXT with no foreign key (schema.prisma), so
 * enumerating a user's ACL rows is a string match — the recycling surface #135
 * exists to close. Noted rather than fixed here: giving that column an FK is a
 * schema change and a different issue.
 *
 * @returns {Promise<{memberships: number, grants: number, acls: number}>} counts of
 *   rows actually removed — real counts from the enumeration, not derived totals, so
 *   a caller can tell a no-op re-run from a first offboard.
 */
async function offboardUser({ actor, userId, reason = null, db = prisma }) {
  requireActor(actor, "offboardUser");
  const principalId = String(Number(userId));

  return inTransaction(db, async (tx) => {
    // Enumerate everything BEFORE removing anything: the primitives are driven from
    // these lists, so a row that does not exist produces no call and therefore no
    // version bump.
    const memberships = await tx.group_members.findMany({
      where: { user_id: Number(userId) },
      select: { group_id: true },
    });
    const grants = await tx.principal_role_grants.findMany({
      where: { principal_type: "user", principal_id: principalId },
      select: { role_id: true, workspace_id: true },
    });
    const acls = await tx.document_acl.findMany({
      where: { principal_type: "user", principal_id: principalId },
      select: { document_id: true, action: true },
    });

    for (const { group_id } of memberships)
      await removeGroupMember({ actor, groupId: group_id, userId, db: tx });

    // One call per (role, workspace) pair: `revokeGrant` filters on both, so a
    // single call cannot stand in for two grants of different roles, and the
    // `grant_revocations` row it writes names the role that was actually taken.
    for (const { role_id, workspace_id } of grants)
      await revokeGrant({
        actor,
        principalType: "user",
        principalId,
        roleId: role_id,
        workspaceId: workspace_id,
        reason: reason ?? "user offboarded",
        db: tx,
      });

    for (const { document_id, action } of acls)
      await revokeDocumentAcl({
        actor,
        documentId: document_id,
        principalType: "user",
        principalId,
        action,
        db: tx,
      });

    return {
      memberships: memberships.length,
      grants: grants.length,
      acls: acls.length,
    };
  });
}

/**
 * #135: remove EVERY user-principal authorization row, once, with one version bump.
 *
 * For the `/system/enable-multi-user` rollback and nothing else. That path deletes
 * every user with `User.delete({})` because every user it deletes was created moments
 * earlier by the operation that just failed, so "remove every user-principal grant" is
 * exactly right there and is one statement.
 *
 * NOT a loop over `offboardUser`. Enumerating ids to offboard each adds a query per
 * user to a path that is already failing, and the intermediate bumps buy nothing when
 * every principal is going away regardless (TL-1, 5f051a2a8 ruling 4).
 *
 * The actor is a service principal because there is no human one: the rollback runs
 * inside a `catch`, and the operation that would have produced an actor is the
 * operation that failed. `requireActor` still applies — the caller names
 * `SERVICE_PRINCIPALS.coreJobs` rather than the function defaulting to anything.
 *
 * Group memberships are not touched here: `group_members.user_id` has a real foreign
 * key with `onDelete: Cascade`, so PostgreSQL removes them when the user rows go. The
 * two tables below are `principal_id` TEXT with no FK, which is the whole orphan
 * surface.
 *
 * @param {{actor: Object, db?: Object}} input
 * @returns {Promise<{grantsDeleted: number, aclsDeleted: number, policyVersion: bigint}>}
 */
async function truncateUserPrincipalAuthorization({ actor, db = prisma }) {
  requireActor(actor, "truncateUserPrincipalAuthorization");
  return inTransaction(db, async (tx) => {
    // ONE bump, before the deletes, under the org scope key: every cache entry in the
    // instance is affected because every user is.
    const version = await bumpVersion(
      tx,
      "grant",
      SCOPE_KEY(1),
      actorIdOf(actor),
      []
    );
    const grants = await tx.principal_role_grants.deleteMany({
      where: { principal_type: "user" },
    });
    const acls = await tx.document_acl.deleteMany({
      where: { principal_type: "user" },
    });
    return {
      grantsDeleted: grants.count,
      aclsDeleted: acls.count,
      policyVersion: version,
    };
  });
}

module.exports = {
  grantRole,
  canAssignLegacyRole,
  // Exported for issue 123: the capabilities endpoint has to make the same
  // exemption this module makes internally. A second copy of the rule is how the
  // two answers drift — the hazard the S-9 comment above describes for the
  // opposite direction.
  isExemptPrincipal,
  revokeGrant,
  grantDocumentAcl,
  revokeDocumentAcl,
  setDocumentVisibility,
  currentPolicyVersion,
  addGroupMember,
  removeGroupMember,
  offboardUser,
  truncateUserPrincipalAuthorization,
};

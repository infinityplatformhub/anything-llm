// T-4a (#25): keep `users.role` and the grant tables in step.
//
// T-1's migration backfilled grants for the users that EXISTED when it ran.
// Nothing granted anything at runtime, so before T-4a every user created
// afterwards had no grants — invisible while role strings still decided access,
// and a hard lockout the moment the engine became load-bearing. That is this
// task's hole to close, because this task is what made grants load-bearing.
//
// R4 keeps `users.role` frozen rather than dropped, so the two must agree until
// a later task removes the column. The mapping is the migration's, verbatim:
//   admin            -> super_admin (org)
//   manager, default -> member      (org)
// The `manager -> workspace owner` half is membership-driven and belongs to
// workspace_users, not here.

const prisma = require("../prisma");
const { grantRole, revokeGrant } = require("./policyRepository");
const { SERVICE_PRINCIPALS } = require("./actorResolver");

const ORG_ROLE_FOR_LEGACY = { admin: "super_admin", manager: "member", default: "member" };

async function orgRoleId(name, db) {
  const role = await db.roles.findFirst({
    where: { name, scope: "org" },
    select: { id: true },
  });
  return role?.id ?? null;
}

/**
 * Grant the org role matching a user's legacy role. Called on user creation and
 * whenever `role` changes.
 *
 * Failure is logged, not thrown: a user whose grant write fails is denied by the
 * engine (default-deny), which is the safe direction. Throwing here would fail
 * the surrounding create and leave a half-made user instead.
 *
 * @param {{id:number|string, role:string}} user
 * @param {{previousRole?: string|null, db?: Object}} options
 */
async function syncLegacyRoleGrant(user, { previousRole = null, db = prisma } = {}) {
  if (!user?.id) return;
  const desired = ORG_ROLE_FOR_LEGACY[user.role] ?? ORG_ROLE_FOR_LEGACY.default;
  const previous = previousRole ? ORG_ROLE_FOR_LEGACY[previousRole] : null;

  try {
    const desiredId = await orgRoleId(desired, db);
    if (!desiredId) return; // policy tables not migrated yet (fresh install mid-setup)

    // Drop the old grant FIRST: a demoted admin who keeps super_admin is the
    // failure that matters. Deny-wins does not help here — these are separate
    // allow grants, so a stale one keeps working.
    if (previous && previous !== desired) {
      const previousId = await orgRoleId(previous, db);
      if (previousId)
        await revokeGrant({
          actor: SERVICE_PRINCIPALS.singleUser,
          principalType: "user",
          principalId: String(user.id),
          roleId: previousId,
          db,
        });
    }

    await grantRole({
      actor: SERVICE_PRINCIPALS.singleUser,
      principalType: "user",
      principalId: String(user.id),
      roleId: desiredId,
      db,
    });
  } catch (error) {
    console.error(
      `[authorization] failed to sync legacy role grant for user ${user.id}:`,
      error.message
    );
  }
}

/**
 * Keep a workspace membership and its workspace-scoped grant in step.
 *
 * Membership is what grants access to a workspace now — the org-wide `member`
 * role deliberately no longer carries workspace actions (migration
 * 20260902044000). So adding someone to a workspace must grant, and removing
 * them must revoke, or the two drift and the engine answers from stale rows.
 *
 * @param {{userId:number|string, workspaceId:number, roleId?:number|null, actor?:Object, db?:Object}} input
 */
async function syncWorkspaceMembershipGrant({
  userId,
  workspaceId,
  roleId = null,
  actor = SERVICE_PRINCIPALS.coreJobs,
  db = prisma,
}) {
  if (!userId || !workspaceId) return;
  try {
    const resolvedRoleId =
      roleId ??
      (
        await db.roles.findFirst({
          where: { name: "editor", scope: "workspace" },
          select: { id: true },
        })
      )?.id;
    if (!resolvedRoleId) return;
    await grantRole({
      actor,
      principalType: "user",
      principalId: String(userId),
      roleId: resolvedRoleId,
      workspaceId,
      db,
    });
  } catch (error) {
    console.error(
      `[authorization] failed to grant workspace ${workspaceId} to user ${userId}:`,
      error.message
    );
  }
}

/**
 * Revoke every workspace-scoped grant a user holds on one workspace. Called when
 * membership is removed: leaving a workspace must take the access with it.
 */
async function revokeWorkspaceMembershipGrants({
  userId,
  workspaceId,
  actor = SERVICE_PRINCIPALS.coreJobs,
  db = prisma,
}) {
  if (!userId || !workspaceId) return;
  try {
    const roles = await db.roles.findMany({
      where: { scope: "workspace" },
      select: { id: true },
    });
    for (const role of roles) {
      await revokeGrant({
        actor,
        principalType: "user",
        principalId: String(userId),
        roleId: role.id,
        workspaceId,
        db,
      });
    }
  } catch (error) {
    console.error(
      `[authorization] failed to revoke workspace ${workspaceId} from user ${userId}:`,
      error.message
    );
  }
}

/**
 * Report users who can log in but can do nothing: no workspace membership and no
 * org role that grants anything without one.
 *
 * Migration 20260902044000 prints this once as a NOTICE, which nobody reads
 * again. The condition is not a one-off: it recurs whenever the last membership
 * is removed from a user, so it is checked at every boot. Logged, never thrown —
 * an instance with stranded users still has to start so an operator can fix it.
 */
async function reportUsersWithoutAccess(db = prisma) {
  try {
    const stranded = await db.$queryRaw`
      SELECT u."id", u."username"
      FROM "users" u
      WHERE NOT EXISTS (
        SELECT 1 FROM "workspace_users" wu WHERE wu."user_id" = u."id"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "principal_role_grants" g
        JOIN "roles" r ON r."id" = g."role_id"
        WHERE g."principal_type" = 'user'
          AND g."principal_id" = u."id"::text
          AND r."name" IN ('super_admin', 'setup_admin', 'content_moderator')
      )
      ORDER BY u."id"
      LIMIT 50
    `;
    if (stranded.length === 0) return [];
    console.warn(
      `[authorization] ${stranded.length} user(s) belong to no workspace and hold no org-level role — they can sign in but cannot reach anything: ` +
        stranded.map((u) => `${u.username} (#${u.id})`).join(", ")
    );
    return stranded;
  } catch (error) {
    console.error(
      "[authorization] could not check for users without access:",
      error.message
    );
    return [];
  }
}

module.exports = {
  syncLegacyRoleGrant,
  reportUsersWithoutAccess,
  syncWorkspaceMembershipGrant,
  revokeWorkspaceMembershipGrants,
  ORG_ROLE_FOR_LEGACY,
};

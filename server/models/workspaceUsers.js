const prisma = require("../utils/prisma");
const {
  syncWorkspaceMembershipGrant,
  revokeWorkspaceMembershipGrants,
} = require("../utils/authorization/legacyRoleGrants");

// T-4a (#25): membership IS workspace access now — the org-wide `member` role no
// longer carries workspace actions (migration 20260902044000). Every write here
// must move the grant with it, or the engine answers from rows that no longer
// describe reality: someone removed from a workspace would keep reading it.

const WorkspaceUser = {
  createMany: async function (userId, workspaceIds = []) {
    if (workspaceIds.length === 0) return;
    try {
      await prisma.$transaction(async (tx) => {
        for (const workspaceId of workspaceIds) {
          await tx.workspace_users.create({
            data: { user_id: userId, workspace_id: workspaceId },
          });
          await syncWorkspaceMembershipGrant({ userId, workspaceId, db: tx });
        }
      });
    } catch (error) {
      console.error(error.message);
    }
    return;
  },

  /**
   * Create many workspace users.
   * @param {Array<number>} userIds - An array of user IDs to create workspace users for.
   * @param {number} workspaceId - The ID of the workspace to create workspace users for.
   * @returns {Promise<void>} A promise that resolves when the workspace users are created.
   */
  createManyUsers: async function (userIds = [], workspaceId) {
    if (userIds.length === 0) return;
    try {
      await prisma.$transaction(async (tx) => {
        for (const userId of userIds) {
          await tx.workspace_users.create({
            data: {
              user_id: Number(userId),
              workspace_id: Number(workspaceId),
            },
          });
          await syncWorkspaceMembershipGrant({
            userId: Number(userId),
            workspaceId: Number(workspaceId),
            db: tx,
          });
        }
      });
    } catch (error) {
      console.error(error.message);
    }
    return;
  },

  create: async function (userId = 0, workspaceId = 0) {
    try {
      // Hotfix #39 (QA-2): membership and grant in ONE transaction. Written
      // separately, a failing grant left the membership row behind — the user
      // shows as a member of the workspace and gets 404 from every route in it,
      // silently, because the grant error was caught and logged. Membership IS
      // workspace access now, so half of it is worse than none.
      await prisma.$transaction(async (tx) => {
        await tx.workspace_users.create({
          data: { user_id: Number(userId), workspace_id: Number(workspaceId) },
        });
        await syncWorkspaceMembershipGrant({
          userId: Number(userId),
          workspaceId: Number(workspaceId),
          db: tx,
        });
      });
      return true;
    } catch (error) {
      console.error(
        "FAILED TO CREATE WORKSPACE_USER RELATIONSHIP.",
        error.message
      );
      return false;
    }
  },

  get: async function (clause = {}) {
    try {
      const result = await prisma.workspace_users.findFirst({ where: clause });
      return result || null;
    } catch (error) {
      console.error(error.message);
      return null;
    }
  },

  where: async function (clause = {}, limit = null) {
    try {
      const results = await prisma.workspace_users.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
      });
      return results;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  count: async function (clause = {}) {
    try {
      const count = await prisma.workspace_users.count({ where: clause });
      return count;
    } catch (error) {
      console.error(error.message);
      return 0;
    }
  },

  delete: async function (clause = {}) {
    try {
      // Read the rows BEFORE deleting: afterwards there is nothing left to say
      // whose grants to revoke.
      await prisma.$transaction(async (tx) => {
        // Read before deleting: afterwards there is nothing left to say whose
        // grants to revoke. Same transaction, so a failed revoke cannot leave
        // someone holding access to a workspace they were removed from.
        const doomed = await tx.workspace_users.findMany({ where: clause });
        await tx.workspace_users.deleteMany({ where: clause });
        for (const row of doomed)
          await revokeWorkspaceMembershipGrants({
            userId: row.user_id,
            workspaceId: row.workspace_id,
            db: tx,
          });
      });
    } catch (error) {
      console.error(error.message);
    }
    return;
  },
};

module.exports.WorkspaceUser = WorkspaceUser;

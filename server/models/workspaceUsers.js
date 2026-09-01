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
      await prisma.$transaction(
        workspaceIds.map((workspaceId) =>
          prisma.workspace_users.create({
            data: { user_id: userId, workspace_id: workspaceId },
          })
        )
      );
      for (const workspaceId of workspaceIds)
        await syncWorkspaceMembershipGrant({ userId, workspaceId });
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
      await prisma.$transaction(
        userIds.map((userId) =>
          prisma.workspace_users.create({
            data: {
              user_id: Number(userId),
              workspace_id: Number(workspaceId),
            },
          })
        )
      );
      for (const userId of userIds)
        await syncWorkspaceMembershipGrant({
          userId: Number(userId),
          workspaceId: Number(workspaceId),
        });
    } catch (error) {
      console.error(error.message);
    }
    return;
  },

  create: async function (userId = 0, workspaceId = 0) {
    try {
      await prisma.workspace_users.create({
        data: { user_id: Number(userId), workspace_id: Number(workspaceId) },
      });
      await syncWorkspaceMembershipGrant({
        userId: Number(userId),
        workspaceId: Number(workspaceId),
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
      const doomed = await prisma.workspace_users.findMany({ where: clause });
      await prisma.workspace_users.deleteMany({ where: clause });
      for (const row of doomed)
        await revokeWorkspaceMembershipGrants({
          userId: row.user_id,
          workspaceId: row.workspace_id,
        });
    } catch (error) {
      console.error(error.message);
    }
    return;
  },
};

module.exports.WorkspaceUser = WorkspaceUser;

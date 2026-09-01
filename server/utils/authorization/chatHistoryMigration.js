// T-7 (#31, D-1): retire DISABLE_VIEW_CHAT_HISTORY into a real permission.
//
// The env var was an instance-wide kill switch — set it and NOBODY could read
// other people's chats, whoever they were. That is a feature flag standing in
// for a permission: it cannot say "this moderator may, that admin may not".
//
// This CANNOT live in the migration SQL. The variable is in the Node process and
// Postgres cannot see it; `current_setting()` returns NULL regardless, so a SQL
// branch would silently take the "was not set" path forever. So the read happens
// here, at boot, once, guarded by a policy_versions marker so that a later
// restart cannot undo a grant an admin made deliberately afterwards.

const prisma = require("../prisma");

const MARKER = "chat_history_permission_migration";

/**
 * @returns {Promise<{applied: boolean, disabled: boolean|null}>}
 */
async function migrateChatHistoryPermission(db = prisma) {
  try {
    const already = await db.policy_versions.findFirst({
      where: { change_type: MARKER },
      select: { version: true },
    });
    if (already) return { applied: false, disabled: null };

    const wasDisabled = "DISABLE_VIEW_CHAT_HISTORY" in process.env;

    await db.$transaction(async (tx) => {
      if (wasDisabled) {
        // The operator plainly did not want chat history read. Withdraw the
        // permission from every role except super_admin, who can grant it back
        // deliberately — which is the whole point of making it a permission.
        const permission = await tx.permissions.findUnique({
          where: { action: "chat.read_others" },
          select: { id: true },
        });
        const superAdmin = await tx.roles.findFirst({
          where: { name: "super_admin", scope: "org" },
          select: { id: true },
        });
        if (permission) {
          await tx.role_permissions.deleteMany({
            where: {
              permission_id: permission.id,
              ...(superAdmin ? { role_id: { not: superAdmin.id } } : {}),
            },
          });
        }
      }
      // Marker and policy bump in the same transaction as the change, so a crash
      // cannot leave the permission withdrawn with no record that it happened.
      await tx.policy_versions.create({
        data: { change_type: MARKER, scope_key: "org:1" },
      });
    });

    console.log(
      wasDisabled
        ? "[authorization] DISABLE_VIEW_CHAT_HISTORY was set — chat.read_others now held only by super_admin; grant it explicitly to anyone who needs it"
        : "[authorization] DISABLE_VIEW_CHAT_HISTORY was not set — chat.read_others left as seeded"
    );
    return { applied: true, disabled: wasDisabled };
  } catch (error) {
    // Logged, never thrown: an instance must still boot so an operator can fix
    // it, and the marker is only written on success so the next boot retries.
    console.error(
      "[authorization] chat history permission migration failed:",
      error.message
    );
    return { applied: false, disabled: null };
  }
}

module.exports = { migrateChatHistoryPermission, MARKER };

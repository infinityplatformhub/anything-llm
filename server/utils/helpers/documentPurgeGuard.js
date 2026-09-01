const prisma = require("../prisma");

/**
 * PR-0c (issue #11, G11): `purgeDocument()` deletes a document from the ENTIRE
 * system — source file, vector cache, and every workspace embedding. The
 * remove-and-unembed route passed any caller-supplied path straight in, so a
 * manager of one workspace could purge documents belonging to workspaces they
 * are not a member of (cross-workspace IDOR).
 *
 * Rules:
 * - The document must actually be embedded in the addressed workspace.
 * - Admins (and single-user mode, where user is null) may purge regardless of
 *   other embeddings — system-wide document management is their job.
 * - Anyone else may only purge a document whose embeddings are confined to the
 *   addressed workspace.
 * @param {{workspace:{id:number}, user:{role:string}|null, documentLocation:string}} input
 * @returns {Promise<{allowed:boolean, reason:string}>}
 */
async function canPurgeDocumentFromWorkspace({
  workspace,
  user,
  documentLocation,
}) {
  const embeddedHere = await prisma.workspace_documents.findFirst({
    where: { docpath: documentLocation, workspaceId: workspace.id },
  });
  if (!embeddedHere)
    return {
      allowed: false,
      reason: "Document is not embedded in this workspace.",
    };

  if (!user || user.role === "admin") return { allowed: true, reason: null };

  // Membership check (QA-2 A1): Workspace.getWithUser bypasses for managers,
  // so a manager could reach this guard for a workspace they are not a member
  // of. Non-admins may only purge from workspaces they belong to.
  const membership = await prisma.workspace_users.findFirst({
    where: { user_id: user.id, workspace_id: workspace.id },
  });
  if (!membership)
    return {
      allowed: false,
      reason: "You are not a member of this workspace.",
    };

  const embeddings = await prisma.workspace_documents.findMany({
    where: { docpath: documentLocation },
    select: { workspaceId: true },
  });
  const otherWorkspaces = embeddings.filter(
    (row) => row.workspaceId !== workspace.id
  );
  if (otherWorkspaces.length > 0)
    return {
      allowed: false,
      reason:
        "Document is embedded in other workspaces and can only be removed system-wide by an admin.",
    };

  return { allowed: true, reason: null };
}

module.exports = { canPurgeDocumentFromWorkspace };

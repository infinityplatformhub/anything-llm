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
 * - Single-user mode (user is null) may purge regardless: one principal, no
 *   other workspace to protect.
 * - A caller holding `document.delete` org-wide may purge regardless — the
 *   system-wide document management the admin role used to stand for.
 * - Anyone else may only purge a document whose embeddings are confined to the
 *   addressed workspace. Cross-workspace purges need an org-wide grant, which
 *   T-4a's requirePermission has already checked before this runs.
 * @param {{workspace:{id:number}, user:{id:number}|null, documentLocation:string, orgWideDocumentDelete?:boolean}} input
 * @returns {Promise<{allowed:boolean, reason:string}>}
 */
async function canPurgeDocumentFromWorkspace({
  workspace,
  user,
  documentLocation,
  orgWideDocumentDelete = false,
}) {
  const embeddedHere = await prisma.workspace_documents.findFirst({
    where: { docpath: documentLocation, workspaceId: workspace.id },
  });
  if (!embeddedHere)
    return {
      allowed: false,
      reason: "Document is not embedded in this workspace.",
    };

  // T-4a (#25): the legacy admin-role shortcut is replaced by an explicit
  // capability the caller passes in. Whether someone may purge across workspaces
  // is an org-wide grant the engine evaluates at the route — not a string on the
  // user row, which is what made this a bypass. `!user` (single-user mode) still
  // passes: one principal, no other workspace to protect.
  if (!user || orgWideDocumentDelete) return { allowed: true, reason: null };

  // Membership check (QA-2 A1): non-members may only purge from workspaces they
  // belong to.
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

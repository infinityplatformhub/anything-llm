// T-4a (#25): resource resolvers for requirePermission.
//
// These live in one file, apart from the routes, so the rule that matters can be
// checked by reading a single page: a resource's workspaceId comes from the
// STORED ROW, never from the request body or a caller-supplied path (B-3, G11).
// Every resolver returns null when the row does not exist — requirePermission
// turns that into a 404 before any decision is made.

const prisma = require("../prisma");

const ORG_ID = 1;

/** The org itself — for actions with no narrower subject (user admin, settings). */
const orgResource = async () => ({
  type: "org",
  id: String(ORG_ID),
  orgId: ORG_ID,
  workspaceId: null,
});

/** Workspace addressed by :slug. */
const workspaceBySlug = async (request) => {
  const slug = String(request.params?.slug ?? "");
  if (!slug) return null;
  const workspace = await prisma.workspaces.findFirst({
    where: { slug },
    select: { id: true },
  });
  if (!workspace) return null;
  return {
    type: "workspace",
    id: String(workspace.id),
    orgId: ORG_ID,
    workspaceId: workspace.id,
  };
};

/** Workspace addressed by a numeric id parameter. */
const workspaceByIdParam = (param) => async (request) => {
  const id = Number(request.params?.[param]);
  if (!Number.isInteger(id)) return null;
  const workspace = await prisma.workspaces.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!workspace) return null;
  return {
    type: "workspace",
    id: String(workspace.id),
    orgId: ORG_ID,
    workspaceId: workspace.id,
  };
};

/**
 * A chat, scoped to the workspace that CONTAINS it. The legacy routes looked chats
 * up by (id, user_id) alone, so a user kept write access to their own chats after
 * losing access to the workspace holding them (S-3).
 */
const chatByIdParam = (param = "id") => async (request) => {
  const id = Number(request.params?.[param]);
  if (!Number.isInteger(id)) return null;
  const chat = await prisma.workspace_chats.findUnique({
    where: { id },
    select: { id: true, workspaceId: true },
  });
  if (!chat) return null;
  return {
    type: "chat",
    id: String(chat.id),
    orgId: ORG_ID,
    workspaceId: chat.workspaceId,
  };
};

/**
 * A document addressed by its docpath in the request body. The workspaceId comes
 * from the row found in the ADDRESSED workspace — never from the body — so a
 * caller cannot name a path belonging to a workspace they hold no grant on
 * (G11: remove-and-unembed purges system-wide).
 */
const documentInWorkspaceBySlug = async (request) => {
  const workspace = await workspaceBySlug(request);
  if (!workspace) return null;
  const docpath = request.body?.documentLocation;
  if (typeof docpath !== "string" || !docpath) return null;
  const document = await prisma.workspace_documents.findFirst({
    where: { docpath, workspaceId: workspace.workspaceId },
    select: { id: true, workspaceId: true },
  });
  if (!document) return null;
  return {
    type: "document",
    id: String(document.id),
    orgId: ORG_ID,
    workspaceId: document.workspaceId,
  };
};

module.exports = {
  orgResource,
  workspaceBySlug,
  workspaceByIdParam,
  chatByIdParam,
  documentInWorkspaceBySlug,
};

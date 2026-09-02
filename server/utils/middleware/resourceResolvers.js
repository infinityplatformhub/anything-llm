// T-4a (#25): resource resolvers for requirePermission.
//
// These live in one file, apart from the routes, so the rule that matters can be
// checked by reading a single page: a resource's workspaceId comes from the
// STORED ROW, never from the request body or a caller-supplied path (B-3, G11).
// Every resolver returns null when the row does not exist — requirePermission
// turns that into a 404 before any decision is made.

const prisma = require("../prisma");

const ORG_ID = 1;
const workspaceResolvers = new WeakSet();

const isWorkspaceResolver = (resolver) => workspaceResolvers.has(resolver);
const isOrgResolver = (resolver) => resolver === orgResource;

/** The org itself — for actions with no narrower subject (user admin, settings). */
const orgResource = async () => ({
  type: "org",
  id: String(ORG_ID),
  orgId: ORG_ID,
  workspaceId: null,
});

/** Workspace addressed by :slug. */
/** Workspace addressed by workspaceSlug in the request body. */
const workspaceByBodySlug = async (request) => {
  const slug = String(request.body?.workspaceSlug ?? "");
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
const workspaceByIdParam = (param) => {
  const resolve = async (request) => {
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
  resolve.resolverName = "workspaceByIdParam";
  workspaceResolvers.add(resolve);
  return resolve;
};

/**
 * A chat, scoped to the workspace that CONTAINS it. The legacy routes looked chats
 * up by (id, user_id) alone, so a user kept write access to their own chats after
 * losing access to the workspace holding them (S-3).
 */
const chatByIdParam = (param = "id") => {
  const resolve = async (request) => {
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
  resolve.resolverName = "chatByIdParam";
  workspaceResolvers.add(resolve);
  return resolve;
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

/** Prompt-history row addressed by :id; workspace scope comes from the stored row. */
const promptHistoryByIdParam = (param = "id") => {
  const resolve = async (request) => {
    const id = Number(request.params?.[param]);
    if (!Number.isInteger(id)) return null;
    const history = await prisma.prompt_history.findUnique({
      where: { id },
      select: { id: true, workspaceId: true },
    });
    if (!history) return null;
    return {
      type: "prompt_history",
      id: String(history.id),
      orgId: ORG_ID,
      workspaceId: history.workspaceId,
    };
  };
  resolve.resolverName = "promptHistoryByIdParam";
  workspaceResolvers.add(resolve);
  return resolve;
};

/** Memory addressed by :memoryId; workspace scope comes from the stored row. */
const memoryByIdParam = (param = "memoryId") => {
  const resolve = async (request) => {
    const id = Number(request.params?.[param]);
    if (!Number.isInteger(id)) return null;
    const memory = await prisma.memories.findUnique({
      where: { id },
      select: { id: true, workspaceId: true },
    });
    if (!memory) return null;
    return {
      type: "memory",
      id: String(memory.id),
      orgId: ORG_ID,
      workspaceId: memory.workspaceId,
    };
  };
  resolve.resolverName = "memoryByIdParam";
  workspaceResolvers.add(resolve);
  return resolve;
};

/** Document addressed by docPath in the body and constrained to the stored workspace. */
const watchedDocumentInWorkspaceBySlug = async (request) => {
  const workspace = await workspaceBySlug(request);
  if (!workspace) return null;
  const docpath = request.body?.docPath;
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

/**
 * The scope a grant is being written INTO — the org, or one workspace.
 *
 * `workspaceId` here is a caller-supplied parameter by necessity: it names the
 * scope of the grant, not the location of an existing row. B-3 still holds,
 * because the resolver looks the workspace UP and authorizes against the stored
 * row — a caller who names a workspace that does not exist gets a 404, and a
 * caller who names one they hold no `role.grant` in gets refused in that
 * workspace's scope rather than the org's.
 */
const grantScopeFromBody = async (request) => {
  const raw = request.body?.workspaceId ?? request.query?.workspaceId;
  if (raw === undefined || raw === null || raw === "") return orgResource();

  const id = Number(raw);
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

[
  workspaceBySlug,
  workspaceByBodySlug,
  documentInWorkspaceBySlug,
  watchedDocumentInWorkspaceBySlug,
].forEach((resolver) => workspaceResolvers.add(resolver));

module.exports = {
  orgResource,
  workspaceBySlug,
  workspaceByBodySlug,
  workspaceByIdParam,
  chatByIdParam,
  documentInWorkspaceBySlug,
  promptHistoryByIdParam,
  memoryByIdParam,
  watchedDocumentInWorkspaceBySlug,
  grantScopeFromBody,
  isWorkspaceResolver,
  isOrgResolver,
};

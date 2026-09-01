const { Workspace } = require("../../models/workspace");
const { WorkspaceThread } = require("../../models/workspaceThread");
const { userFromSession } = require("../http");

// T-4a (#25): these are LOADERS, not gates. They used to call
// `Workspace.getWithUser` in multi-user mode, which made membership the access
// decision — so after requirePermission authorized a caller holding an org-wide
// grant, this ran second and 404'd them anyway. Authorization happens once, in
// requirePermission; these only fetch the row it already authorized.
//
// Every route using them MUST be preceded by requirePermission. A route that
// loads a workspace without a gate in front is a bug, not a public route.

/** Loads response.locals.workspace for routes carrying :slug. */
async function validWorkspaceSlug(request, response, next) {
  const { slug } = request.params;
  const workspace = await Workspace.get({ slug });

  if (!workspace) {
    response.status(404).send("Workspace does not exist.");
    return;
  }

  response.locals.workspace = workspace;
  next();
}

/** Loads workspace + thread for routes carrying :slug and :threadSlug. */
async function validWorkspaceAndThreadSlug(request, response, next) {
  const { slug, threadSlug } = request.params;
  const user = await userFromSession(request, response);
  const workspace = await Workspace.get({ slug });

  if (!workspace) {
    response.status(404).send("Workspace does not exist.");
    return;
  }

  // Ownership still narrows threads: a thread belongs to the user who made it,
  // and being authorized for the workspace does not make someone else's thread
  // yours. This is a data filter, not the access decision.
  const thread = await WorkspaceThread.get({
    slug: threadSlug,
    user_id: user?.id || null,
    workspace_id: workspace.id,
  });
  if (!thread) {
    response.status(404).send("Workspace thread does not exist.");
    return;
  }

  response.locals.workspace = workspace;
  response.locals.thread = thread;
  next();
}

module.exports = {
  validWorkspaceSlug,
  validWorkspaceAndThreadSlug,
};

// T-4a (#25): deployment-shape guards, salvaged from the deleted
// multiUserProtected middleware.
//
// These are NOT authorization. They answer "is this instance running in
// multi-user or single-user mode", which some routes genuinely need — a route
// that only makes sense once teams exist, or one that only makes sense before
// they do. They are kept apart from the engine so that "which shape is this
// deployment" can never again be mistaken for "may this caller do this",
// which is exactly how flexUserRoleValid grew its bypass.
//
// Every route using these still needs requirePermission for the access decision.

const { SystemSettings } = require("../../models/systemSettings");

/** Refuses unless the instance is in multi-user mode. */
async function isMultiUserSetup(_request, response, next) {
  const multiUserMode = await SystemSettings.isMultiUserMode();
  if (!multiUserMode) {
    response.status(403).json({ error: "Invalid request" });
    return;
  }
  next();
}

/** Refuses unless the instance is in single-user mode. */
async function isSingleUserMode(_request, response, next) {
  const multiUserMode = await SystemSettings.isMultiUserMode();
  if (multiUserMode) return response.sendStatus(401).end();
  next();
}

module.exports = { isMultiUserSetup, isSingleUserMode };

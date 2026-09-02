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
const {
  isConfirmedSingleUser,
} = require("../authorization/actorResolver");

/** Refuses unless the instance is in multi-user mode. */
async function isMultiUserSetup(_request, response, next) {
  const multiUserMode = await SystemSettings.isMultiUserMode();
  if (!multiUserMode) {
    response.status(403).json({ error: "Invalid request" });
    return;
  }
  next();
}

/**
 * Refuses unless the instance is in single-user mode.
 *
 * issue 52 (QA-2): this used to read `SystemSettings.isMultiUserMode()` — the
 * raw setting — while `validatedRequest` decides the same question with
 * `isConfirmedSingleUser` (the setting AND zero user rows). In shape (b),
 * `multi_user_mode = false` with users present (a partial restore, a dropped
 * settings row, an instance mid-migration), the two disagreed: this middleware
 * said "single-user, let it through" while `validatedRequest` said "multi-user"
 * and accepted a session JWT. A route reachable only in single-user mode then
 * executed for an impersonated multi-user session — three of them with real
 * side effects.
 *
 * Both halves now ask the same helper, so the request cannot be in one mode for
 * the gate and the other for the session. Same failure class as QA-2's
 * FINDING-1: the danger is not which answer is right, it is two answers.
 */
async function isSingleUserMode(_request, response, next) {
  if (!(await isConfirmedSingleUser())) return response.sendStatus(401).end();
  next();
}

module.exports = { isMultiUserSetup, isSingleUserMode };

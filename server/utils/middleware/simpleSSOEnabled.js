const { SystemSettings } = require("../../models/systemSettings");

/**
 * Checks if simple SSO login is disabled by checking if the
 * SIMPLE_SSO_NO_LOGIN environment variable is set as well as
 * SIMPLE_SSO_ENABLED is set.
 *
 * This check should only be run when in multi-user mode when used.
 * @returns {boolean}
 */
function simpleSSOLoginDisabled() {
  return (
    "SIMPLE_SSO_ENABLED" in process.env && "SIMPLE_SSO_NO_LOGIN" in process.env
  );
}

/**
 * Middleware that checks if simple SSO login is disabled by checking if the
 * SIMPLE_SSO_NO_LOGIN environment variable is set as well as
 * SIMPLE_SSO_ENABLED is set.
 *
 * This middleware will 403 if SSO is enabled and no login is allowed and
 * the system is in multi-user mode. Otherwise, it will call next.
 *
 * @param {import("express").Request} request
 * @param {import("express").Response} response
 * @param {import("express").NextFunction} next
 * @returns {void}
 */
async function simpleSSOLoginDisabledMiddleware(_, response, next) {
  if (!("multiUserMode" in response.locals)) {
    const multiUserMode = await SystemSettings.isMultiUserMode();
    response.locals.multiUserMode = multiUserMode;
  }

  if (response.locals.multiUserMode && simpleSSOLoginDisabled()) {
    response.status(403).json({
      success: false,
      error: "Login via credentials has been disabled by the administrator.",
    });
    return;
  }
  next();
}

module.exports = {
  simpleSSOLoginDisabled,
  simpleSSOLoginDisabledMiddleware,
};

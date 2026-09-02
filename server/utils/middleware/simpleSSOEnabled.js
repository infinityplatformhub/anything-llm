const {
  isConfirmedSingleUser,
} = require("../authorization/actorResolver");

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
    // #58 rulings A/B, handed to #50 by #58's ledger: the raw setting and
    // `validatedRequest` disagree in shape (b) (multi_user_mode false WITH user
    // rows). Reading the raw setting here made this guard fail OPEN — it skipped
    // the NO_LOGIN block on an instance the session layer treats as multi-user,
    // leaving credential login available where the operator forbade it.
    // Inverted from the confirmed helper, so the local keeps its meaning.
    response.locals.multiUserMode = !(await isConfirmedSingleUser());
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

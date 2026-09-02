// issue 58 (ruling C): refuse to boot in shape (b).
//
// `multi_user_mode = false` WITH user rows is a state the code cannot produce
// deliberately: `enable-multi-user` writes the first user and the setting
// together (and rolls back if the settings write throws). It is reachable
// anyway — the process not surviving between those two writes (SIGKILL, OOM,
// container eviction), a `users` dump restored against a fresh
// `system_settings`, or a settings row deleted by hand.
//
// Every guard that asks "which mode is this" then disagrees with
// `validatedRequest`, which is issues 52 and 58 in one line. Rather than teach
// each site to survive the state, refuse to run in it.
//
// Refusing rather than repairing is deliberate. Flipping `multi_user_mode` to
// true on the operator's behalf would silently change what an instance IS —
// who can log in, and how — as a side effect of an upgrade. A startup error
// naming both fixes is louder and leaves the decision where it belongs.
//
// `/request-token` is the reason this is not a predicate change: its two
// branches authenticate against DIFFERENT credentials (a password against the
// `users` row, versus `process.env.AUTH_TOKEN`). Swapping the predicate would
// reroute authentication on a legacy instance rather than tighten it.

const prisma = require("../prisma");
const { SystemSettings } = require("../../models/systemSettings");

class DeploymentShapeError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeploymentShapeError";
  }
}

/**
 * @throws {DeploymentShapeError} when the instance is in shape (b)
 * @returns {Promise<void>}
 */
async function assertDeploymentShape({ db = prisma } = {}) {
  let multiUserMode;
  let userCount;
  try {
    multiUserMode = await SystemSettings.isMultiUserMode();
    userCount = await db.users.count();
  } catch (error) {
    // An unreadable database is a different failure, and not one this check is
    // entitled to turn into "your deployment is misconfigured". Let the boot
    // continue and fail where it actually fails.
    console.error(
      `[deployment-shape] could not read deployment shape: ${error.message}`
    );
    return;
  }

  if (multiUserMode || userCount === 0) return;

  throw new DeploymentShapeError(
    [
      "Refusing to boot: this instance has user accounts but multi-user mode is off.",
      "",
      `  users: ${userCount}`,
      "  multi_user_mode: false",
      "",
      "Authorization guards disagree in this state — some read the setting and",
      "treat the instance as single-user (skipping identity checks) while session",
      "validation treats it as multi-user. Fix it one of two ways:",
      "",
      "  1. If this instance IS multi-user (the usual case — an interrupted",
      "     upgrade, or a restore), set the setting to match:",
      "       UPDATE system_settings SET value = 'true' WHERE label = 'multi_user_mode';",
      "",
      "  2. If this instance should be single-user, remove the leftover accounts:",
      "       DELETE FROM users;",
      "",
      "Back up before either. See issue 58.",
    ].join("\n")
  );
}

module.exports = { assertDeploymentShape, DeploymentShapeError };

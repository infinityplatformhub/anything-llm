// issue 58 (ruling C, revised): repair shape (b) at boot, loudly.
//
// Shape (b) is `multi_user_mode = false` WITH user rows. The code cannot
// produce it deliberately — `enable-multi-user` writes the first user and the
// setting together, and rolls back if the settings write throws — but it is
// reachable: the process not surviving between those two commits (SIGKILL, OOM,
// container eviction), or a `users` dump restored against a fresh
// `system_settings`.
//
// In that state every guard asking "which mode is this" disagrees with
// `validatedRequest`, which is issues 52 and 58 in one line.
//
// REPAIR, not refuse. Refusing to boot turns a survivable inconsistency into an
// outage, and the instance it strands is one that just survived a crash or a
// restore — the worst moment to require a DBA. The repair is also not a guess:
// no code path creates a user row in genuine single-user mode, so user rows
// present means the instance IS multi-user and the setting is what is stale.
//
// It is deliberately loud. Silently rewriting a setting that decides who may
// log in is not something to do once and forget, so it logs at error level on
// EVERY boot until an operator sets MODE_REPAIR_ACKNOWLEDGED=1.

const prisma = require("../prisma");
const { SystemSettings } = require("../../models/systemSettings");

async function repairDeploymentShape({ db = prisma } = {}) {
  let multiUserMode;
  let userCount;
  try {
    multiUserMode = await SystemSettings.isMultiUserMode();
    userCount = await db.users.count();
  } catch (error) {
    // A database outage is a different failure, and this check is not entitled
    // to relabel it or to write to a database it cannot read.
    console.error(
      `[deployment-shape] could not read deployment shape: ${error.message}`
    );
    return { repaired: false, reason: "unreadable" };
  }

  if (multiUserMode || userCount === 0)
    return { repaired: false, reason: "consistent" };

  await SystemSettings._updateSettings({ multi_user_mode: true });

  if (process.env.MODE_REPAIR_ACKNOWLEDGED !== "1") {
    console.error(
      [
        "\x1b[31m[DEPLOYMENT SHAPE REPAIRED]\x1b[0m This instance had",
        `${userCount} user account(s) but multi_user_mode was false — a state`,
        "reachable from an interrupted upgrade or a partial restore. Left alone,",
        "authorization guards disagree: some treat the instance as single-user and",
        "skip identity checks while session validation treats it as multi-user.",
        "",
        "multi_user_mode has been set to true, which matches the accounts present.",
        "",
        "If that is WRONG — this instance should be single-user and those accounts",
        "are leftovers — stop the server, remove them, and set the flag back:",
        "  DELETE FROM users; UPDATE system_settings SET value = 'false'",
        "    WHERE label = 'multi_user_mode';",
        "",
        "Set MODE_REPAIR_ACKNOWLEDGED=1 to silence this message. See issue 58.",
      ].join(" ")
    );
  }

  return { repaired: true, userCount };
}

module.exports = { repairDeploymentShape };

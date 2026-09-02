const { User } = require("../../../models/user");
const {
  canAssignLegacyRole,
} = require("../../authorization/policyRepository");

// T-7 (#31): these used to compare `user.role` against a fixed hierarchy
// (admin > manager > default), which is the same class of bug T-4a removed from
// the routes: a role string standing in for a capability. It could not express
// a delegated admin who may create members but not other admins, and it read
// the CALLER's legacy role — the column R4 froze precisely because it is no
// longer the source of truth.
//
// The question "may I hand this role to someone" is the escalation guard the
// policy repository already answers for grants: you may give away only what you
// hold. These wrap that, for the legacy `users.role` column that R4 keeps until
// a later task drops it.

/**
 * May the actor assign the requested legacy role?
 * @param {Object} actor seam-02 Actor (response.locals.actor)
 * @param {Object} newUserParams may carry a `role`
 */
async function validRoleSelection(actor, newUserParams = {}) {
  if (!newUserParams.hasOwnProperty("role"))
    return { valid: true, error: null }; // not touching role, nothing to check
  const allowed = await canAssignLegacyRole({
    actor,
    targetRole: newUserParams.role,
  });
  return allowed
    ? { valid: true, error: null }
    : {
        valid: false,
        error: "You cannot grant a role carrying permissions you do not hold.",
      };
}

/**
 * May the actor modify this user at all?
 *
 * Modifying someone means being able to hand them their current role — you
 * cannot administer an account whose privileges exceed your own, because
 * changing it either way is a privilege decision.
 */
async function validCanModify(actor, existingUser) {
  const allowed = await canAssignLegacyRole({
    actor,
    targetRole: existingUser?.role,
  });
  return allowed
    ? { valid: true, error: null }
    : {
        valid: false,
        error: "Cannot perform that action on user.",
      };
}

/**
 * Refuse the update that would remove the last admin.
 *
 * Unchanged in substance: this is not an authorization question but a
 * lockout guard, and it still reads the legacy column because that column is
 * what the admin UI still writes.
 */
async function canModifyAdmin(userToModify, updates) {
  if (!updates.hasOwnProperty("role")) return { valid: true, error: null };
  if (userToModify.role !== "admin") return { valid: true, error: null };
  if (updates.role === userToModify.role) return { valid: true, error: null };

  const adminCount = await User.count({ role: "admin" });
  if (adminCount - 1 <= 0)
    return {
      valid: false,
      error: "No system admins will remain if you do this. Update failed.",
    };
  return { valid: true, error: null };
}

module.exports = {
  validCanModify,
  validRoleSelection,
  canModifyAdmin,
};

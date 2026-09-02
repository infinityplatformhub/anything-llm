/**
 * issue 123: which legacy roles an actor may hand out.
 *
 * `GET /system/my-capabilities` answers "what may this caller do" for the UI. Assigning
 * a role is the one question it could not answer, because the answer is a LIST rather
 * than a boolean: `canAssignLegacyRole` compares permission SETS — you may give away
 * only what you already hold — and "may create members but not other admins" is exactly
 * what a single flag cannot say.
 *
 * The three admin-UI call sites decide this in the browser today by comparing role
 * strings against a fixed hierarchy. That is the shape `utils/helpers/admin` removed
 * from the server for a stated reason, and it is wrong in both directions: it offers a
 * legacy manager options that 403 on click, and it cannot see a delegated admin at all.
 */
const {
  canAssignLegacyRole,
  isExemptPrincipal,
} = require("../authorization/policyRepository");

/**
 * The legacy roles the `users.role` column still accepts. Frozen and written out
 * because it is a closed vocabulary, not a derived one.
 */
const LEGACY_ROLES = Object.freeze(["admin", "manager", "default"]);

/**
 * @param {{actor: object|null, canManageUsers: boolean, db?: object}} params
 * @returns {Promise<string[]>}
 */
async function assignableRolesFor({ actor, canManageUsers, db }) {
  // A non-user principal is excluded HERE rather than by letting the permission lookup
  // come back empty. An empty result would be the right answer for the wrong reason:
  // it would start offering roles the moment key or service principals gained a grant,
  // and nothing would have decided that.
  //
  // The exemption is NOT a special case bolted on here: `canAssignLegacyRole` already
  // answers true for these principals, and excluding them by type would make this
  // function disagree with the very helper it delegates to. A single-user install runs
  // as `SINGLE_USER_ACTOR` — a service actor holding super_admin — so a bare type check
  // hands its only operator an empty dropdown while the same response reports
  // `user.manage: true`. Scoped API keys are service actors too and stay excluded,
  // which is why this tests membership of the exempt set rather than the type alone.
  if (!actor) return [];
  if (actor.type !== "user" && !isExemptPrincipal(actor)) return [];

  // The admin routes that consume this are gated on `user.manage`
  // (endpoints/admin.js), so a caller without it cannot assign anything regardless of
  // what the set comparison says. Without this the field would offer roles that 403 on
  // use — true as a statement about permissions, misleading as an affordance.
  //
  // This also covers an impersonated session without a branch of its own:
  // `user.manage` is not in READ_ACTIONS, so the engine denies it blanket for an
  // impersonated actor (utils/authorization/engine.js) and the boolean arrives false.
  if (!canManageUsers) return [];

  const allowed = await Promise.all(
    LEGACY_ROLES.map(async (role) => [
      role,
      // The same helper the write path calls (utils/helpers/admin validRoleSelection).
      // Re-deriving the rule here is how the affordance and the enforcement drift.
      await canAssignLegacyRole({ actor, targetRole: role, ...(db ? { db } : {}) }),
    ])
  );

  // `manager` and `default` cannot come back differently: ORG_ROLE_FOR_LEGACY maps both
  // to the `member` org role, so "do you hold everything it carries" is one question
  // for the two of them. That is a property of the legacy mapping, not of this
  // endpoint, and it is not this issue's to change.
  return allowed.filter(([, ok]) => ok).map(([role]) => role);
}

module.exports = { assignableRolesFor, LEGACY_ROLES };
